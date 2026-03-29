"""
Navvi Flow Recipes — self-improving learned workflows.

Flows are stored in SQLite and loaded as context for navvi_browse.
Confidence tiers control execution mode:
  0-2: recipe as guidance, still takes screenshots (guided)
  3-5: selector replay + URL checkpoints, visual fallback on miss (fast)
  6+:  selector replay, no screenshots unless failure (turbo)

Judge (Pass 2) runs via `claude -p` to verify playbooks against raw action logs.
"""

import json
import shutil
import subprocess
from typing import Optional
from urllib.parse import urlparse

from navvi.store import (
    get_flow,
    get_flows_for_domain,
    list_all_flows,
    save_flow,
    delete_flow,
    bump_flow_confidence,
    reset_flow_confidence,
    get_recent_actions,
)


def extract_domain(url: str) -> str:
    """Extract domain from a URL, stripping www. prefix."""
    try:
        parsed = urlparse(url if "://" in url else f"https://{url}")
        domain = parsed.hostname or ""
        if domain.startswith("www."):
            domain = domain[4:]
        return domain
    except Exception:
        return ""


def match_flows(url: str) -> list:
    """Find all stored flows matching a URL's domain."""
    domain = extract_domain(url)
    if not domain:
        return []
    return get_flows_for_domain(domain)


def build_recipe_context(flows: list) -> str:
    """Format matched flows as context for the navvi_browse agent loop.

    Returns a string injected into the browse analysis prompt so the
    vision model (or fast-path executor) knows what to expect.
    """
    if not flows:
        return ""

    lines = ["## Stored Flow Recipes for this domain", ""]
    for f in flows:
        conf_label = _confidence_label(f["confidence"])
        lines.append(f"### {f['domain']}/{f['action']} (confidence: {f['confidence']}, mode: {conf_label})")
        if f["description"]:
            lines.append(f"  {f['description']}")
        if f["caveats"]:
            lines.append("  Caveats:")
            for c in f["caveats"]:
                lines.append(f"    - {c}")
        if f["refs"]:
            lines.append(f"  References: {', '.join(f['refs'])}")
        if f["steps"]:
            lines.append("  Steps:")
            for i, step in enumerate(f["steps"], 1):
                action_type = step.get("action", "?")
                selector = step.get("selector", "")
                expected_url = step.get("expected_url", "")
                detail = step.get("detail", "")
                parts = [f"    {i}. {action_type}"]
                if selector:
                    parts.append(f"selector={selector}")
                if expected_url:
                    parts.append(f"expect_url={expected_url}")
                if detail:
                    parts.append(f"({detail})")
                lines.append(" ".join(parts))
        lines.append("")

    return "\n".join(lines)


async def execute_fast_path(recipe: dict, api_call, api_base: str) -> dict:
    """Execute a flow recipe via selector replay with URL checkpoints.

    Returns:
        {
            "success": bool,
            "steps_completed": int,
            "total_steps": int,
            "failed_at": int | None,  # step index where it failed (0-based)
            "reason": str,  # empty on success
        }
    """
    steps = recipe.get("steps", [])
    if not steps:
        return {"success": False, "steps_completed": 0, "total_steps": 0, "failed_at": None, "reason": "No steps in recipe"}

    import asyncio

    for i, step in enumerate(steps):
        action_type = step.get("action", "")
        selector = step.get("selector", "")
        expected_url = step.get("expected_url", "")
        value = step.get("value", "")
        key = step.get("key", "")

        try:
            if action_type == "navigate":
                nav_url = step.get("url", "")
                if nav_url:
                    await api_call("POST", "/navigate", {"url": nav_url}, api_base)
                    await asyncio.sleep(1)

            elif action_type == "click" and selector:
                resp = await api_call("POST", "/find", {"selector": selector}, api_base)
                if not resp.get("found"):
                    return {"success": False, "steps_completed": i, "total_steps": len(steps), "failed_at": i, "reason": f"Selector not found: {selector}"}
                await api_call("POST", "/click", {"x": resp["x"], "y": resp["y"]}, api_base)
                await asyncio.sleep(0.5)

            elif action_type == "fill" and selector:
                resp = await api_call("POST", "/find", {"selector": selector}, api_base)
                if not resp.get("found"):
                    return {"success": False, "steps_completed": i, "total_steps": len(steps), "failed_at": i, "reason": f"Selector not found: {selector}"}
                await api_call("POST", "/click", {"x": resp["x"], "y": resp["y"]}, api_base)
                await asyncio.sleep(0.1)
                if value:
                    await api_call("POST", "/type", {"text": value}, api_base)
                await asyncio.sleep(0.3)

            elif action_type == "press":
                await api_call("POST", "/key", {"key": key or "Return"}, api_base)
                await asyncio.sleep(0.5)

            elif action_type == "scroll":
                direction = step.get("direction", "down")
                amount = step.get("amount", 3)
                await api_call("POST", "/scroll", {"direction": direction, "amount": amount}, api_base)
                await asyncio.sleep(0.3)

            elif action_type == "autofill":
                entry = step.get("entry", "")
                if entry:
                    await api_call("POST", "/creds/autofill", {"entry": entry}, api_base)
                    await asyncio.sleep(0.5)

            # URL checkpoint — lightweight verification without screenshots
            if expected_url:
                try:
                    url_resp = await api_call("GET", "/url", api_base=api_base)
                    current_url = url_resp.get("url", "")
                    current_domain = extract_domain(current_url)
                    expected_domain = extract_domain(expected_url)
                    # Check domain match (not exact URL — pages may have dynamic paths)
                    if expected_domain and current_domain != expected_domain:
                        return {
                            "success": False,
                            "steps_completed": i + 1,
                            "total_steps": len(steps),
                            "failed_at": i,
                            "reason": f"URL mismatch: expected domain {expected_domain}, got {current_domain}",
                        }
                except Exception:
                    pass  # URL check is best-effort

        except Exception as e:
            return {"success": False, "steps_completed": i, "total_steps": len(steps), "failed_at": i, "reason": str(e)}

    return {"success": True, "steps_completed": len(steps), "total_steps": len(steps), "failed_at": None, "reason": ""}


def judge_flow(playbook: str, action_log: list) -> dict:
    """Pass 2 judge — compare agent playbook against raw action log via claude -p.

    Returns:
        {
            "save": bool,
            "name": str,        # suggested domain/action name
            "description": str,
            "steps": list,      # verified steps
            "caveats": list,
            "refs": list,       # referenced flows
        }
    """
    claude_path = shutil.which("claude")
    if not claude_path:
        # Fallback: trust the playbook as-is (no judge available)
        return _parse_playbook_fallback(playbook)

    log_text = json.dumps(action_log, indent=2)

    prompt = f"""You are a flow recipe judge. Compare a playbook summary against a raw action log and produce a verified recipe.

PLAYBOOK (written by the agent that executed the flow — may contain hallucinations):
{playbook}

RAW ACTION LOG (ground truth from the system):
{log_text}

Rules:
1. Only include steps that are backed by entries in the action log
2. Strip any claims not supported by the log (hallucinated steps, invented reasons for failures)
3. Keep caveats only if there's a corresponding failure/retry in the log
4. Extract selectors and expected URLs from the log entries
5. Determine if this flow is reusable (login, check email = yes; one-off debug session = no)

Respond with ONLY a JSON object:
{{
    "save": true/false,
    "name": "suggested-action-name",
    "description": "one-line description",
    "steps": [
        {{"action": "navigate|click|fill|press|scroll|autofill", "selector": "CSS selector if applicable", "expected_url": "URL after this step if meaningful", "detail": "brief note", "value": "text for fill actions", "key": "key for press actions", "url": "URL for navigate actions"}}
    ],
    "caveats": ["caveat1", "caveat2"],
    "refs": ["domain/action references to other flows"]
}}"""

    try:
        result = subprocess.run(
            [claude_path, "-p", prompt],
            capture_output=True,
            text=True,
            timeout=60,
        )
        output = result.stdout.strip()
        # Extract JSON from response (may have markdown fencing)
        if "```json" in output:
            output = output.split("```json")[1].split("```")[0].strip()
        elif "```" in output:
            output = output.split("```")[1].split("```")[0].strip()
        return json.loads(output)
    except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
        return _parse_playbook_fallback(playbook)


def _parse_playbook_fallback(playbook: str) -> dict:
    """Fallback when claude -p is unavailable — trust the playbook structure."""
    return {
        "save": True,
        "name": "unknown",
        "description": playbook[:200] if playbook else "",
        "steps": [],
        "caveats": [],
        "refs": [],
    }


def build_browse_footer(domain: str, flows_used: list, steps_completed: int = 0, total_steps: int = 0, fast_path: bool = False, confidence: int = 0) -> str:
    """Build the structured footer for navvi_browse responses."""
    if flows_used:
        flow = flows_used[0]
        mode = "turbo" if confidence >= 6 else ("fast path" if confidence >= 3 else "guided")
        return (
            f"\n\n📋 Flow: {flow['domain']}/{flow['action']} "
            f"(confidence {confidence}, {mode}, {steps_completed}/{total_steps} steps OK)"
        )
    else:
        return (
            f"\n\n📋 No stored flow for {domain}. "
            f"To save this as a reusable recipe:\n"
            f"1. Summarize the flow you just completed as a structured playbook\n"
            f"2. Call navvi_flow(action=\"save\", flow=\"{domain}/<action-name>\", "
            f"description=\"...\", steps=\"[...]\", caveats=\"[...]\", refs=\"[...]\")"
        )


def get_action_log_slice(persona: str, since_ts: float) -> list:
    """Get action log entries since a timestamp."""
    actions = get_recent_actions(persona, limit=100)
    return [a for a in actions if a["ts"] >= since_ts]


def _confidence_label(confidence: int) -> str:
    if confidence >= 6:
        return "turbo"
    elif confidence >= 3:
        return "fast"
    else:
        return "guided"

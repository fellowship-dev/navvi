"""Tiered vision analysis — Anthropic API -> claude CLI -> heuristics."""

import base64
import json
import os
import subprocess
import shutil
import tempfile

from navvi.patterns import classify_page


VISION_PROMPT = (
    "You are a browser page analyzer for an automation tool. "
    "Given a screenshot of a web page, analyze it and respond with a JSON object:\n"
    "{\n"
    '  "page_type": "login|signup|cookie_banner|captcha|search|results|content|error|unknown",\n'
    '  "description": "brief description of what\'s on the page",\n'
    '  "elements_of_interest": ["list of notable elements"],\n'
    '  "suggested_action": {\n'
    '    "type": "click|fill|press|dismiss|scroll|navigate|abort|done",\n'
    '    "target": "description of what to interact with",\n'
    '    "text": "text to type (fill actions only)",\n'
    '    "key": "key to press (press actions only, e.g. Enter, Tab, Escape)",\n'
    '    "url": "URL to navigate to (navigate actions only)",\n'
    '    "selector_hint": "CSS selector hint, if obvious"\n'
    "  },\n"
    '  "confidence": 0.0 to 1.0\n'
    "}\n"
    "IMPORTANT: For press actions, always set key to a valid key name (Enter, Tab, Escape, etc.) — never null.\n"
    "Respond with ONLY the JSON object, no explanation."
)


def _build_user_message(
    instruction: str, url: str, title: str, steps_history: list = None,
    viewport_info: dict = None,
) -> str:
    parts = []
    if instruction:
        parts.append("Goal: " + instruction)
    if url:
        parts.append("URL: " + url)
    if title:
        parts.append("Title: " + title)
    if steps_history:
        history_lines = []
        for s in steps_history[-3:]:
            history_lines.append(
                "  Step {}: {} -> {} (conf: {})".format(
                    s.get("step", "?"),
                    s.get("description", "?"),
                    s.get("action_taken", "?"),
                    s.get("confidence", "?"),
                )
            )
        parts.append("Previous steps (do NOT repeat failed/identical actions):\n" + "\n".join(history_lines))
    if viewport_info:
        vw = viewport_info.get("viewport_width", 0)
        vh = viewport_info.get("viewport_height", 0)
        if vw and vh:
            parts.append(
                "Viewport: {}x{}px. Elements with Y > {} are off-screen and need scrolling. "
                "Only suggest scroll if the target element is NOT visible in the screenshot.".format(vw, vh, vh)
            )
    parts.append("Analyze this page and suggest the next action to achieve the goal.")
    return "\n".join(parts)


def _parse_json_response(text: str) -> dict:
    """Extract a JSON object from a text response."""
    text = text.strip()
    # Try direct parse
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    # Try extracting from markdown code block
    for marker in ("```json", "```"):
        if marker in text:
            start = text.index(marker) + len(marker)
            end = text.index("```", start) if "```" in text[start:] else len(text)
            try:
                return json.loads(text[start:end].strip())
            except (json.JSONDecodeError, ValueError):
                pass
    # Try finding first { ... last }
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        try:
            return json.loads(text[first_brace:last_brace + 1])
        except (json.JSONDecodeError, ValueError):
            pass
    return {}


async def analyze(
    screenshot_b64: str,
    dom_elements: list,
    instruction: str,
    url: str = "",
    title: str = "",
    steps_history: list = None,
    viewport_info: dict = None,
) -> dict:
    """Analyze a browser screenshot and return structured classification.

    Tries tiers in order:
    1. Anthropic API (ANTHROPIC_API_KEY) — Haiku, ~1-2s, $0.002/shot
    2. claude -p CLI — subprocess, ~3-5s, uses CC subscription
    3. Heuristics from patterns.py — instant, free

    Returns:
        {
            "page_type": str,
            "description": str,
            "suggested_action": {"type": str, ...},
            "confidence": float,
            "tier_used": "api" | "cli" | "heuristics"
        }
    """
    # Tier 1: Anthropic API
    if os.environ.get("ANTHROPIC_API_KEY") and screenshot_b64:
        try:
            result = await _analyze_api(screenshot_b64, instruction, url, title, steps_history, viewport_info)
            if result and result.get("page_type"):
                result["tier_used"] = "api"
                return result
        except Exception:
            pass

    # Tier 2: claude CLI
    if shutil.which("claude") and screenshot_b64:
        try:
            result = await _analyze_cli(screenshot_b64, instruction, url, title, steps_history, viewport_info)
            if result and result.get("page_type"):
                result["tier_used"] = "cli"
                return result
        except Exception:
            pass

    # Tier 3: Heuristics
    return _analyze_heuristics(dom_elements, url, title)


async def _analyze_api(
    screenshot_b64: str, instruction: str, url: str, title: str,
    steps_history: list = None, viewport_info: dict = None,
) -> dict:
    """Tier 1: Direct Anthropic API call with Haiku."""
    try:
        import anthropic
    except ImportError:
        return {}

    client = anthropic.Anthropic()
    user_text = _build_user_message(instruction, url, title, steps_history, viewport_info)

    message = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system=VISION_PROMPT,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": screenshot_b64,
                        },
                    },
                    {"type": "text", "text": user_text},
                ],
            }
        ],
    )

    text = message.content[0].text if message.content else ""
    result = _parse_json_response(text)
    return result


async def _analyze_cli(
    screenshot_b64: str, instruction: str, url: str, title: str,
    steps_history: list = None, viewport_info: dict = None,
) -> dict:
    """Tier 2: Shell out to claude -p with the screenshot file."""
    # Save screenshot to temp file
    tmp_path = os.path.join(tempfile.gettempdir(), ".navvi-vision-tmp.png")
    try:
        with open(tmp_path, "wb") as f:
            f.write(base64.b64decode(screenshot_b64))

        user_text = _build_user_message(instruction, url, title, steps_history, viewport_info)
        prompt = (
            VISION_PROMPT + "\n\n"
            + user_text + "\n\n"
            + "The screenshot is at: " + tmp_path + "\n"
            + "Use the Read tool to view it, then respond with the JSON analysis."
        )

        # Strip env vars to avoid nested session deadlock
        env = {
            k: v
            for k, v in os.environ.items()
            if k not in ("CLAUDECODE", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_ENTRYPOINT")
        }

        result = subprocess.run(
            ["claude", "-p", prompt, "--allowedTools", "Read"],
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )

        if result.returncode == 0 and result.stdout:
            parsed = _parse_json_response(result.stdout)
            return parsed
    except subprocess.TimeoutExpired:
        pass
    except Exception:
        pass
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    return {}


def _analyze_heuristics(dom_elements: list, url: str, title: str) -> dict:
    """Tier 3: Pure heuristic classification."""
    result = classify_page(dom_elements, url, title)
    # Reshape to match the expected output format
    return {
        "page_type": result.get("page_type", "unknown"),
        "description": "Heuristic classification based on DOM elements",
        "suggested_action": result.get("suggested_action", {"type": "none"}),
        "confidence": result.get("confidence", 0.1),
        "tier_used": "heuristics",
    }

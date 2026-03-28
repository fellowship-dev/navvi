#!/usr/bin/env python3
"""
Navvi MCP Server v3.3.0 — persistent browser personas via Docker containers.

Lifecycle:
  navvi_start (local|remote), navvi_stop, navvi_status, navvi_list

Browser control (xdotool + Marionette via navvi-server.py):
  navvi_open, navvi_click, navvi_fill, navvi_press,
  navvi_drag, navvi_mousedown, navvi_mouseup, navvi_mousemove,
  navvi_scroll, navvi_screenshot, navvi_url, navvi_vnc

Element discovery:
  navvi_find

Credentials:
  navvi_creds

Video recording:
  navvi_record_start, navvi_record_stop, navvi_record_gif

Journey tools:
  navvi_browse, navvi_login

Speaks MCP stdio protocol via FastMCP.
"""

import asyncio
import base64
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Optional

import httpx
from fastmcp import FastMCP, Context

from navvi.store import (
    create_persona,
    get_persona,
    update_persona,
    delete_persona,
    list_personas,
    touch_persona,
    add_account,
    list_accounts,
    update_account,
    delete_account,
    log_persona_action,
    persona_state_summary,
    personas_list_summary,
    ensure_default,
)

# --- Constants ---

PACKAGE_DIR = os.environ.get("NAVVI_PACKAGE_DIR") or str(Path(__file__).resolve().parent.parent)
REPO = os.environ.get("NAVVI_REPO") or "fellowship-dev/navvi"
MACHINE_TYPE = os.environ.get("NAVVI_MACHINE") or "basicLinux32gb"
NAVVI_PORT = int(os.environ.get("NAVVI_PORT") or 8024)
VNC_PORT = int(os.environ.get("NAVVI_VNC_PORT") or 6080)
DOCKER_IMAGE = os.environ.get("NAVVI_IMAGE") or "ghcr.io/fellowship-dev/navvi:latest"
CONTAINER_PREFIX = os.environ.get("NAVVI_CONTAINER_PREFIX") or "navvi-"

PIDFILE_FWD = os.path.join(tempfile.gettempdir(), ".navvi-port-forward.pid")
PIDFILE_RECORD = os.path.join(tempfile.gettempdir(), ".navvi-ffmpeg.pid")
STATEFILE = os.path.join(tempfile.gettempdir(), ".navvi-mode")
RECORDINGS_DIR = os.path.join(tempfile.gettempdir(), "navvi-recordings")
ACTION_LOG = os.path.join(tempfile.gettempdir(), ".navvi-actions.jsonl")
RECORDING_STATE_FILE = os.path.join(tempfile.gettempdir(), ".navvi-recording.json")

# --- Global state ---

navvi_api = f"http://127.0.0.1:{NAVVI_PORT}"
active_persona: Optional[str] = None

# --- FastMCP app ---

mcp = FastMCP(
    "navvi",
    version="3.11.0",
)

# Ensure default persona exists on startup
ensure_default()

# Recording tools hidden by default (rarely needed).
# Atomic tools are always visible — Claude Code doesn't support dynamic
# tool registration mid-session, so hide/reveal via navvi_atomic is broken.
mcp.disable(tags={"recording"})


# --- MCP Resources ---


@mcp.resource("persona://{name}/state")
def persona_state_resource(name: str) -> str:
    """Current persona state — config, accounts, recent actions."""
    return persona_state_summary(name)


@mcp.resource("persona://{name}/accounts")
def persona_accounts_resource(name: str) -> str:
    """All accounts registered for this persona."""
    accounts = list_accounts(name)
    if not accounts:
        return f"No accounts for persona '{name}'."
    lines = []
    for a in accounts:
        lines.append(f"- [{a['id']}] {a['service']}: {a['email']} (status: {a['status']}, creds: {a['creds_ref'] or 'none'})")
    return "\n".join(lines)


@mcp.resource("personas://list")
def personas_list_resource() -> str:
    """All personas with account counts and last-used dates."""
    return personas_list_summary()


@mcp.resource("audit://{name}/log")
def audit_log_resource(name: str) -> str:
    """Recent action log for a persona (last 20 events)."""
    from navvi.store import get_recent_actions, _format_ts
    actions = get_recent_actions(name, limit=20)
    if not actions:
        return f"No actions recorded for persona '{name}'."
    lines = []
    for a in actions:
        lines.append(f"{_format_ts(a['ts'])} — {a['action']}: {a['detail']}")
    return "\n".join(lines)


# --- MCP Prompts ---


@mcp.prompt()
def signup_flow(service: str, persona: str = "default") -> str:
    """Create a new account on a service using a Navvi persona.

    Structured workflow: check existing accounts, navigate to signup page,
    fill forms, store credentials in gopass, log the new account."""
    return (
        f"Create a new account on {service} using the '{persona}' persona.\n\n"
        f"Steps:\n"
        f"1. Read persona://{persona}/state to check if an account already exists on {service}\n"
        f"2. If account exists, skip — report it and stop\n"
        f"3. Generate credentials: navvi_creds(action='generate', entry='navvi/{persona}/{service}', username='<chosen_username>')\n"
        f"   Password is created inside the container and NEVER appears in your context.\n"
        f"4. Navigate to {service} signup page\n"
        f"5. Fill the signup form: navvi_creds(action='autofill', entry='navvi/{persona}/{service}')\n"
        f"   If autofill fails (non-standard form), use navvi_find + navvi_fill for username only.\n"
        f"   For the password, use autofill or escalate to VNC — never type it manually.\n"
        f"6. Take a screenshot to verify the form is filled correctly\n"
        f"7. Submit the form (click submit button or press Enter)\n"
        f"8. If you hit a reCAPTCHA, try clicking the checkbox (iframe[title*=reCAPTCHA]) up to 3 times.\n"
        f"   If an image challenge appears or 3 attempts fail, call navvi_vnc for human help.\n"
        f"9. Take a screenshot to verify account creation succeeded\n"
        f"10. Register the account: navvi_account(action='add', persona='{persona}', service='{service}', creds_ref='gopass://navvi/{persona}/{service}')\n"
    )


@mcp.prompt()
def login_flow(service: str, persona: str = "default") -> str:
    """Log into a service using stored credentials for a Navvi persona.

    Reads credentials from persona state and gopass, navigates to login page,
    fills form, verifies successful login."""
    return (
        f"Log into {service} using the '{persona}' persona.\n\n"
        f"Steps:\n"
        f"1. Read persona://{persona}/accounts to find credentials for {service}\n"
        f"2. Navigate to {service} login page\n"
        f"3. Use navvi_creds action=autofill to fill the login form (password stays in gopass, never exposed)\n"
        f"4. Press Enter or click the submit button\n"
        f"5. Take a screenshot to verify login success\n"
        f"6. If you hit a reCAPTCHA, try clicking the checkbox (iframe[title*=reCAPTCHA]) up to 3 times.\n"
        f"   If an image challenge appears or 3 attempts fail, call navvi_vnc for human help.\n"
        f"7. If 2FA is required, call navvi_vnc and ask the user to complete it\n"
    )


@mcp.prompt()
def qa_walk(url: str, persona: str = "default") -> str:
    """Walk a web page or flow for QA — screenshot each step, report findings.

    Navigate to URL, explore the page, take screenshots, and produce a
    friction report with improvement suggestions."""
    return (
        f"QA walk of {url} using the '{persona}' persona.\n\n"
        f"Steps:\n"
        f"1. Start navvi if not running: navvi_start(persona='{persona}')\n"
        f"2. Navigate to {url}\n"
        f"3. Take a screenshot of the initial page state\n"
        f"4. Identify all interactive elements using navvi_find\n"
        f"5. Walk through the main user flow — click buttons, fill forms, navigate links\n"
        f"6. Screenshot each step\n"
        f"7. Note any issues: broken elements, confusing UX, missing labels, slow loads\n"
        f"8. Produce a friction report with screenshots and suggestions\n"
    )


# --- Helpers ---


def log_action(action: str, detail):
    """Log an action timestamp during recording (for smart trim)."""
    try:
        with open(RECORDING_STATE_FILE, "r") as f:
            state = json.load(f)
        if not state.get("active"):
            return
    except Exception:
        return
    entry = json.dumps({"ts": int(time.time() * 1000), "action": action, "detail": detail})
    with open(ACTION_LOG, "a") as f:
        f.write(entry + "\n")


def sh(cmd: str, timeout: int = 60) -> str:
    """Run a shell command and return stdout (or stderr on failure)."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        return "(command timed out)"
    except Exception as e:
        return str(e)


def sh_check(cmd: str, timeout: int = 60) -> str:
    """Run a shell command, return stdout. On failure return stderr or message."""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0:
            return result.stderr.strip() if result.stderr else f"exit code {result.returncode}"
        return result.stdout.strip()
    except subprocess.TimeoutExpired:
        return "(command timed out)"
    except Exception as e:
        return str(e)


def which(binary: str) -> Optional[str]:
    """Find a binary on PATH."""
    return shutil.which(binary)


def gh_sh(cmd: str) -> str:
    """Run a gh CLI command with CODESPACE_TOKEN as GH_TOKEN."""
    token = os.environ.get("CODESPACE_TOKEN")
    if not token:
        return sh(cmd)
    try:
        env = {**os.environ, "GH_TOKEN": token}
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=60, env=env
        )
        return result.stdout.strip() if result.returncode == 0 else (result.stderr.strip() or result.stdout.strip())
    except Exception as e:
        return str(e)


def kill_pidfile(pidfile: str):
    """Kill process from pidfile, then remove it."""
    if not os.path.exists(pidfile):
        return
    try:
        with open(pidfile) as f:
            pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
    except Exception:
        pass
    try:
        os.unlink(pidfile)
    except Exception:
        pass


def get_mode() -> Optional[str]:
    try:
        with open(STATEFILE) as f:
            return f.read().strip()
    except Exception:
        return None


def set_mode(mode: str):
    with open(STATEFILE, "w") as f:
        f.write(mode)


def clear_mode():
    try:
        os.unlink(STATEFILE)
    except Exception:
        pass


def container_name(persona: str) -> str:
    return f"{CONTAINER_PREFIX}{persona}"


def get_container_ports(persona: str) -> dict:
    """Get assigned ports for a persona based on docker inspect."""
    try:
        name = container_name(persona)
        info = sh(f"docker inspect --format '{{{{json .NetworkSettings.Ports}}}}' {name} 2>/dev/null")
        ports = json.loads(info)
        api_port = int(ports.get("8024/tcp", [{}])[0].get("HostPort", NAVVI_PORT))
        vnc_port = int(ports.get("6080/tcp", [{}])[0].get("HostPort", VNC_PORT))
        return {"api": api_port, "vnc": vnc_port}
    except Exception:
        return {"api": NAVVI_PORT, "vnc": VNC_PORT}


def read_persona_yaml(persona: str) -> dict:
    """Read persona YAML file (simple line parser, no deps)."""
    dirs = [
        os.path.join(os.getcwd(), "personas"),
        os.path.join(os.getcwd(), ".navvi", "personas"),
        os.path.join(Path.home(), ".navvi", "personas"),
        os.path.join(PACKAGE_DIR, "personas"),
    ]
    for d in dirs:
        for ext in (".yaml", ".yml"):
            filepath = os.path.join(d, persona + ext)
            try:
                with open(filepath) as f:
                    text = f.read()
                result = {}
                for line in text.split("\n"):
                    m = re.match(r"^\s{0,2}(\w+):\s*(.+)", line)
                    if m:
                        result[m.group(1)] = m.group(2).strip()
                return result
            except Exception:
                pass
    return {}


async def api_call(method: str, api_path: str, body: Optional[dict] = None, api_base: Optional[str] = None) -> dict:
    """HTTP call to navvi-server.py API."""
    base = api_base or navvi_api
    url = f"{base}{api_path}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        if method.upper() == "GET":
            resp = await client.get(url)
        else:
            resp = await client.post(url, json=body)
        if resp.status_code >= 400:
            detail = ""
            try:
                data = resp.json()
                detail = data.get("detail") or data.get("error") or resp.text
            except Exception:
                detail = resp.text
            raise RuntimeError(f"API {method} {api_path} failed ({resp.status_code}): {detail}")
        return resp.json()


def is_api_reachable(port: Optional[int] = None) -> bool:
    """Check if navvi-server is reachable."""
    p = port or NAVVI_PORT
    try:
        result = sh(f"curl -sf -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{p}/health 2>/dev/null")
        return result == "200"
    except Exception:
        return False


def list_containers() -> list:
    """List running navvi containers."""
    try:
        output = sh(f'docker ps --filter "name={CONTAINER_PREFIX}" --format \'{{{{json .}}}}\' 2>/dev/null')
        if not output:
            return []
        results = []
        for line in output.split("\n"):
            if not line.strip():
                continue
            c = json.loads(line)
            results.append({
                "name": c["Names"].replace(CONTAINER_PREFIX, ""),
                "id": c["ID"],
                "state": c["State"],
                "ports": c["Ports"],
                "image": c["Image"],
            })
        return results
    except Exception:
        return []


def check_local_deps() -> list:
    missing = []
    if not which("docker"):
        missing.append({"name": "Docker", "install": ["brew install --cask docker"]})
    return missing


def check_remote_deps() -> list:
    missing = []
    if not which("gh"):
        missing.append({"name": "GitHub CLI (gh)", "install": ["brew install gh"]})
    return missing


def detect_environment() -> str:
    """Detect current environment for credential namespacing.

    Returns 'docker:<image-id>', 'codespace:<name>', or 'local'.
    """
    cs_name = os.environ.get("CODESPACE_NAME")
    if cs_name:
        return "codespace:{}".format(cs_name)
    try:
        image_id = sh("docker inspect navvi-default --format '{{.Image}}' 2>/dev/null")
        if image_id and image_id.startswith("sha256:"):
            return "docker:{}".format(image_id[7:19])
        elif image_id:
            return "docker:{}".format(image_id[:12])
    except Exception:
        pass
    return "local"


def prefix_creds_ref(gopass_path: str) -> str:
    """Add environment prefix to a gopass path.

    'navvi/fry/hn' -> 'gopass://docker:abc123/navvi/fry/hn'
    """
    env = detect_environment()
    path = gopass_path
    if path.startswith("gopass://"):
        path = path[len("gopass://"):]
    if path.startswith("docker:") or path.startswith("codespace:") or path.startswith("local/"):
        return "gopass://{}".format(path)
    return "gopass://{}/{}".format(env, path)


def parse_creds_ref(creds_ref: str) -> dict:
    """Parse a prefixed creds_ref into environment + gopass path.

    'gopass://docker:abc123/navvi/fry/hn' -> {'env': 'docker:abc123', 'path': 'navvi/fry/hn'}
    'gopass://navvi/fry/hn' -> {'env': '', 'path': 'navvi/fry/hn'}
    """
    ref = creds_ref
    if ref.startswith("gopass://"):
        ref = ref[len("gopass://"):]
    if ref.startswith("docker:") or ref.startswith("codespace:"):
        colon_pos = ref.index(":")
        slash_pos = ref.index("/", colon_pos)
        return {"env": ref[:slash_pos], "path": ref[slash_pos + 1:]}
    if ref.startswith("local/"):
        return {"env": "local", "path": ref[6:]}
    return {"env": "", "path": ref}


def format_missing(missing: list) -> str:
    msg = "Missing dependencies:\n\n"
    for dep in missing:
        msg += f"{dep['name']} — install with:\n"
        for cmd in dep["install"]:
            msg += f"  $ {cmd}\n"
        msg += "\n"
    msg += "Install the missing dependencies and try again."
    return msg


def resolve_persona(persona: Optional[str] = None) -> tuple:
    """Resolve which persona to target and return (name, api_base_url)."""
    name = persona or active_persona or "default"
    return name, navvi_api or "http://127.0.0.1:{}".format(NAVVI_PORT)


# --- Persona & Account Tools ---


@mcp.tool(tags={"management"})
async def navvi_persona(
    action: str,
    name: str = "",
    description: str = "",
    purpose: str = "",
    stealth: str = "",
    locale: str = "",
    timezone: str = "",
    viewport: str = "",
) -> str:
    """Manage browser personas. Actions: create, get, update, list, delete.

    Create: navvi_persona(action="create", name="mybot", description="GitHub admin", stealth="high")
    List: navvi_persona(action="list")
    Get: navvi_persona(action="get", name="mybot")
    Update: navvi_persona(action="update", name="mybot", purpose="new purpose")
    Delete: navvi_persona(action="delete", name="mybot")

    Personas store config (locale, timezone, stealth, purpose) and track accounts + action history.
    Each persona maps to a persistent Docker volume (navvi-profile-<name>).
    Read persona state via resource: persona://<name>/state"""
    try:
        if action == "create":
            if not name:
                return "Error: name is required for create."
            kwargs = {}
            if description:
                kwargs["description"] = description
            if purpose:
                kwargs["purpose"] = purpose
            if stealth:
                kwargs["stealth"] = stealth
            if locale:
                kwargs["locale"] = locale
            if timezone:
                kwargs["timezone"] = timezone
            if viewport:
                kwargs["viewport"] = viewport
            p = create_persona(name, **kwargs)
            return f"Persona '{name}' created.\n\n{persona_state_summary(name)}"

        elif action == "get":
            if not name:
                return "Error: name is required for get."
            p = get_persona(name)
            if not p:
                return f"Persona '{name}' not found."
            return persona_state_summary(name)

        elif action == "update":
            if not name:
                return "Error: name is required for update."
            kwargs = {}
            if description:
                kwargs["description"] = description
            if purpose:
                kwargs["purpose"] = purpose
            if stealth:
                kwargs["stealth"] = stealth
            if locale:
                kwargs["locale"] = locale
            if timezone:
                kwargs["timezone"] = timezone
            if viewport:
                kwargs["viewport"] = viewport
            update_persona(name, **kwargs)
            return f"Persona '{name}' updated.\n\n{persona_state_summary(name)}"

        elif action == "list":
            return personas_list_summary()

        elif action == "delete":
            if not name:
                return "Error: name is required for delete."
            if name == "default":
                return "Error: cannot delete the default persona."
            if delete_persona(name):
                return "Persona '{}' deleted. Gopass credentials namespaced under navvi/{} are preserved in the shared vault.".format(name, name)
            return f"Persona '{name}' not found."

        else:
            return f"Unknown action '{action}'. Valid: create, get, update, list, delete."
    except ValueError as e:
        return f"Error: {e}"


@mcp.tool(tags={"management"})
async def navvi_account(
    action: str,
    persona: str = "default",
    service: str = "",
    email: str = "",
    creds_ref: str = "",
    status: str = "active",
    notes: str = "",
    account_id: int = 0,
) -> str:
    """Manage accounts linked to a persona. Actions: add, list, update, delete.

    Add: navvi_account(action="add", persona="mybot", service="github", email="bot@x.com", creds_ref="gopass://navvi/mybot/github")
    List: navvi_account(action="list", persona="mybot")
    Update: navvi_account(action="update", account_id=1, status="blocked", notes="captcha")
    Delete: navvi_account(action="delete", account_id=1)

    Accounts track which services a persona has registered on, with credential references (gopass://) and status."""
    try:
        if action == "add":
            if not service:
                return "Error: service is required for add."
            # Auto-prefix creds_ref with environment if it's a bare gopass path
            prefixed = prefix_creds_ref(creds_ref) if creds_ref else ""
            a = add_account(persona, service, email, prefixed, status, notes)
            log_persona_action(persona, "account_created", "{}: {}".format(service, email))
            return "Account added (id={}): {} — {} (creds: {})".format(a['id'], service, email, prefixed or "none")

        elif action == "list":
            accounts = list_accounts(persona)
            if not accounts:
                return f"No accounts for persona '{persona}'."
            lines = []
            for a in accounts:
                lines.append(f"[{a['id']}] {a['service']}: {a['email']} (status: {a['status']}, creds: {a['creds_ref'] or 'none'})")
            return "\n".join(lines)

        elif action == "update":
            if not account_id:
                return "Error: account_id is required for update."
            kwargs = {}
            if service:
                kwargs["service"] = service
            if email:
                kwargs["email"] = email
            if creds_ref:
                kwargs["creds_ref"] = creds_ref
            if status:
                kwargs["status"] = status
            if notes:
                kwargs["notes"] = notes
            a = update_account(account_id, **kwargs)
            if not a:
                return f"Account {account_id} not found."
            return f"Account {account_id} updated: {a['service']} — {a['email']} ({a['status']})"

        elif action == "delete":
            if not account_id:
                return "Error: account_id is required for delete."
            if delete_account(account_id):
                return f"Account {account_id} deleted."
            return f"Account {account_id} not found."

        else:
            return f"Unknown action '{action}'. Valid: add, list, update, delete."
    except Exception as e:
        return f"Error: {e}"


# --- Tool Definitions ---


@mcp.tool()
async def navvi_start(
    persona: str = "default",
    mode: str = "local",
    name: str = "",
) -> str:
    """Start a Navvi browser container (Firefox + Xvfb + xdotool). Local=Docker, Remote=Codespace. Workflow: navvi_open(url) -> navvi_find(selector) -> navvi_click/navvi_fill -> navvi_screenshot to verify. All input is OS-level (isTrusted:true). If you hit a CAPTCHA you cannot solve (Arkose/FunCaptcha, image puzzles, reCAPTCHA), call navvi_vnc and send the user the noVNC URL so they can solve it manually."""
    global active_persona, navvi_api

    if mode == "local":
        missing = check_local_deps()
        if missing:
            return format_missing(missing)

        # Single container for all personas — always named navvi-default
        cname = "navvi-default"

        # Check if already running
        existing = sh('docker ps -q --filter "name=navvi-default" 2>/dev/null')
        if existing:
            reachable = is_api_reachable(NAVVI_PORT)
            active_persona = persona
            navvi_api = "http://127.0.0.1:{}".format(NAVVI_PORT)

            # Start persona's Firefox instance if not default
            if persona != "default" and reachable:
                try:
                    result = await api_call("POST", "/persona/start", {"name": persona})
                    touch_persona(persona)
                    return (
                        "Navvi running. Started persona '{}' (port {}).\nAPI: http://127.0.0.1:{}\nVNC: http://127.0.0.1:{}\n\n"
                        "Available prompts: signup_flow(service), login_flow(service), qa_walk(url)\n"
                        "Companion agents: navvi-browse, navvi-login, navvi-signup"
                    ).format(persona, result.get("port", "?"), NAVVI_PORT, VNC_PORT)
                except Exception:
                    pass  # Already running or error — fall through to switch
                try:
                    await api_call("POST", "/persona/switch", {"name": persona})
                except Exception:
                    pass

            touch_persona(persona)
            health = "healthy" if reachable else "starting..."
            return (
                "Navvi running. Active persona: '{}'.\nAPI: http://127.0.0.1:{} ({})\nVNC: http://127.0.0.1:{}\n\n"
                "Available prompts: signup_flow(service), login_flow(service), qa_walk(url)\n"
                "Companion agents: navvi-browse, navvi-login, navvi-signup"
            ).format(persona, NAVVI_PORT, health, VNC_PORT,
            )

        # Remove stopped container with same name
        sh("docker rm navvi-default 2>/dev/null")

        # Read persona config from store (fallback to YAML for backwards compat)
        p = get_persona(persona)
        if p:
            locale = p.get("locale", "en-US")
            timezone = p.get("timezone", "UTC")
        else:
            config = read_persona_yaml(persona)
            locale = config.get("locale", "en-US")
            timezone = config.get("timezone", "UTC")

        # Shared volumes — one set for all personas
        # Firefox profile, GPG key, and gopass vault are shared
        # Credentials are namespaced by persona: navvi/{persona}/{service}
        docker_args = [
            "run", "-d",
            "--name", cname,
            "-p", "{}:8024".format(NAVVI_PORT),
            "-p", "{}:6080".format(VNC_PORT),
            "-v", "navvi-profile:/home/user/.mozilla",
            "-v", "navvi-gpg:/home/user/.gnupg",
            "-v", "navvi-gopass:/home/user/.local/share/gopass",
            "-e", "LOCALE={}".format(locale),
            "-e", "TIMEZONE={}".format(timezone),
        ]

        # Pass GPG passphrase if available
        gpg_pass = os.environ.get("NAVVI_GPG_PASSPHRASE")
        if gpg_pass:
            docker_args.extend(["-e", "NAVVI_GPG_PASSPHRASE={}".format(gpg_pass)])

        # Pass GPG private key if available
        gpg_key = os.environ.get("GPG_PRIVATE_KEY")
        if gpg_key:
            docker_args.extend(["-e", "GPG_PRIVATE_KEY={}".format(gpg_key)])

        docker_args.append(DOCKER_IMAGE)

        result = sh("docker {}".format(" ".join(docker_args)))
        if "Error" in result or "error" in result:
            return "Failed to start container:\n{}\n\nMake sure the image is built: docker build -t navvi container/".format(result)

        # Wait for API
        active_persona = persona
        navvi_api = "http://127.0.0.1:{}".format(NAVVI_PORT)

        ready = False
        for _ in range(15):
            await asyncio.sleep(1)
            if is_api_reachable(NAVVI_PORT):
                ready = True
                break

        set_mode("local")
        touch_persona(persona)
        log_persona_action(persona, "started", "mode=local, persona={}".format(persona))
        health = "healthy" if ready else "starting..."
        return (
            "Navvi started (persona: {}).\n"
            "Container: {}\n"
            "API: http://127.0.0.1:{} ({})\n"
            "VNC: http://127.0.0.1:{}\n"
            "Volumes: navvi-profile, navvi-gpg, navvi-gopass (shared, persistent)\n\n"
            "Use navvi_browse for browsing, navvi_screenshot to verify.\n\n"
            "Available prompts: signup_flow(service), login_flow(service), qa_walk(url)\n"
            "Companion agents: navvi-browse (autonomous browsing), navvi-login (login flows), navvi-signup (account creation)"
        ).format(persona, cname, NAVVI_PORT, health, VNC_PORT)

    if mode == "remote":
        missing = check_remote_deps()
        if missing:
            return format_missing(missing)

        cs_token = os.environ.get("CODESPACE_TOKEN")
        gh_env = {**os.environ, "GH_TOKEN": cs_token} if cs_token else dict(os.environ)

        cs_name = name or ""
        if cs_name:
            # SSH auto-starts stopped codespaces
            try:
                subprocess.run(
                    f"gh cs ssh -c {cs_name} -- echo ready",
                    shell=True, capture_output=True, text=True, timeout=120, env=gh_env,
                )
            except Exception:
                pass
        else:
            stopped = gh_sh(
                f'gh cs list --repo {REPO} --json name,state -q \'.[]\u00a0| select(.state=="Shutdown") | .name\''
            )
            if stopped:
                cs_name = stopped.split("\n")[0]
                try:
                    subprocess.run(
                        f"gh cs ssh -c {cs_name} -- echo ready",
                        shell=True, capture_output=True, text=True, timeout=120, env=gh_env,
                    )
                except Exception:
                    pass
            else:
                cs_name = gh_sh(
                    f"gh cs create --repo {REPO} --machine {MACHINE_TYPE} --json name -q '.name'"
                )

        if not cs_name:
            return "Failed to start Codespace. Check gh auth status and CODESPACE_TOKEN env var."

        # Wait for navvi-server inside codespace
        api_ready = False
        for _ in range(15):
            try:
                check = subprocess.run(
                    f'gh cs ssh -c {cs_name} -- python3 -c "import urllib.request; print(urllib.request.urlopen(\'http://127.0.0.1:8024/health\').read().decode())"',
                    shell=True, capture_output=True, text=True, timeout=10, env=gh_env,
                )
                if '"ok":true' in (check.stdout or ""):
                    api_ready = True
                    break
            except Exception:
                pass
            await asyncio.sleep(3)

        # Port forward
        kill_pidfile(PIDFILE_FWD)
        child = subprocess.Popen(
            ["gh", "cs", "ports", "forward", f"{NAVVI_PORT}:{NAVVI_PORT}", f"{VNC_PORT}:{VNC_PORT}", "-c", cs_name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=gh_env,
            start_new_session=True,
        )
        with open(PIDFILE_FWD, "w") as f:
            f.write(str(child.pid))

        await asyncio.sleep(3)
        reachable = is_api_reachable(NAVVI_PORT)
        set_mode(f"remote:{cs_name}")
        active_persona = persona

        if reachable:
            health = "healthy"
        elif api_ready:
            health = "forwarding..."
        else:
            health = "starting..."

        return (
            f"Navvi started (remote). Codespace: {cs_name}\nAPI: localhost:{NAVVI_PORT} ({health})\nVNC: localhost:{VNC_PORT}\n\n"
            f"Available prompts: signup_flow(service), login_flow(service), qa_walk(url)\n"
            f"Companion agents: navvi-browse, navvi-login, navvi-signup"
        )

    return 'Invalid mode. Use "local" or "remote".'


@mcp.tool()
async def navvi_stop(persona: str = "") -> str:
    """Stop a Navvi container. Stops all if no persona specified. Firefox profile is preserved in the Docker volume."""
    global active_persona

    if persona:
        cname = container_name(persona)
        sh(f"docker stop {cname} 2>/dev/null")
        sh(f"docker rm {cname} 2>/dev/null")
        if active_persona == persona:
            active_persona = None
        return f"Stopped {cname}. Firefox profile preserved in volume navvi-profile-{persona}."

    # Stop all
    containers = list_containers()
    if not containers:
        current_mode = get_mode()
        if current_mode and current_mode.startswith("remote:"):
            cs_name = current_mode.split(":", 1)[1]
            kill_pidfile(PIDFILE_FWD)
            if cs_name:
                gh_sh(f"gh cs stop -c {cs_name}")
            clear_mode()
            return f"Stopped remote Codespace {cs_name}."
        clear_mode()
        return "No running Navvi containers."

    for c in containers:
        cname = container_name(c["name"])
        sh(f"docker stop {cname} 2>/dev/null")
        sh(f"docker rm {cname} 2>/dev/null")

    active_persona = None
    clear_mode()
    return f"Stopped {len(containers)} container(s). Firefox profiles preserved in Docker volumes."


@mcp.tool()
async def navvi_status() -> str:
    """Show current Navvi state -- running containers, API health, active persona."""
    current_mode = get_mode()
    containers = list_containers()
    status = f"Mode: {current_mode or 'off'}\nActive persona: {active_persona or 'none'}"

    if containers:
        status += "\n\nRunning containers:"
        for c in containers:
            ports = get_container_ports(c["name"])
            healthy = is_api_reachable(ports["api"])
            h = "healthy" if healthy else "unhealthy"
            status += f"\n  {c['name']} — API :{ports['api']} ({h}), VNC :{ports['vnc']}"
    else:
        status += "\n\nNo running containers. Start one with navvi_start."

    if os.path.exists(PIDFILE_FWD):
        with open(PIDFILE_FWD) as f:
            status += f"\nPort forward PID: {f.read().strip()}"

    return status


@mcp.tool()
async def navvi_list() -> str:
    """List available Codespaces for Navvi (remote mode)."""
    missing = check_remote_deps()
    if missing:
        return format_missing(missing)

    output = gh_sh(
        f'gh cs list --repo {REPO} --json name,state,createdAt,machine '
        f'-q \'.[]\u00a0| "\\(.name)  \\(.state)  \\(.machine.displayName // "unknown")  \\(.createdAt)"\''
    )
    if not output:
        return f"No Codespaces found for {REPO}."
    return f"Navvi Codespaces:\n{output}"


@mcp.tool(tags={"atomic"})
async def navvi_open(url: str, persona: str = "") -> str:
    """Navigate to a URL in the active browser. After navigating, use navvi_find to locate elements on the page, then navvi_click/navvi_fill to interact."""
    pname, api_base = resolve_persona(persona or None)
    log_action("open", url)
    try:
        result = await api_call("POST", "/navigate", {"url": url}, api_base)
        title = result.get("title", "(loading...)")
        final_url = result.get("url", url)
        log_persona_action(pname, "navigate", f"{final_url} — {title}")
        return f"Opened {url}\nTitle: {title}\nURL: {final_url}"
    except Exception as e:
        return f"Error navigating: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_click(x: int, y: int, persona: str = "") -> str:
    """Click at (x, y) screen coordinates using OS-level xdotool input (isTrusted: true). IMPORTANT: Use navvi_find to get coordinates -- it returns screen-ready (x, y) values. Do NOT use raw JS getBoundingClientRect() -- those are viewport coords that miss the browser chrome offset."""
    _, api_base = resolve_persona(persona or None)
    log_action("click", f"({x}, {y})")
    try:
        await api_call("POST", "/click", {"x": x, "y": y}, api_base)
        return f"Clicked at ({x}, {y})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_fill(x: int, y: int, value: str, delay: int = 12, persona: str = "") -> str:
    """Click at (x, y) to focus an input field, then type text using OS-level xdotool. Get coordinates from navvi_find first. Selects existing text (Ctrl+A) before typing to replace any current value."""
    pname, api_base = resolve_persona(persona or None)
    fill_duration_ms = len(value) * delay
    log_action("fill", {"x": x, "y": y, "text": value, "durationMs": fill_duration_ms})
    try:
        # Click to focus
        await api_call("POST", "/click", {"x": x, "y": y}, api_base)
        await asyncio.sleep(0.1)
        # Type
        await api_call("POST", "/type", {"text": value, "delay": delay}, api_base)
        log_persona_action(pname, "fill", f"({x},{y}) {len(value)} chars")
        return f'Filled at ({x}, {y}) with "{value}" ({len(value)} chars)'
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_press(key: str, persona: str = "") -> str:
    """Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown, etc.). Sends to currently focused element."""
    _, api_base = resolve_persona(persona or None)
    log_action("press", key)
    try:
        await api_call("POST", "/key", {"key": key}, api_base)
        return f"Pressed {key}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_drag(
    x1: int, y1: int, x2: int, y2: int,
    steps: int = 20, duration: float = 0.3,
    persona: str = "",
) -> str:
    """Drag from (x1,y1) to (x2,y2) with interpolated mouse moves. Uses OS-level input -- works on CAPTCHAs and canvases. Get coordinates from navvi_find."""
    _, api_base = resolve_persona(persona or None)
    log_action("drag", {"from": [x1, y1], "to": [x2, y2]})
    try:
        params = {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "steps": steps, "duration": duration}
        await api_call("POST", "/drag", params, api_base)
        return f"Dragged from ({x1}, {y1}) to ({x2}, {y2})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_hold(x: int, y: int, duration_ms: int = 5000, persona: str = "") -> str:
    """Press and hold at (x, y) for duration_ms milliseconds. Use for press-and-hold CAPTCHAs. Get coordinates from navvi_find."""
    _, api_base = resolve_persona(persona or None)
    log_action("hold", "({}, {}) {}ms".format(x, y, duration_ms))
    try:
        await api_call("POST", "/hold", {"x": x, "y": y, "duration_ms": duration_ms}, api_base)
        return "Held at ({}, {}) for {}ms".format(x, y, duration_ms)
    except Exception as e:
        return "Error: {}".format(e)


@mcp.tool(tags={"atomic"})
async def navvi_mousedown(x: int, y: int, persona: str = "") -> str:
    """Press mouse button at (x, y). Pair with navvi_mouseup for manual hold control. For simple press-and-hold, use navvi_hold instead."""
    _, api_base = resolve_persona(persona or None)
    log_action("mousedown", f"({x}, {y})")
    try:
        await api_call("POST", "/mousedown", {"x": x, "y": y}, api_base)
        return f"Mouse down at ({x}, {y})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_mouseup(x: int, y: int, persona: str = "") -> str:
    """Release mouse button at (x, y). Pair with navvi_mousedown."""
    _, api_base = resolve_persona(persona or None)
    log_action("mouseup", f"({x}, {y})")
    try:
        await api_call("POST", "/mouseup", {"x": x, "y": y}, api_base)
        return f"Mouse up at ({x}, {y})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_mousemove(x: int, y: int, persona: str = "") -> str:
    """Move mouse to (x, y) without clicking. Useful for hover effects."""
    _, api_base = resolve_persona(persona or None)
    log_action("mousemove", f"({x}, {y})")
    try:
        await api_call("POST", "/mousemove", {"x": x, "y": y}, api_base)
        return f"Mouse moved to ({x}, {y})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_scroll(direction: str = "down", amount: int = 3, persona: str = "") -> str:
    """Scroll the page in a given direction (up, down, left, right)."""
    _, api_base = resolve_persona(persona or None)
    log_action("scroll", f"{direction} x{amount}")
    try:
        await api_call("POST", "/scroll", {"direction": direction, "amount": amount}, api_base)
        return f"Scrolled {direction} x{amount}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def navvi_screenshot(persona: str = "") -> str:
    """Take a screenshot of the virtual display. Returns file path to a PNG image -- use Read tool to view it. Use for VISUAL VERIFICATION only (confirming what happened). To get clickable coordinates, use navvi_find instead -- screenshot pixel positions include browser chrome and are not reliable for targeting elements."""
    _, api_base = resolve_persona(persona or None)
    try:
        result = await api_call("GET", "/screenshot", api_base=api_base)
        if not result.get("base64"):
            return "Error: no screenshot data returned."

        img_bytes = base64.b64decode(result["base64"])
        filename = f"navvi-screenshot-{int(time.time() * 1000)}.png"
        filepath = os.path.join(tempfile.gettempdir(), filename)
        with open(filepath, "wb") as f:
            f.write(img_bytes)

        size_kb = round(len(img_bytes) / 1024)
        return f"Screenshot saved to {filepath} ({size_kb}KB).\nUse Read tool to view the image."
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_url(persona: str = "") -> str:
    """Get the current page URL."""
    _, api_base = resolve_persona(persona or None)
    try:
        result = await api_call("GET", "/url", api_base=api_base)
        return result.get("url", "(unknown)")
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def navvi_vnc(persona: str = "") -> str:
    """Get the noVNC URL for live browser view. Share with the user when human intervention is needed: visual CAPTCHAs that require image recognition, OAuth consent screens, or 2FA code entry. The user opens this URL in their real browser to interact directly."""
    # Start a local TCP proxy to bypass Docker Desktop WebSocket issues on macOS
    proxy_port = VNC_PORT + 10000  # 6080 -> 16080
    proxy_url = "http://127.0.0.1:{}/vnc.html?autoconnect=true&resize=scale".format(proxy_port)

    # Check if proxy is already running
    try:
        import socket as _sock
        test = _sock.socket()
        test.settimeout(1)
        test.connect(("127.0.0.1", proxy_port))
        test.close()
    except Exception:
        # Start proxy in background
        _start_vnc_proxy(VNC_PORT, proxy_port)

    return (
        "noVNC: {}\n\n"
        "Open this URL in a browser for live view. Use for:\n"
        "- Human CAPTCHA solving\n"
        "- OAuth login flows\n"
        "- Visual debugging"
    ).format(proxy_url)


def _start_vnc_proxy(docker_port: int, proxy_port: int):
    """Start a TCP proxy that forwards browser connections to Docker's VNC port.

    Docker Desktop on macOS doesn't forward WebSocket upgrades correctly.
    This proxy forwards raw TCP bytes, which works for both HTTP and WebSocket.
    """
    import threading

    def _fwd(src, dst):
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except Exception:
            pass
        finally:
            src.close()
            dst.close()

    def _serve():
        import socket as _sock
        server = _sock.socket()
        server.setsockopt(_sock.SOL_SOCKET, _sock.SO_REUSEADDR, 1)
        try:
            server.bind(("127.0.0.1", proxy_port))
        except OSError:
            return  # already running
        server.listen(5)
        while True:
            client, _ = server.accept()
            remote = _sock.socket()
            try:
                remote.connect(("127.0.0.1", docker_port))
                threading.Thread(target=_fwd, args=(client, remote), daemon=True).start()
                threading.Thread(target=_fwd, args=(remote, client), daemon=True).start()
            except Exception:
                client.close()
                remote.close()

    t = threading.Thread(target=_serve, daemon=True)
    t.start()


@mcp.tool(tags={"atomic"})
async def navvi_find(selector: str, all: bool = False, persona: str = "") -> str:
    """Find element(s) by CSS selector and return screen-ready (x, y) coordinates. THIS IS THE PRIMARY WAY TO GET COORDINATES -- use before navvi_click, navvi_fill, navvi_drag, navvi_mousedown. Automatically corrects for browser chrome offset. Workflow: navvi_find -> get (x, y) -> navvi_click/navvi_fill at those coords -> navvi_screenshot to verify. For dropdowns: navvi_find the button -> navvi_click to open -> navvi_find the options (selector="[role=option]", all=true) -> navvi_click the desired option."""
    _, api_base = resolve_persona(persona or None)
    log_action("find", selector)
    try:
        params = {"selector": selector}
        if all:
            params["all"] = True
        result = await api_call("POST", "/find", params, api_base)

        if not result.get("found"):
            return f"No element found for selector: {selector}"

        if result.get("elements"):
            # Multiple results
            output = f'Found {result["count"]} element(s) for "{selector}":\n'
            for el in result["elements"]:
                if not el.get("visible"):
                    continue
                eid = f"#{el['id']}" if el.get("id") else ""
                output += f"  {el['tag']}{eid} — ({el['x']}, {el['y']}) {el['width']}x{el['height']}"
                if el.get("text"):
                    output += f' "{el["text"][:40]}"'
                if el.get("placeholder"):
                    output += f' placeholder="{el["placeholder"]}"'
                output += "\n"
            return output

        # Single result
        eid = f"#{result['id']}" if result.get("id") else ""
        output = f"Found: {result['tag']}{eid} at ({result['x']}, {result['y']}) {result['width']}x{result['height']}"
        if result.get("text"):
            output += f'\nText: "{result["text"]}"'
        if result.get("placeholder"):
            output += f'\nPlaceholder: "{result["placeholder"]}"'
        if result.get("value"):
            output += f'\nValue: "{result["value"]}"'
        output += f"\n\nUse navvi_click x={result['x']} y={result['y']} to click this element."
        return output
    except Exception as e:
        return f"Error: {e}"


@mcp.tool(tags={"atomic"})
async def navvi_creds(
    action: str,
    entry: str = "",
    field: str = "",
    username: str = "",
    length: int = 24,
    file_path: str = "",
    username_selector: str = "",
    password_selector: str = "",
    persona: str = "",
) -> str:
    """Manage credentials stored in gopass inside the container. Five actions:

    - "list": show available entries (no secrets)
    - "get": retrieve a non-secret field (username, url, email — refuses password)
    - "generate": create a new credential with a random password that NEVER leaves the container.
      Requires entry + username. Optional length (default 24). Use this for signups.
    - "import": bulk-import credentials from a JSON file on the host. Requires file_path pointing
      to a JSON array of {entry, username, password} objects. File is read and deleted after import.
    - "autofill": fill a login form from gopass — password goes gopass → xdotool → browser, NEVER in this response.
    """
    _, api_base = resolve_persona(persona or None)

    if action == "list":
        try:
            result = await api_call("GET", "/creds/list", api_base=api_base)
            entries = result.get("entries", [])
            if not entries:
                return "No credentials stored in gopass. Use navvi_creds(action='generate') or navvi_creds(action='import') to add entries."
            # Filter by persona if specified
            pname = persona or active_persona or ""
            if pname:
                prefix = "navvi/{}/".format(pname)
                filtered = [e for e in entries if e.startswith(prefix)]
                if filtered:
                    output = "Credentials for persona '{}' ({} entries):\n".format(pname, len(filtered))
                    for e in filtered:
                        # Show just the service part
                        service = e.replace(prefix, "")
                        output += "  {} ({})\n".format(service, e)
                    return output
            # No persona filter or no matches — show all
            output = "All credentials ({} entries):\n".format(len(entries))
            for e in entries:
                output += "  {}\n".format(e)
            return output
        except Exception as e:
            return "Error: {}".format(e)

    if action == "get":
        if not entry:
            return 'Error: "entry" is required for get action.'
        if not field:
            return 'Error: "field" is required for get action (e.g. "username", "url", "email").'
        try:
            result = await api_call("POST", "/creds/get", {"entry": entry, "field": field}, api_base)
            return f"{field}: {result.get('value', '')}"
        except Exception as e:
            return f"Error: {e}"

    if action == "generate":
        if not entry:
            return 'Error: "entry" is required for generate action.'
        if not username:
            return 'Error: "username" is required for generate action.'
        log_action("creds_generated", entry)
        try:
            result = await api_call("POST", "/creds/generate", {
                "entry": entry, "username": username, "length": length,
            }, api_base)
            prefixed_ref = prefix_creds_ref(entry)
            return (
                "Credential stored: {} ({} chars)\n"
                "Username: {}\n\n"
                "Password was generated inside the container and NEVER appeared in this response.\n"
                "Use navvi_creds(action='autofill', entry='{}') to fill it into a form."
            ).format(prefixed_ref, length, username, entry)
        except Exception as e:
            return "Error: {}".format(e)

    if action == "import":
        if not file_path:
            return 'Error: "file_path" is required for import action. Point to a JSON file with [{entry, username, password}, ...].'
        import json as _json
        try:
            with open(file_path, "r") as f:
                creds = _json.load(f)
            if not isinstance(creds, list):
                return "Error: JSON file must contain an array of {entry, username, password} objects."
        except FileNotFoundError:
            return f"Error: File not found: {file_path}"
        except _json.JSONDecodeError as e:
            return f"Error: Invalid JSON: {e}"

        log_action("creds_imported", f"{len(creds)} entries from {file_path}")
        try:
            result = await api_call("POST", "/creds/import", {"credentials": creds}, api_base)
            # Delete the file after successful import
            try:
                os.remove(file_path)
            except OSError:
                pass
            imported = result.get("imported", 0)
            errors = result.get("errors", [])
            output = f"Imported {imported} credential(s). Source file deleted."
            if errors:
                output += f"\n\nErrors ({len(errors)}):"
                for err in errors:
                    output += f"\n  {err['entry']}: {err['error']}"
            return output
        except Exception as e:
            return f"Error: {e}"

    if action == "autofill":
        if not entry:
            return 'Error: "entry" is required for autofill action.'
        # Parse environment prefix — strip it for the gopass path
        parsed = parse_creds_ref(entry)
        gopass_entry = parsed["path"]
        creds_env = parsed["env"]
        if creds_env and not creds_env.startswith("docker:") and creds_env != "local" and creds_env != "":
            return "Error: autofill for environment '{}' is not supported from this container. Credential lives in a different environment.".format(creds_env)
        log_action("autofill", entry)
        try:
            params = {"entry": gopass_entry}
            if username_selector:
                params["username_selector"] = username_selector
            if password_selector:
                params["password_selector"] = password_selector
            result = await api_call("POST", "/creds/autofill", params, api_base)
            username_at = result.get("username_at", [])
            password_at = result.get("password_at", [])
            note = result.get("note", "")
            return (
                f'Autofill complete for "{entry}".\n'
                f"Username filled at ({', '.join(str(v) for v in username_at)})\n"
                f"Password filled at ({', '.join(str(v) for v in password_at)})\n\n"
                f"{note}"
            )
        except Exception as e:
            return f"Error: {e}"

    return 'Error: action must be "list", "get", "generate", "import", or "autofill".'


@mcp.tool(tags={"recording"})
async def navvi_record_start(duration: int = 30, persona: str = "") -> str:
    """Start recording the browser via screenshot polling. Captures frames in background, assembles to MP4 on stop."""
    _, api_base = resolve_persona(persona or None)

    # Check for existing recording
    if os.path.exists(RECORDING_STATE_FILE):
        try:
            with open(RECORDING_STATE_FILE) as f:
                state = json.load(f)
            if state.get("active"):
                return f"Recording already in progress ({state.get('frames', 0)} frames). Use navvi_record_stop first."
        except Exception:
            pass

    if not which("ffmpeg"):
        return "Error: ffmpeg not installed. Install with: brew install ffmpeg"

    os.makedirs(RECORDINGS_DIR, exist_ok=True)

    duration = min(duration, 120)
    fps = 4
    ts = time.strftime("%Y-%m-%dT%H-%M-%S")
    frames_dir = os.path.join(RECORDINGS_DIR, f"frames-{ts}")
    os.makedirs(frames_dir, exist_ok=True)

    state = {
        "active": True,
        "framesDir": frames_dir,
        "ts": ts,
        "fps": fps,
        "duration": duration,
        "frames": 0,
        "startTime": int(time.time() * 1000),
        "apiBase": api_base,
    }
    with open(RECORDING_STATE_FILE, "w") as f:
        json.dump(state, f)

    # Clear action log
    try:
        os.unlink(ACTION_LOG)
    except Exception:
        pass

    # Write a Python capture script instead of Node
    capture_script = f"""#!/usr/bin/env python3
import json, os, time, urllib.request, base64

FRAMES_DIR = {json.dumps(frames_dir)}
STATE_FILE = {json.dumps(RECORDING_STATE_FILE)}
API_BASE = {json.dumps(api_base)}
FPS = {fps}
MAX_FRAMES = {duration} * FPS
frame = 0

def grab_frame():
    global frame
    try:
        req = urllib.request.Request(API_BASE + "/screenshot", method="GET")
        with urllib.request.urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode())
        if data.get("base64"):
            img = base64.b64decode(data["base64"])
            name = f"frame-{{frame:06d}}.png"
            with open(os.path.join(FRAMES_DIR, name), "wb") as f:
                f.write(img)
            frame += 1
            try:
                with open(STATE_FILE) as f:
                    s = json.load(f)
                s["frames"] = frame
                with open(STATE_FILE, "w") as f:
                    json.dump(s, f)
            except Exception:
                pass
    except Exception:
        pass

interval = 1.0 / FPS
while frame < MAX_FRAMES:
    t0 = time.time()
    grab_frame()
    elapsed = time.time() - t0
    wait = max(0, interval - elapsed)
    if wait > 0:
        time.sleep(wait)
    try:
        with open(STATE_FILE) as f:
            s = json.load(f)
        if not s.get("active"):
            break
    except Exception:
        break

try:
    with open(STATE_FILE) as f:
        s = json.load(f)
    s["active"] = False
    s["frames"] = frame
    with open(STATE_FILE, "w") as f:
        json.dump(s, f)
except Exception:
    pass
"""

    script_file = os.path.join(tempfile.gettempdir(), ".navvi-capture.py")
    with open(script_file, "w") as f:
        f.write(capture_script)

    python_bin = sys.executable or which("python3") or "/usr/bin/python3"
    log_file = os.path.join(RECORDINGS_DIR, f"capture-{ts}.log")
    log_fd = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)

    child = subprocess.Popen(
        [python_bin, script_file],
        stdout=log_fd,
        stderr=log_fd,
        start_new_session=True,
    )
    os.close(log_fd)

    with open(PIDFILE_RECORD, "w") as f:
        f.write(str(child.pid))

    return f"Recording started ({fps}fps, max {duration}s).\nFrames dir: {frames_dir}\nUse navvi_record_stop to finish."


@mcp.tool(tags={"recording"})
async def navvi_record_stop(trim: bool = True) -> str:
    """Stop recording and assemble frames into MP4. Optionally trims dead time between actions."""
    if not os.path.exists(RECORDING_STATE_FILE):
        return "No active recording found."

    with open(RECORDING_STATE_FILE) as f:
        state = json.load(f)
    state["active"] = False
    with open(RECORDING_STATE_FILE, "w") as f:
        json.dump(state, f)

    # Kill capture process
    kill_pidfile(PIDFILE_RECORD)

    await asyncio.sleep(1)

    with open(RECORDING_STATE_FILE) as f:
        final_state = json.load(f)

    frames_dir = final_state["framesDir"]
    fps = final_state["fps"]
    frames = final_state.get("frames", 0)
    ts = final_state["ts"]

    if not frames:
        try:
            os.unlink(RECORDING_STATE_FILE)
        except Exception:
            pass
        return "Recording stopped but no frames were captured."

    # Assemble frames into MP4
    ffmpeg_bin = which("ffmpeg") or "/usr/local/bin/ffmpeg"
    output_file = os.path.join(RECORDINGS_DIR, f"{ts}.mp4")

    frame_files = sorted([f for f in os.listdir(frames_dir) if f.endswith(".png")])
    concat_file = os.path.join(frames_dir, "concat.txt")
    concat_lines = []
    for ff in frame_files:
        concat_lines.append(f"file '{os.path.join(frames_dir, ff)}'")
        concat_lines.append(f"duration {1/fps:.4f}")
    if frame_files:
        concat_lines.append(f"file '{os.path.join(frames_dir, frame_files[-1])}'")
    with open(concat_file, "w") as f:
        f.write("\n".join(concat_lines) + "\n")

    assemble_result = sh(
        f'"{ffmpeg_bin}" -y -f concat -safe 0 -i "{concat_file}" '
        f'-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" '
        f'-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p "{output_file}" 2>&1'
    )

    if not os.path.exists(output_file):
        # Clean up frames
        try:
            import shutil as _shutil
            _shutil.rmtree(frames_dir, ignore_errors=True)
        except Exception:
            pass
        try:
            os.unlink(RECORDING_STATE_FILE)
        except Exception:
            pass
        return f"Failed to assemble video.\n{assemble_result}"

    size_kb = round(os.path.getsize(output_file) / 1024)
    duration_sec = f"{frames / fps:.1f}"
    result_msg = (
        f"Recording stopped.\n"
        f"File: {output_file}\n"
        f"Frames: {frames} at {fps}fps\n"
        f"Duration: {duration_sec}s\n"
        f"Size: {size_kb}KB"
    )

    # Smart trim
    if trim and os.path.exists(ACTION_LOG):
        try:
            with open(ACTION_LOG) as f:
                actions = [json.loads(line) for line in f.read().strip().split("\n") if line.strip()]

            if actions and frame_files:
                recording_start = final_state["startTime"]
                frame_duration_ms = 1000 / fps
                BEFORE_MS = 1000
                AFTER_MS = 3000
                keep_frames = set()

                for action in actions:
                    action_offset_ms = action["ts"] - recording_start
                    action_frame = int(action_offset_ms / frame_duration_ms)
                    before_frames = int(BEFORE_MS / frame_duration_ms + 0.99)
                    after_ms = AFTER_MS
                    if action.get("action") == "fill" and isinstance(action.get("detail"), dict):
                        after_ms = action["detail"].get("durationMs", 0) + AFTER_MS
                    after_frames = int(after_ms / frame_duration_ms + 0.99)
                    start = max(0, action_frame - before_frames)
                    end = min(len(frame_files) - 1, action_frame + after_frames)
                    for i in range(start, end + 1):
                        keep_frames.add(i)

                if len(keep_frames) < len(frame_files) * 0.8:
                    trimmed_frames = [ff for i, ff in enumerate(frame_files) if i in keep_frames]
                    trim_concat_file = os.path.join(frames_dir, "concat-trimmed.txt")
                    trim_lines = []
                    for ff in trimmed_frames:
                        trim_lines.append(f"file '{os.path.join(frames_dir, ff)}'")
                        trim_lines.append(f"duration {1/fps:.4f}")
                    if trimmed_frames:
                        trim_lines.append(f"file '{os.path.join(frames_dir, trimmed_frames[-1])}'")
                    with open(trim_concat_file, "w") as f:
                        f.write("\n".join(trim_lines) + "\n")

                    trimmed_file = os.path.join(RECORDINGS_DIR, f"{ts}-trimmed.mp4")
                    sh(
                        f'"{ffmpeg_bin}" -y -f concat -safe 0 -i "{trim_concat_file}" '
                        f'-vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" '
                        f'-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p "{trimmed_file}" 2>&1'
                    )

                    if os.path.exists(trimmed_file):
                        trim_size_kb = round(os.path.getsize(trimmed_file) / 1024)
                        trim_duration_sec = f"{len(trimmed_frames) / fps:.1f}"
                        result_msg += f"\n\nTrimmed: {trimmed_file}\nDuration: {trim_duration_sec}s ({trim_size_kb}KB)"
                else:
                    result_msg += "\n\n(Trim skipped — not enough dead time.)"
        except Exception as e:
            result_msg += f"\n\n(Trim failed: {e})"

        try:
            os.unlink(ACTION_LOG)
        except Exception:
            pass

    # Clean up frames
    try:
        import shutil as _shutil
        _shutil.rmtree(frames_dir, ignore_errors=True)
    except Exception:
        pass
    try:
        os.unlink(RECORDING_STATE_FILE)
    except Exception:
        pass

    result_msg += "\n\nConvert to GIF with navvi_record_gif."
    return result_msg


@mcp.tool(tags={"recording"})
async def navvi_record_gif(input: str = "") -> str:
    """Convert a recorded video to an optimized GIF (1600px wide, 8fps, palette-optimized)."""
    if not which("ffmpeg"):
        return "Error: ffmpeg not installed."

    input_file = input
    if not input_file:
        if not os.path.exists(RECORDINGS_DIR):
            return "No recordings directory found."
        files = sorted(
            [f for f in os.listdir(RECORDINGS_DIR) if f.endswith((".mp4", ".mov"))],
            reverse=True,
        )
        if not files:
            return "No recordings found."
        input_file = os.path.join(RECORDINGS_DIR, files[0])

    if not os.path.exists(input_file):
        return f"Error: input file not found: {input_file}"

    output_file = re.sub(r"\.(mp4|mov)$", ".gif", input_file)
    palette = os.path.join(tempfile.gettempdir(), ".navvi-palette.png")

    pass1 = sh(f'ffmpeg -y -i "{input_file}" -vf "fps=8,scale=1600:-1:flags=lanczos,palettegen" "{palette}" 2>&1')
    if not os.path.exists(palette):
        return f"GIF palette generation failed.\n{pass1}"

    sh(f'ffmpeg -y -i "{input_file}" -i "{palette}" -lavfi "fps=8,scale=1600:-1:flags=lanczos [x]; [x][1:v] paletteuse" "{output_file}" 2>&1')

    try:
        os.unlink(palette)
    except Exception:
        pass

    if not os.path.exists(output_file):
        return "GIF conversion failed."

    size_kb = round(os.path.getsize(output_file) / 1024)
    return f"GIF created: {output_file} ({size_kb}KB)\n\nDo NOT use Read on this file."


# --- Journey Helpers ---


def _save_screenshot(b64_data: str) -> str:
    """Save base64 screenshot to temp file, return path."""
    path = os.path.join(tempfile.gettempdir(), "navvi-browse-{}.png".format(int(time.time() * 1000)))
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64_data))
    return path


def _element_matches_description(element: dict, description: str) -> bool:
    """Fuzzy match an element against a natural language description."""
    desc_lower = description.lower()
    desc_words = desc_lower.split()
    text = element.get("text", "").lower()
    aria = element.get("ariaLabel", "").lower()
    placeholder = element.get("placeholder", "").lower()
    name = element.get("name", "").lower()

    for attr in [text, aria, placeholder, name]:
        if attr and any(word in attr for word in desc_words):
            return True
    return False


def _format_steps_log(steps: list) -> str:
    """Format steps log for human readability."""
    lines = []
    for s in steps:
        conf = s.get("confidence", 0)
        lines.append(
            "  Step {}: [{}] {} -> {} (tier: {}, conf: {:.1f})".format(
                s["step"], s["page_type"], s["description"],
                s["action_taken"], s["tier"], conf,
            )
        )
    return "\n".join(lines)


async def _execute_action(action: dict, api_base: str, dom_elements: list):
    """Execute a suggested action against the browser."""
    atype = action.get("type", "none")

    if atype == "click":
        selector = action.get("selector_hint", "")
        target_desc = action.get("target", "")
        if selector:
            try:
                resp = await api_call("POST", "/find", {"selector": selector}, api_base)
                if resp.get("found"):
                    x, y = resp.get("x"), resp.get("y")
                    await api_call("POST", "/click", {"x": x, "y": y}, api_base)
                    return
            except Exception:
                pass
        # Fallback: find element matching description in dom_elements
        for el in dom_elements:
            if _element_matches_description(el, target_desc):
                await api_call("POST", "/click", {"x": el["x"], "y": el["y"]}, api_base)
                return

    elif atype == "fill":
        selector = action.get("selector_hint", "")
        value = action.get("text", "") or action.get("value", "")
        if selector and value:
            try:
                resp = await api_call("POST", "/find", {"selector": selector}, api_base)
                if resp.get("found"):
                    x, y = resp.get("x"), resp.get("y")
                    await api_call("POST", "/click", {"x": x, "y": y}, api_base)
                    await asyncio.sleep(0.1)
                    await api_call("POST", "/type", {"text": value}, api_base)
                    return
            except Exception:
                pass

    elif atype == "press":
        key = action.get("key") or action.get("value") or "Return"
        if not isinstance(key, str) or not key:
            key = "Return"
        await api_call("POST", "/key", {"key": key}, api_base)

    elif atype == "scroll":
        await api_call("POST", "/scroll", {"direction": "down", "amount": 3}, api_base)

    elif atype == "navigate":
        nav_url = action.get("url") or action.get("value", "")
        if nav_url:
            await api_call("POST", "/navigate", {"url": nav_url}, api_base)

    elif atype == "dismiss":
        selector = action.get("selector_hint", "")
        if selector:
            try:
                resp = await api_call("POST", "/find", {"selector": selector}, api_base)
                if resp.get("found"):
                    await api_call("POST", "/click", {"x": resp["x"], "y": resp["y"]}, api_base)
            except Exception:
                pass


# --- Progressive Disclosure ---


@mcp.tool()
async def navvi_atomic(enable: bool = True, ctx: Context = None) -> str:
    """Quick reference for atomic browser tools (navvi_click, navvi_find, navvi_fill, etc.).

    Atomic tools are always available. Call this for a summary of tools and workflow.

    Example: navvi_atomic() → lists all atomic tools with parameters
    """
    return """Atomic tools available — call these directly:

navvi_open(url, persona?) — Navigate to a URL
navvi_find(selector, all?, persona?) — Find element by CSS selector → screen-ready (x, y). THE way to get coordinates.
navvi_click(x, y, persona?) — Click at screen coordinates (from navvi_find)
navvi_fill(x, y, value, delay?, persona?) — Click field + type text
navvi_press(key, persona?) — Press key: Enter, Tab, Escape, Backspace, ArrowDown...
navvi_scroll(direction?, amount?, persona?) — Scroll up/down/left/right
navvi_drag(x1, y1, x2, y2, steps?, duration?, persona?) — Drag between points
navvi_hold(x, y, duration_ms?, persona?) — Press and hold at (x,y) for duration (default 5s). For CAPTCHAs.
navvi_mousedown(x, y, persona?) — Press mouse button (pair with mouseup)
navvi_mouseup(x, y, persona?) — Release mouse button
navvi_mousemove(x, y, persona?) — Move without clicking
navvi_url(persona?) — Get current page URL
navvi_creds(action, entry?, field?, persona?) — Gopass credentials: list, get, generate, import, autofill

Workflow: navvi_find(selector) → get (x, y) → navvi_click/navvi_fill at those coords → navvi_screenshot to verify."""


# --- Journey Tools ---


@mcp.tool(tags={"journey"})
async def navvi_browse(
    instruction: str,
    url: str = "",
    max_steps: int = 10,
    persona: str = "",
) -> str:
    """PRIMARY BROWSING TOOL — use this for ANY web interaction instead of manually calling navvi_open, navvi_find, navvi_click, navvi_fill. Give a natural language instruction and optional URL; it handles navigation, element finding, clicking, typing, and screenshots internally.

    Examples:
    - navvi_browse(instruction="search for 'Python FastMCP'", url="https://duckduckgo.com")
    - navvi_browse(instruction="click the first link in the results")
    - navvi_browse(instruction="accept cookie banners and screenshot the clean page", url="https://example.com")
    - navvi_browse(instruction="read the inbox and list unread emails", url="https://app.tuta.com")

    Handles cookie banners, login detection, CAPTCHAs (escalates to VNC), and multi-step flows automatically. Returns screenshots and a step-by-step log.

    Only fall back to atomic tools (navvi_open, navvi_find, navvi_click) if this tool explicitly asks for guidance.
    """
    from navvi.vision import analyze

    pname, api_base = resolve_persona(persona or None)

    # Navigate to URL if provided
    if url:
        try:
            await api_call("POST", "/navigate", {"url": url}, api_base)
            log_action("browse_navigate", url)
        except Exception as e:
            return "Failed to navigate to {}: {}".format(url, e)

    steps_log = []

    # Fetch viewport info once (doesn't change between steps)
    viewport_info = None
    try:
        viewport_info = await api_call("GET", "/viewport", api_base=api_base)
    except Exception:
        pass

    for step in range(max_steps):
        # 1. Get current state
        try:
            current_url_resp = await api_call("GET", "/url", api_base=api_base)
            current_url = current_url_resp.get("url", "")
            current_title = current_url_resp.get("title", "")
        except Exception:
            current_url = ""
            current_title = ""

        # 2. Screenshot
        try:
            shot_resp = await api_call("GET", "/screenshot", api_base=api_base)
            screenshot_b64 = shot_resp.get("base64", "")
        except Exception:
            screenshot_b64 = ""

        # 3. Get DOM info
        try:
            dom_resp = await api_call(
                "POST", "/find",
                {"selector": "a, button, input, select, textarea, [role=button], [role=link]", "all": True},
                api_base,
            )
            dom_elements = dom_resp.get("elements", [])
        except Exception:
            dom_elements = []

        # 4. Analyze (pass recent steps so Haiku doesn't repeat failed actions)
        analysis = await analyze(screenshot_b64, dom_elements, instruction, current_url, current_title, steps_log, viewport_info)

        tier = analysis.get("tier_used", "unknown")
        confidence = analysis.get("confidence", 0)
        action = analysis.get("suggested_action", {})

        steps_log.append({
            "step": step + 1,
            "url": current_url,
            "page_type": analysis.get("page_type", "unknown"),
            "description": analysis.get("description", ""),
            "action_taken": action.get("type", "none"),
            "tier": tier,
            "confidence": confidence,
        })

        # 5. Check if done
        if action.get("type") == "done":
            log_persona_action(pname, "browse_complete", "{} ({} steps)".format(instruction, step + 1))
            shot_path = _save_screenshot(screenshot_b64) if screenshot_b64 else "(no screenshot)"
            summary = _format_steps_log(steps_log)
            return "Completed in {} steps.\n\n{}\n\nFinal screenshot: {}".format(step + 1, summary, shot_path)

        # 5b. Check if stuck (3 identical consecutive actions)
        if len(steps_log) >= 3:
            last3 = steps_log[-3:]
            if (
                all(s["action_taken"] == last3[0]["action_taken"] for s in last3)
                and all(s["page_type"] == last3[0]["page_type"] for s in last3)
            ):
                shot_path = _save_screenshot(screenshot_b64) if screenshot_b64 else "(no screenshot)"
                summary = _format_steps_log(steps_log)
                return (
                    "Stuck: repeated '{}' action 3 times on '{}' page with no progress.\n\n"
                    "Steps so far:\n{}\n\n"
                    "Screenshot: {}\n\n"
                    "Use atomic tools (navvi_find, navvi_click) to interact directly."
                ).format(last3[0]["action_taken"], last3[0]["page_type"], summary, shot_path)

        # 6. Check if stuck (low confidence + heuristics tier = ask for guidance)
        if confidence < 0.5 and tier == "heuristics":
            shot_path = _save_screenshot(screenshot_b64) if screenshot_b64 else "(no screenshot)"
            summary = _format_steps_log(steps_log)
            return (
                "Need guidance at step {}/{}.\n\n"
                "Goal: {}\n"
                "Current URL: {}\n"
                "Page type: {}\n"
                "Description: {}\n\n"
                "Steps so far:\n{}\n\n"
                "Screenshot: {}\n\n"
                "Suggestion: Use navvi_find to explore the page, then navvi_click/navvi_fill to continue."
            ).format(
                step + 1, max_steps, instruction, current_url,
                analysis.get("page_type", "unknown"),
                analysis.get("description", "could not classify"),
                summary, shot_path,
            )

        # 7. Try reCAPTCHA before aborting
        if action.get("type") == "abort" and analysis.get("page_type") == "captcha":
            from navvi.recaptcha import try_recaptcha_checkbox, solve_image_challenge
            checkbox_result = await try_recaptcha_checkbox(api_call, api_base)
            if checkbox_result == "passed":
                steps_log[-1]["action_taken"] = "recaptcha_checkbox_passed"
                steps_log[-1]["description"] = "reCAPTCHA checkbox passed"
                continue
            elif checkbox_result == "challenge":
                solve_result = await solve_image_challenge(api_call, api_base)
                if solve_result == "solved":
                    steps_log[-1]["action_taken"] = "recaptcha_challenge_solved"
                    steps_log[-1]["description"] = "reCAPTCHA image challenge solved"
                    continue
                # Fall through to abort if failed/no_vision

        # 8. Execute action or abort
        if action.get("type") == "abort":
            reason = action.get("target", "unknown reason")
            log_persona_action(pname, "browse_abort", reason)
            return "Aborted: {}\n\nSteps:\n{}".format(reason, _format_steps_log(steps_log))

        await _execute_action(action, api_base, dom_elements)
        await asyncio.sleep(1)  # Wait for page to settle

    # Max steps reached
    try:
        shot_resp = await api_call("GET", "/screenshot", api_base=api_base)
        shot_path = _save_screenshot(shot_resp.get("base64", ""))
    except Exception:
        shot_path = "(no screenshot)"
    return "Reached max steps ({}). Last screenshot: {}\n\n{}".format(
        max_steps, shot_path, _format_steps_log(steps_log),
    )


@mcp.tool(tags={"journey"})
async def navvi_login(service: str, persona: str = "default") -> str:
    """Log into a service using stored credentials — use this instead of manually navigating to a login page and calling navvi_creds autofill.

    Give it a service name (e.g. "tuta.com", "github.com") and it reads gopass credentials, navigates to the login page, fills the form, submits, and verifies login success. Handles 2FA by providing a VNC URL for human intervention.

    Example: navvi_login(service="tuta.com", persona="default")

    Requires: an account registered via navvi_account with a creds_ref pointing to a gopass entry.
    """
    pname, api_base = resolve_persona(persona or None)

    # 1. Check if persona has an account for this service
    accounts = list_accounts(pname)
    account = None
    for a in accounts:
        if service.lower() in a["service"].lower():
            account = a
            break

    if not account:
        return (
            "No account found for '{}' on persona '{}'. Use navvi_account to add one first.\n\n"
            "To create a new account, use the signup_flow prompt or spawn the navvi-signup companion agent."
        ).format(service, pname)

    if not account.get("creds_ref"):
        return "Account for '{}' has no credential reference. Update it with navvi_account.".format(service)

    # 2. Navigate to service
    log_persona_action(pname, "login_start", service)
    try:
        await api_call("POST", "/navigate", {"url": "https://{}".format(service)}, api_base)
    except Exception as e:
        return "Failed to navigate to {}: {}".format(service, e)
    await asyncio.sleep(2)

    # 3. Try autofill
    creds_ref = account["creds_ref"].replace("gopass://", "")
    try:
        result = await api_call("POST", "/creds/autofill", {"entry": creds_ref}, api_base)
        if result.get("ok") or result.get("username_at"):
            await asyncio.sleep(0.5)
            # Press Enter to submit
            await api_call("POST", "/key", {"key": "Return"}, api_base)
            await asyncio.sleep(3)

            # Check result
            url_resp = await api_call("GET", "/url", api_base=api_base)
            shot_resp = await api_call("GET", "/screenshot", api_base=api_base)
            shot_path = _save_screenshot(shot_resp.get("base64", ""))

            log_persona_action(pname, "login_complete", "{} -> {}".format(service, url_resp.get("url", "")))
            return (
                "Login attempted for {}.\n"
                "URL: {}\n"
                "Screenshot: {}\n\n"
                "Verify the screenshot to confirm login success. "
                "If 2FA is needed, use navvi_vnc for manual intervention."
            ).format(service, url_resp.get("url", ""), shot_path)
    except Exception as e:
        return (
            "Autofill failed: {}. "
            "The login page may have a non-standard layout. "
            "Try spawning the navvi-login companion agent, or use navvi_browse / atomic tools."
        ).format(e)

    return "Autofill returned no confirmation. Check the page with navvi_screenshot."


# --- Entry point ---


def main():
    """CLI entry point for `uvx navvi` / `navvi` command."""
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()

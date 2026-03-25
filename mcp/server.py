#!/usr/bin/env python3
"""
Navvi MCP Server v2.0.0 — persistent browser personas via Docker containers.

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
from fastmcp import FastMCP

# --- Constants ---

PACKAGE_DIR = os.environ.get("NAVVI_PACKAGE_DIR") or str(Path(__file__).resolve().parent.parent)
REPO = os.environ.get("NAVVI_REPO") or None
MACHINE_TYPE = os.environ.get("NAVVI_MACHINE") or "basicLinux32gb"
NAVVI_PORT = 8024
VNC_PORT = 6080
DOCKER_IMAGE = os.environ.get("NAVVI_IMAGE") or "navvi"
CONTAINER_PREFIX = "navvi-"

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
    version="2.0.0",
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
    ports = get_container_ports(name)
    return name, f"http://127.0.0.1:{ports['api']}"


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

        cname = container_name(persona)

        # Check if already running
        existing = sh(f'docker ps -q --filter "name={cname}" 2>/dev/null')
        if existing:
            ports = get_container_ports(persona)
            reachable = is_api_reachable(ports["api"])
            active_persona = persona
            navvi_api = f"http://127.0.0.1:{ports['api']}"
            health = "healthy" if reachable else "starting..."
            return f"Container {cname} already running.\nAPI: http://127.0.0.1:{ports['api']} ({health})\nVNC: http://127.0.0.1:{ports['vnc']}"

        # Remove stopped container with same name
        sh(f"docker rm {cname} 2>/dev/null")

        # Read persona config
        config = read_persona_yaml(persona)
        locale = config.get("locale", "en-US")
        timezone = config.get("timezone", "UTC")

        # Docker volume for persistent Firefox profile
        volume_name = f"navvi-profile-{persona}"

        # Find ports
        api_port = NAVVI_PORT
        vnc_port = VNC_PORT
        if persona != "default":
            h = 0
            for ch in persona:
                h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
            offset = (h % 100) + 1
            api_port = NAVVI_PORT + offset
            vnc_port = VNC_PORT + offset

        docker_args = [
            "run", "-d",
            "--name", cname,
            "-p", f"{api_port}:8024",
            "-p", f"{vnc_port}:6080",
            "-v", f"{volume_name}:/home/user/.mozilla",
            "-e", f"LOCALE={locale}",
            "-e", f"TIMEZONE={timezone}",
            DOCKER_IMAGE,
        ]

        result = sh(f"docker {' '.join(docker_args)}")
        if "Error" in result or "error" in result:
            return f"Failed to start container:\n{result}\n\nMake sure the image is built: docker build -t navvi container/"

        # Wait for API
        active_persona = persona
        navvi_api = f"http://127.0.0.1:{api_port}"

        ready = False
        for _ in range(15):
            await asyncio.sleep(1)
            if is_api_reachable(api_port):
                ready = True
                break

        set_mode("local")
        health = "healthy" if ready else "starting..."
        return (
            f"Navvi started ({persona}).\n"
            f"Container: {cname}\n"
            f"API: http://127.0.0.1:{api_port} ({health})\n"
            f"VNC: http://127.0.0.1:{vnc_port}\n"
            f"Volume: {volume_name} (persistent Firefox profile)\n\n"
            f"Use navvi_open to navigate, navvi_screenshot to see the page."
        )

    if mode == "remote":
        if not REPO:
            return 'Error: remote mode requires NAVVI_REPO env var (e.g. "Fellowship-dev/navvi"). Set it in your MCP config.'
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

        return f"Navvi started (remote). Codespace: {cs_name}\nAPI: localhost:{NAVVI_PORT} ({health})\nVNC: localhost:{VNC_PORT}"

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


@mcp.tool()
async def navvi_open(url: str, persona: str = "") -> str:
    """Navigate to a URL in the active browser. After navigating, use navvi_find to locate elements on the page, then navvi_click/navvi_fill to interact."""
    _, api_base = resolve_persona(persona or None)
    log_action("open", url)
    try:
        result = await api_call("POST", "/navigate", {"url": url}, api_base)
        title = result.get("title", "(loading...)")
        final_url = result.get("url", url)
        return f"Opened {url}\nTitle: {title}\nURL: {final_url}"
    except Exception as e:
        return f"Error navigating: {e}"


@mcp.tool()
async def navvi_click(x: int, y: int, persona: str = "") -> str:
    """Click at (x, y) screen coordinates using OS-level xdotool input (isTrusted: true). IMPORTANT: Use navvi_find to get coordinates -- it returns screen-ready (x, y) values. Do NOT use raw JS getBoundingClientRect() -- those are viewport coords that miss the browser chrome offset."""
    _, api_base = resolve_persona(persona or None)
    log_action("click", f"({x}, {y})")
    try:
        await api_call("POST", "/click", {"x": x, "y": y}, api_base)
        return f"Clicked at ({x}, {y})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def navvi_fill(x: int, y: int, value: str, delay: int = 12, persona: str = "") -> str:
    """Click at (x, y) to focus an input field, then type text using OS-level xdotool. Get coordinates from navvi_find first. Selects existing text (Ctrl+A) before typing to replace any current value."""
    _, api_base = resolve_persona(persona or None)
    fill_duration_ms = len(value) * delay
    log_action("fill", {"x": x, "y": y, "text": value, "durationMs": fill_duration_ms})
    try:
        # Click to focus
        await api_call("POST", "/click", {"x": x, "y": y}, api_base)
        await asyncio.sleep(0.1)
        # Type
        await api_call("POST", "/type", {"text": value, "delay": delay}, api_base)
        return f'Filled at ({x}, {y}) with "{value}" ({len(value)} chars)'
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def navvi_press(key: str, persona: str = "") -> str:
    """Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown, etc.). Sends to currently focused element."""
    _, api_base = resolve_persona(persona or None)
    log_action("press", key)
    try:
        await api_call("POST", "/key", {"key": key}, api_base)
        return f"Pressed {key}"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
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


@mcp.tool()
async def navvi_mousedown(x: int, y: int, persona: str = "") -> str:
    """Press and hold mouse button at (x, y). Pair with navvi_mouseup for press-and-hold CAPTCHAs. Get coordinates from navvi_find. WARNING: Arkose Labs/FunCaptcha (Microsoft, Yahoo) cannot be solved inside the container even by a human -- the virtual display is fingerprinted. If you detect arkoselabs/funcaptcha in the page, stop and tell the user to use a real browser for that signup."""
    _, api_base = resolve_persona(persona or None)
    log_action("mousedown", f"({x}, {y})")
    try:
        await api_call("POST", "/mousedown", {"x": x, "y": y}, api_base)
        return f"Mouse down at ({x}, {y})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def navvi_mouseup(x: int, y: int, persona: str = "") -> str:
    """Release mouse button at (x, y). Pair with navvi_mousedown."""
    _, api_base = resolve_persona(persona or None)
    log_action("mouseup", f"({x}, {y})")
    try:
        await api_call("POST", "/mouseup", {"x": x, "y": y}, api_base)
        return f"Mouse up at ({x}, {y})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
async def navvi_mousemove(x: int, y: int, persona: str = "") -> str:
    """Move mouse to (x, y) without clicking. Useful for hover effects."""
    _, api_base = resolve_persona(persona or None)
    log_action("mousemove", f"({x}, {y})")
    try:
        await api_call("POST", "/mousemove", {"x": x, "y": y}, api_base)
        return f"Mouse moved to ({x}, {y})"
    except Exception as e:
        return f"Error: {e}"


@mcp.tool()
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


@mcp.tool()
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
    p = persona or active_persona or "default"
    ports = get_container_ports(p)
    return (
        f"noVNC: http://127.0.0.1:{ports['vnc']}/vnc.html?autoconnect=true\n\n"
        f"Open this URL in a browser for live view. Use for:\n"
        f"- Human CAPTCHA solving\n"
        f"- OAuth login flows\n"
        f"- Visual debugging"
    )


@mcp.tool()
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


@mcp.tool()
async def navvi_creds(
    action: str,
    entry: str = "",
    field: str = "",
    username_selector: str = "",
    password_selector: str = "",
    persona: str = "",
) -> str:
    """Manage credentials stored in gopass inside the container. Three actions: "list" shows available entries (no secrets), "get" retrieves a non-secret field (username, url, email -- refuses password), "autofill" reads gopass and fills the login form directly -- the password goes from gopass -> xdotool -> browser, NEVER appearing in this response. Use autofill after navvi_open navigates to a login page."""
    _, api_base = resolve_persona(persona or None)

    if action == "list":
        try:
            result = await api_call("GET", "/creds/list", api_base=api_base)
            entries = result.get("entries", [])
            if not entries:
                return "No credentials stored in gopass. Use gopass to add entries."
            output = f"Credentials ({result.get('count', len(entries))} entries):\n"
            for e in entries:
                output += f"  {e}\n"
            return output
        except Exception as e:
            return f"Error: {e}"

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

    if action == "autofill":
        if not entry:
            return 'Error: "entry" is required for autofill action.'
        log_action("autofill", entry)
        try:
            params = {"entry": entry}
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

    return 'Error: action must be "list", "get", or "autofill".'


@mcp.tool()
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


@mcp.tool()
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


@mcp.tool()
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


# --- Entry point ---

if __name__ == "__main__":
    mcp.run(transport="stdio")

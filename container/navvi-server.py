"""
Navvi API Server — FastAPI REST endpoints for browser automation.

Runs inside the container. Controls Camoufox (anti-detect Firefox) via:
  - xdotool (OS-level mouse/keyboard — isTrusted: true events)
  - scrot (screenshots)
  - marionette.py (navigate, getURL, getTitle, executeJS via Marionette protocol)
"""

import argparse
import asyncio
import base64
import os
import re
import shlex
import subprocess
import tempfile

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional

from marionette import Marionette, MarionetteError

import logging
import signal
import time

app = FastAPI(title="Navvi Server", version="3.0.0")
log = logging.getLogger("navvi-server")

# --- Globals ---

display: str = ":1"
BASE_MARIONETTE_PORT = 2828

# Single Marionette instance — one Firefox per container (since v3.15).
# Multi-persona is handled by running separate containers, not separate
# Firefox processes inside one container.
_marionette: Optional[Marionette] = None
_firefox_pid: int = 0
_recovering: bool = False  # prevents re-entrant recovery


def _is_zombie() -> bool:
    """Check if Marionette is in zombie state (accepts TCP, returns empty bytes).

    This happens when a previous client disconnected uncleanly — Marionette
    locks up but Firefox is still alive.
    """
    probe = Marionette(port=BASE_MARIONETTE_PORT)
    return not probe.probe()


def _restart_firefox():
    """Kill Firefox and restart it. Profile persists on disk.

    Marionette is single-client — when it goes zombie, the only fix is
    restarting the Firefox process. We use SIGTERM first for a graceful
    shutdown (flushes cookies/IndexedDB), then SIGKILL as fallback.
    """
    global _marionette, _firefox_pid, _recovering

    if _recovering:
        log.warning("[recovery] Already in progress, skipping")
        return
    _recovering = True

    try:
        log.warning("[recovery] Restarting Firefox (zombie Marionette detected)")

        # Close our stale Marionette socket
        if _marionette:
            _marionette.close()
            _marionette = None

        # Kill Firefox gracefully, then force
        subprocess.run(["pkill", "-TERM", "camoufox-bin"], timeout=3, capture_output=True)
        for _ in range(10):
            result = subprocess.run(
                ["pgrep", "-f", "camoufox-bin"],
                capture_output=True, timeout=3,
            )
            if result.returncode != 0:
                break
            time.sleep(1)
        else:
            subprocess.run(["pkill", "-9", "camoufox-bin"], timeout=3, capture_output=True)
            time.sleep(1)

        # Restart Firefox with same flags as start.sh
        env = os.environ.copy()
        env["DISPLAY"] = display
        proc = subprocess.Popen(
            ["camoufox-bin", "--marionette", "--no-remote", "about:blank"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        _firefox_pid = proc.pid
        log.warning("[recovery] Firefox restarted (PID %d), waiting for Marionette...", _firefox_pid)

        # Wait for Marionette to become available
        time.sleep(3)

        # Re-maximize the window
        try:
            subprocess.run(
                ["bash", "-c",
                 'WID=$(xdotool search --onlyvisible --class "firefox|Navigator|camoufox" 2>/dev/null | head -1); '
                 '[ -n "$WID" ] && xdotool windowactivate "$WID" windowsize "$WID" 1920 1080 windowmove "$WID" 0 0'],
                env=env, capture_output=True, timeout=5,
            )
        except Exception:
            pass

        # Reconnect Marionette
        _marionette = Marionette(port=BASE_MARIONETTE_PORT)
        _marionette.connect(retries=15, delay=1.0)
        _marionette.new_session()
        log.warning("[recovery] Marionette reconnected successfully")
    except Exception as e:
        log.error("[recovery] Failed to restart Firefox: %s", e)
        _marionette = None
        raise
    finally:
        _recovering = False


def _get_or_reconnect() -> Marionette:
    """Return the single Marionette client, reconnecting if needed.

    If the connection is dead AND Marionette is in zombie state, triggers
    a full Firefox restart before reconnecting.
    """
    global _marionette
    if _marionette:
        try:
            _marionette.get_url()
            return _marionette
        except Exception:
            _marionette.close()
            _marionette = None

    # Before attempting a fresh connect, check for zombie state
    if _is_zombie():
        _restart_firefox()
        return _marionette

    _marionette = Marionette(port=BASE_MARIONETTE_PORT)
    _marionette.connect()
    _marionette.new_session()
    return _marionette


def _with_marionette_retry(fn):
    """Call fn() with the Marionette client. On failure, recover and retry once."""
    try:
        m = get_marionette()
        return fn(m)
    except (MarionetteError, Exception) as first_err:
        log.warning("[retry] Marionette call failed (%s), attempting recovery...", first_err)
        try:
            _restart_firefox()
            m = get_marionette()
            return fn(m)
        except Exception as retry_err:
            raise MarionetteError(f"Failed after recovery: {retry_err}") from first_err


# --- Pydantic models ---

class NavigateRequest(BaseModel):
    url: str

class ClickRequest(BaseModel):
    x: int
    y: int

class TypeRequest(BaseModel):
    text: str
    delay: int = 12  # ms between chars

class KeyRequest(BaseModel):
    key: str

class MouseRequest(BaseModel):
    x: int
    y: int

class DragRequest(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int
    steps: int = 20
    duration: float = 0.3  # seconds for the full drag

class ScrollRequest(BaseModel):
    direction: str = "down"  # up, down, left, right
    amount: int = 3

class ExecuteJSRequest(BaseModel):
    script: str
    args: list = []

class FindRequest(BaseModel):
    selector: str
    all: bool = False  # return all matches vs just the first

class TabNewRequest(BaseModel):
    url: str = ""


class CredsAutofillRequest(BaseModel):
    entry: str  # gopass entry path, e.g. "navvi/default/tuta"
    username_selector: str = "input[type=email], input[type=text], input[name*=user i], input[name*=email i], input[name*=login i]"
    password_selector: str = "input[type=password]"

class CredsGetRequest(BaseModel):
    entry: str
    field: str  # e.g. "username", "url", "email" — NOT "password"

class CredsGenerateRequest(BaseModel):
    entry: str  # gopass entry path, e.g. "navvi/fry-lobster/hn"
    username: str  # username to store alongside the generated password
    length: int = 24  # password length

class CredsImportEntry(BaseModel):
    entry: str
    username: str
    password: str

class CredsImportRequest(BaseModel):
    credentials: list[CredsImportEntry]


# --- Helpers ---

def run_xdotool(args: str, timeout: float = 5.0) -> str:
    """Run an xdotool command and return stdout."""
    # Clamp negative coordinates — xdotool interprets them as flags
    if "mousemove" in args:
        parts = args.split()
        clamped = []
        for p in parts:
            try:
                n = int(p)
                clamped.append(str(max(0, n)))
            except ValueError:
                clamped.append(p)
        args = " ".join(clamped)
    env = os.environ.copy()
    env["DISPLAY"] = display
    result = subprocess.run(
        f"xdotool {args}",
        shell=True,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )
    if result.returncode != 0 and result.stderr:
        raise RuntimeError(f"xdotool error: {result.stderr.strip()}")
    return result.stdout.strip()


def get_marionette(persona: Optional[str] = None) -> Marionette:
    """Get the single Marionette client. persona param is ignored (kept for API compat)."""
    return _get_or_reconnect()


# xdotool key name mapping (browser key names → xdotool names)
KEY_MAP = {
    "Enter": "Return",
    "Backspace": "BackSpace",
    "ArrowUp": "Up",
    "ArrowDown": "Down",
    "ArrowLeft": "Left",
    "ArrowRight": "Right",
    "Escape": "Escape",
    "Tab": "Tab",
    "Delete": "Delete",
    "Home": "Home",
    "End": "End",
    "PageUp": "Prior",
    "PageDown": "Next",
    "Space": "space",
    " ": "space",
}


# --- Endpoints ---

@app.get("/health")
async def health():
    """Check Camoufox + Xvfb are alive. Auto-recovers from Marionette zombie state."""
    checks = {"xvfb": False, "firefox": False, "marionette": False, "zombie_recovered": False}

    # Check Xvfb
    try:
        result = subprocess.run(
            ["xdpyinfo", "-display", display],
            capture_output=True, timeout=3
        )
        checks["xvfb"] = result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        # xdpyinfo may not be installed; check if Xvfb process exists
        try:
            subprocess.run(
                ["pgrep", "-f", f"Xvfb {display}"],
                capture_output=True, timeout=3
            )
            checks["xvfb"] = True
        except Exception:
            pass

    # Check Camoufox process
    try:
        result = subprocess.run(
            ["pgrep", "-f", "camoufox"],
            capture_output=True, timeout=3
        )
        checks["firefox"] = result.returncode == 0
    except Exception:
        pass

    # Check Marionette connection
    try:
        m = get_marionette()
        m.get_url()
        checks["marionette"] = True
    except Exception:
        # Firefox alive but Marionette dead = likely zombie. Try recovery.
        if checks["firefox"] and _is_zombie():
            try:
                _restart_firefox()
                checks["marionette"] = True
                checks["zombie_recovered"] = True
                checks["firefox"] = True  # new process
                log.warning("[health] Zombie state recovered")
            except Exception as e:
                log.error("[health] Recovery failed: %s", e)
        # If Firefox is dead entirely, Marionette can't work either
        pass

    ok = checks["xvfb"] and checks["firefox"] and checks["marionette"]
    return {"ok": ok, **checks}


@app.post("/navigate")
async def navigate(req: NavigateRequest):
    """Navigate to a URL via Marionette."""
    try:
        def _nav_and_read(m):
            m.navigate(req.url)
            return m
        _with_marionette_retry(_nav_and_read)
        # Give the page a moment to start loading
        await asyncio.sleep(0.5)
        result = _with_marionette_retry(lambda m: {"url": m.get_url(), "title": m.get_title()})
        return {"ok": True, **result}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/url")
async def get_url():
    """Get current page URL."""
    try:
        url = _with_marionette_retry(lambda m: m.get_url())
        return {"url": url}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/title")
async def get_title():
    """Get current page title."""
    try:
        title = _with_marionette_retry(lambda m: m.get_title())
        return {"title": title}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/click")
async def click(req: ClickRequest):
    """Click at (x, y) using xdotool."""
    run_xdotool(f"mousemove {req.x} {req.y}")
    await asyncio.sleep(0.05)
    run_xdotool("click 1")
    return {"ok": True, "x": req.x, "y": req.y}


@app.post("/type")
async def type_text(req: TypeRequest):
    """Type text using xdotool, chunked at 50 chars."""
    text = req.text
    chunk_size = 50
    for i in range(0, len(text), chunk_size):
        chunk = text[i:i + chunk_size]
        # Escape for shell safety
        safe_chunk = shlex.quote(chunk)
        run_xdotool(f"type --delay {req.delay} -- {safe_chunk}", timeout=30.0)
    return {"ok": True, "length": len(text)}


@app.post("/key")
async def press_key(req: KeyRequest):
    """Press a key using xdotool."""
    key = KEY_MAP.get(req.key, req.key)
    run_xdotool(f"key {shlex.quote(key)}")
    return {"ok": True, "key": key}


@app.post("/mousedown")
async def mousedown(req: MouseRequest):
    """Move to (x, y) and press mouse button down."""
    run_xdotool(f"mousemove {req.x} {req.y}")
    await asyncio.sleep(0.05)
    run_xdotool("mousedown 1")
    return {"ok": True, "x": req.x, "y": req.y}


@app.post("/mouseup")
async def mouseup(req: MouseRequest):
    """Move to (x, y) and release mouse button."""
    run_xdotool(f"mousemove {req.x} {req.y}")
    await asyncio.sleep(0.05)
    run_xdotool("mouseup 1")
    return {"ok": True, "x": req.x, "y": req.y}


class HoldRequest(BaseModel):
    x: int
    y: int
    duration_ms: int = 5000

@app.post("/hold")
async def hold(req: HoldRequest):
    """Press and hold at (x, y) for duration_ms milliseconds. For CAPTCHAs."""
    run_xdotool(f"mousemove {req.x} {req.y}")
    await asyncio.sleep(0.05)
    run_xdotool("mousedown 1")
    await asyncio.sleep(req.duration_ms / 1000.0)
    run_xdotool("mouseup 1")
    return {"ok": True, "x": req.x, "y": req.y, "duration_ms": req.duration_ms}


@app.post("/mousemove")
async def mousemove(req: MouseRequest):
    """Move mouse to (x, y)."""
    run_xdotool(f"mousemove {req.x} {req.y}")
    return {"ok": True, "x": req.x, "y": req.y}


@app.post("/drag")
async def drag(req: DragRequest):
    """Drag from (x1,y1) to (x2,y2) with interpolated mouse moves."""
    steps = max(req.steps, 2)
    step_delay = req.duration / steps

    # Move to start and press
    run_xdotool(f"mousemove {req.x1} {req.y1}")
    await asyncio.sleep(0.05)
    run_xdotool("mousedown 1")
    await asyncio.sleep(0.05)

    # Interpolate path
    for i in range(1, steps + 1):
        t = i / steps
        cx = int(req.x1 + (req.x2 - req.x1) * t)
        cy = int(req.y1 + (req.y2 - req.y1) * t)
        run_xdotool(f"mousemove {cx} {cy}")
        await asyncio.sleep(step_delay)

    # Release
    run_xdotool("mouseup 1")
    return {"ok": True, "from": [req.x1, req.y1], "to": [req.x2, req.y2]}


@app.post("/scroll")
async def scroll(req: ScrollRequest):
    """Scroll using xdotool button clicks (4=up, 5=down, 6=left, 7=right)."""
    button_map = {"up": 4, "down": 5, "left": 6, "right": 7}
    button = button_map.get(req.direction)
    if button is None:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid direction: {req.direction}. Use up/down/left/right."
        )
    run_xdotool(f"click --repeat {req.amount} {button}")
    return {"ok": True, "direction": req.direction, "amount": req.amount}


@app.get("/screenshot")
async def screenshot():
    """Take a screenshot with scrot and return base64 PNG."""
    env = os.environ.copy()
    env["DISPLAY"] = display
    tmp_path = os.path.join(tempfile.gettempdir(), "navvi-shot.png")

    result = subprocess.run(
        ["scrot", "-o", "-p", tmp_path],
        capture_output=True, timeout=5, env=env
    )
    if result.returncode != 0:
        raise HTTPException(
            status_code=500,
            detail=f"scrot failed: {result.stderr.decode().strip()}"
        )

    with open(tmp_path, "rb") as f:
        img_data = f.read()

    b64 = base64.b64encode(img_data).decode("ascii")
    return {"ok": True, "base64": b64, "size": len(img_data)}


@app.get("/cursor")
async def cursor():
    """Get current mouse position."""
    output = run_xdotool("getmouselocation --shell")
    # Parse: X=123\nY=456\nSCREEN=0\nWINDOW=...
    pos = {}
    for line in output.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            pos[k.lower()] = int(v) if v.isdigit() else v
    return {"ok": True, "x": pos.get("x", 0), "y": pos.get("y", 0)}


@app.post("/execute")
async def execute_js(req: ExecuteJSRequest):
    """Execute JavaScript in Firefox via Marionette."""
    try:
        result = _with_marionette_retry(lambda m: m.execute_script(req.script, req.args))
        return {"ok": True, "value": result}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


def get_viewport_offset():
    """Get the pixel offset from screen origin to Firefox's content viewport.

    JS getBoundingClientRect() returns coords relative to the viewport.
    xdotool works with absolute screen coords. The difference is the
    browser chrome (tab bar, address bar, notification banners).

    Firefox exposes this via mozInnerScreenX/Y — the screen position
    of the top-left corner of the viewport.
    """
    try:
        result = _with_marionette_retry(lambda m: m.execute_script(
            "return { x: window.mozInnerScreenX || 0, y: window.mozInnerScreenY || 0 }"
        ))
        return (int(result.get("x", 0)), int(result.get("y", 0)))
    except Exception:
        return (0, 0)


@app.get("/viewport")
async def viewport():
    """Get viewport offset — the translation between JS coordinates and screen coordinates.

    Returns the pixel offset from screen origin to the browser content area.
    Add these values to any getBoundingClientRect() coordinates before
    passing them to click/mousedown/etc.
    """
    offset_x, offset_y = get_viewport_offset()
    try:
        dims = _with_marionette_retry(lambda m: m.execute_script(
            "return { innerWidth: window.innerWidth, innerHeight: window.innerHeight }"
        ))
    except Exception:
        dims = {}
    return {
        "ok": True,
        "offset_x": offset_x,
        "offset_y": offset_y,
        "viewport_width": dims.get("innerWidth", 0),
        "viewport_height": dims.get("innerHeight", 0),
    }


@app.post("/find")
async def find_element(req: FindRequest):
    """Find element(s) by CSS selector and return screen-ready coordinates.

    Unlike raw executeJS + getBoundingClientRect(), this endpoint
    auto-translates viewport coordinates to screen coordinates by adding
    the browser chrome offset. The returned x/y can be passed directly
    to /click, /mousedown, etc.
    """
    try:
        offset_x, offset_y = get_viewport_offset()

        if req.all:
            script = """
                const els = document.querySelectorAll(arguments[0]);
                return Array.from(els).slice(0, 50).map(el => {
                    const r = el.getBoundingClientRect();
                    return {
                        tag: el.tagName,
                        id: el.id || '',
                        name: el.name || el.getAttribute('name') || '',
                        type: el.type || '',
                        role: el.getAttribute('role') || '',
                        text: (el.textContent || '').trim().slice(0, 80),
                        value: (el.value || '').slice(0, 80),
                        placeholder: el.placeholder || '',
                        ariaLabel: el.getAttribute('aria-label') || '',
                        visible: r.width > 0 && r.height > 0,
                        vx: Math.round(r.x + r.width / 2),
                        vy: Math.round(r.y + r.height / 2),
                        width: Math.round(r.width),
                        height: Math.round(r.height),
                    };
                });
            """
            elements = _with_marionette_retry(lambda m: m.execute_script(script, [req.selector]))
            if not elements:
                return {"ok": True, "found": False, "elements": []}
            # Apply screen offset
            for el in elements:
                el["x"] = el.pop("vx") + offset_x
                el["y"] = el.pop("vy") + offset_y
            return {"ok": True, "found": True, "count": len(elements), "elements": elements}
        else:
            script = """
                const el = document.querySelector(arguments[0]);
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {
                    tag: el.tagName,
                    id: el.id || '',
                    name: el.name || el.getAttribute('name') || '',
                    type: el.type || '',
                    role: el.getAttribute('role') || '',
                    text: (el.textContent || '').trim().slice(0, 80),
                    value: (el.value || '').slice(0, 80),
                    placeholder: el.placeholder || '',
                    ariaLabel: el.getAttribute('aria-label') || '',
                    visible: r.width > 0 && r.height > 0,
                    vx: Math.round(r.x + r.width / 2),
                    vy: Math.round(r.y + r.height / 2),
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                };
            """
            el = _with_marionette_retry(lambda m: m.execute_script(script, [req.selector]))
            if not el:
                return {"ok": True, "found": False}
            el["x"] = el.pop("vx") + offset_x
            el["y"] = el.pop("vy") + offset_y
            return {"ok": True, "found": True, **el}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Tab management ---

@app.get("/tab/list")
async def tab_list():
    """List all tabs with handle, url, and title."""
    try:
        m = get_marionette()
        original_handle = m.get_window_handle()
        handles = m.get_window_handles()
        tabs = []
        for h in handles:
            m.switch_to_window(h)
            tabs.append({
                "handle": h,
                "url": m.get_url(),
                "title": m.get_title(),
            })
        # Switch back to original tab
        m.switch_to_window(original_handle)
        return {"ok": True, "tabs": tabs, "count": len(tabs), "active": original_handle}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tab/new")
async def tab_new(req: TabNewRequest):
    """Open a new tab, optionally navigate to a URL. Switches to the new tab."""
    try:
        m = get_marionette()
        result = m.new_window("tab")
        handle = result.get("handle", "")
        m.switch_to_window(handle)
        if req.url:
            m.navigate(req.url)
            await asyncio.sleep(0.5)
        url = m.get_url()
        title = m.get_title()
        return {"ok": True, "handle": handle, "url": url, "title": title}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tab/switch/{handle}")
async def tab_switch(handle: str):
    """Switch to a tab by handle. Returns url and title of the switched-to tab."""
    try:
        m = get_marionette()
        m.switch_to_window(handle)
        url = m.get_url()
        title = m.get_title()
        return {"ok": True, "handle": handle, "url": url, "title": title}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tab/close/{handle}")
async def tab_close(handle: str):
    """Close a tab by handle. Cannot close the last tab."""
    try:
        m = get_marionette()
        handles = m.get_window_handles()
        if len(handles) <= 1:
            raise HTTPException(status_code=400, detail="Cannot close the last tab")
        m.switch_to_window(handle)
        remaining = m.close_window()
        # Switch to first remaining tab
        if remaining:
            m.switch_to_window(remaining[0])
            url = m.get_url()
            title = m.get_title()
            return {"ok": True, "closed": handle, "active": remaining[0], "url": url, "title": title, "remaining": len(remaining)}
        return {"ok": True, "closed": handle, "remaining": 0}
    except HTTPException:
        raise
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Credential management (gopass) ---

def run_gopass(args: str, timeout: float = 5.0) -> str:
    """Run a gopass command and return stdout."""
    result = subprocess.run(
        f"gopass {args}",
        shell=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"gopass failed: {result.returncode}")
    return result.stdout.strip()


@app.get("/creds/list")
async def creds_list():
    """List all credential entries (names only, no secrets)."""
    try:
        output = run_gopass("ls --flat")
        entries = [e for e in output.splitlines() if e.strip()]
        return {"ok": True, "entries": entries, "count": len(entries)}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/creds/get")
async def creds_get(req: CredsGetRequest):
    """Get a specific non-secret field from a gopass entry.

    Returns metadata fields like username, url, email.
    Refuses to return the password field — use /creds/autofill instead.
    """
    blocked = {"password", "pass", "secret", "token", "key", "recovery"}
    if req.field.lower() in blocked:
        raise HTTPException(
            status_code=403,
            detail=f"Field '{req.field}' is a secret — use /creds/autofill to fill it into the browser without exposing it."
        )
    try:
        value = run_gopass(f"show {shlex.quote(req.entry)} {shlex.quote(req.field)}")
        return {"ok": True, "entry": req.entry, "field": req.field, "value": value}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/creds/autofill")
async def creds_autofill(req: CredsAutofillRequest):
    """Autofill a login form using gopass credentials.

    Reads username and password from gopass, finds the form fields
    via CSS selectors, and types them using xdotool. The password
    NEVER appears in the API response — it goes directly from
    gopass → xdotool → browser.
    """
    try:
        # Read credentials from gopass (server-side only, never returned)
        # Try email first (most login forms want full email), fall back to username
        username = ""
        for field in ["email", "username", "login", "user"]:
            try:
                username = run_gopass(f"show {shlex.quote(req.entry)} {field}")
                if username:
                    break
            except RuntimeError:
                continue
        password = run_gopass(f"show -o {shlex.quote(req.entry)}")
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=f"gopass error: {e}")

    if not password:
        raise HTTPException(status_code=404, detail=f"Entry '{req.entry}' has no password")

    # Find form fields
    try:
        offset_x, offset_y = get_viewport_offset()

        find_script = """
            const el = document.querySelector(arguments[0]);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
                x: Math.round(r.x + r.width / 2),
                y: Math.round(r.y + r.height / 2),
                visible: r.width > 0 && r.height > 0,
            };
        """

        # Find username field (optional — may not exist on password-only pages)
        username_el = None
        if username:
            username_el = _with_marionette_retry(lambda m: m.execute_script(find_script, [req.username_selector]))
            if username_el and not username_el.get("visible"):
                username_el = None

        # Find password field
        password_el = _with_marionette_retry(lambda m: m.execute_script(find_script, [req.password_selector]))
        if not password_el or not password_el.get("visible"):
            raise HTTPException(status_code=404, detail=f"Password field not found: {req.password_selector}")

        px, py = password_el["x"] + offset_x, password_el["y"] + offset_y
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=f"Browser error: {e}")

    username_filled = False
    ux, uy = 0, 0

    # Fill username (if field found and username available)
    if username_el and username:
        ux, uy = username_el["x"] + offset_x, username_el["y"] + offset_y
        run_xdotool(f"mousemove {ux} {uy}")
        await asyncio.sleep(0.05)
        run_xdotool("click 1")
        await asyncio.sleep(0.1)
        run_xdotool("key ctrl+a")
        await asyncio.sleep(0.05)
        safe_user = shlex.quote(username)
        run_xdotool(f"type --delay 15 -- {safe_user}", timeout=15.0)
        await asyncio.sleep(0.3)
        username_filled = True

    # Fill password (never logged, never returned)
    run_xdotool(f"mousemove {px} {py}")
    await asyncio.sleep(0.05)
    run_xdotool("click 1")
    await asyncio.sleep(0.1)
    run_xdotool("key ctrl+a")
    await asyncio.sleep(0.05)
    safe_pass = shlex.quote(password)
    run_xdotool(f"type --delay 15 -- {safe_pass}", timeout=15.0)

    # Scrub password from memory
    del password
    del safe_pass

    return {
        "ok": True,
        "entry": req.entry,
        "username_filled": username_filled,
        "password_filled": True,
        "username_at": [ux, uy] if username_filled else [],
        "password_at": [px, py],
        "note": "Password was typed directly into the browser — it never appeared in this response."
    }


@app.post("/creds/generate")
async def creds_generate(req: CredsGenerateRequest):
    """Generate a random password inside the container and store it in gopass.

    The password is NEVER returned in the response — it goes directly into
    gopass and can only reach the browser via /creds/autofill.
    """
    if req.length < 12 or req.length > 128:
        raise HTTPException(status_code=400, detail="Length must be between 12 and 128")

    # Check if entry already exists
    try:
        existing = run_gopass("ls --flat")
        if req.entry in existing.splitlines():
            raise HTTPException(status_code=409, detail=f"Entry '{req.entry}' already exists. Delete it first or use a different name.")
    except RuntimeError:
        pass  # Empty store, that's fine

    try:
        # Generate password (cryptic, no symbols — better form compat)
        # gopass generate creates the entry with a random password
        run_gopass(f"generate -f {shlex.quote(req.entry)} {req.length}", timeout=10.0)

        # Add username as a named field
        # gopass insert appends key-value pairs below the password line
        proc = subprocess.run(
            f"echo 'username: {shlex.quote(req.username)}' | gopass insert -a {shlex.quote(req.entry)}",
            shell=True, capture_output=True, text=True, timeout=10,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip())

        return {
            "ok": True,
            "entry": req.entry,
            "length": req.length,
            "username": req.username,
            "note": "Password generated and stored in gopass. It was NOT included in this response. Use /creds/autofill to fill it into a form."
        }
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=f"gopass error: {e}")


@app.post("/creds/import")
async def creds_import(req: CredsImportRequest):
    """Import credentials into gopass. Passwords appear briefly in the request
    body (localhost only) but are NEVER echoed back in the response.
    """
    if not req.credentials:
        raise HTTPException(status_code=400, detail="No credentials provided")

    imported = 0
    errors = []

    for cred in req.credentials:
        try:
            # Create entry with password on first line + username field
            payload = f"{cred.password}\nusername: {cred.username}"
            proc = subprocess.run(
                f"echo {shlex.quote(payload)} | gopass insert -m {shlex.quote(cred.entry)}",
                shell=True, capture_output=True, text=True, timeout=10,
            )
            if proc.returncode != 0:
                errors.append({"entry": cred.entry, "error": proc.stderr.strip()})
            else:
                imported += 1
        except Exception as e:
            errors.append({"entry": cred.entry, "error": str(e)})

    result = {"ok": len(errors) == 0, "imported": imported}
    if errors:
        result["errors"] = errors
    return result


# --- Startup ---

def main():
    import uvicorn

    parser = argparse.ArgumentParser(description="Navvi API Server")
    parser.add_argument("--port", type=int, default=8024)
    parser.add_argument("--display", type=str, default=":1")
    args = parser.parse_args()

    global display
    display = args.display

    # Connect to the single Firefox instance (started by start.sh on port 2828)
    global _marionette, _firefox_pid
    try:
        result = subprocess.run(
            ["pgrep", "-f", "camoufox-bin.*--marionette"],
            capture_output=True, text=True, timeout=3,
        )
        _firefox_pid = int(result.stdout.strip().split("\n")[0]) if result.stdout.strip() else 0
        _marionette = Marionette(port=BASE_MARIONETTE_PORT)
        _marionette.connect()
        _marionette.new_session()
        print("[navvi-server] Connected to Firefox (Marionette :{}, PID {})".format(BASE_MARIONETTE_PORT, _firefox_pid))
    except Exception as e:
        print("[navvi-server] WARNING: Could not connect to Firefox: {}".format(e))
        print("[navvi-server] Will retry on first request")

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

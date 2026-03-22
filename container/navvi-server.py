"""
Navvi API Server — FastAPI REST endpoints for browser automation.

Runs inside the container. Controls Firefox via:
  - xdotool (OS-level mouse/keyboard — isTrusted: true events)
  - scrot (screenshots)
  - marionette.py (navigate, getURL, getTitle, executeJS via Firefox Marionette)
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

app = FastAPI(title="Navvi Server", version="2.0.0")

# --- Globals ---

marionette: Optional[Marionette] = None
display: str = ":1"


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


# --- Helpers ---

def run_xdotool(args: str, timeout: float = 5.0) -> str:
    """Run an xdotool command and return stdout."""
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


def get_marionette() -> Marionette:
    """Get or reconnect the Marionette client."""
    global marionette
    if marionette is None:
        marionette = Marionette()
        marionette.connect()
        marionette.new_session()
    return marionette


def reconnect_marionette() -> Marionette:
    """Force reconnect (e.g. after Firefox restart)."""
    global marionette
    if marionette:
        marionette.close()
        marionette = None
    return get_marionette()


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
    """Check Firefox + Xvfb are alive."""
    checks = {"xvfb": False, "firefox": False, "marionette": False}

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

    # Check Firefox process
    try:
        result = subprocess.run(
            ["pgrep", "-f", "firefox"],
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
        pass

    ok = all(checks.values())
    return {"ok": ok, **checks}


@app.post("/navigate")
async def navigate(req: NavigateRequest):
    """Navigate to a URL via Marionette."""
    try:
        m = get_marionette()
        m.navigate(req.url)
        # Give the page a moment to start loading
        await asyncio.sleep(1.0)
        url = m.get_url()
        title = m.get_title()
        return {"ok": True, "url": url, "title": title}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/url")
async def get_url():
    """Get current page URL."""
    try:
        m = get_marionette()
        return {"url": m.get_url()}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/title")
async def get_title():
    """Get current page title."""
    try:
        m = get_marionette()
        return {"title": m.get_title()}
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
        m = get_marionette()
        result = m.execute_script(req.script, req.args)
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
        m = get_marionette()
        result = m.execute_script(
            "return { x: window.mozInnerScreenX || 0, y: window.mozInnerScreenY || 0 }"
        )
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
        m = get_marionette()
        dims = m.execute_script(
            "return { innerWidth: window.innerWidth, innerHeight: window.innerHeight }"
        )
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
        m = get_marionette()
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
            elements = m.execute_script(script, [req.selector])
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
            el = m.execute_script(script, [req.selector])
            if not el:
                return {"ok": True, "found": False}
            el["x"] = el.pop("vx") + offset_x
            el["y"] = el.pop("vy") + offset_y
            return {"ok": True, "found": True, **el}
    except MarionetteError as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Startup ---

def main():
    import uvicorn

    parser = argparse.ArgumentParser(description="Navvi API Server")
    parser.add_argument("--port", type=int, default=8024)
    parser.add_argument("--display", type=str, default=":1")
    args = parser.parse_args()

    global display
    display = args.display

    # Connect to Marionette at startup
    try:
        get_marionette()
        print(f"[navvi-server] Marionette connected")
    except Exception as e:
        print(f"[navvi-server] WARNING: Marionette not ready yet: {e}")
        print("[navvi-server] Will retry on first request")

    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

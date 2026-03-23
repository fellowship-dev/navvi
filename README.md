<p align="center">
  <img src="docs/navvi-logo.png" alt="Navvi" width="120" />
</p>

<h1 align="center">Navvi</h1>

<p align="center">
  <strong>Give your AI agent a real browser identity.</strong>
  <br />
  Persistent browser personas that don't get blocked.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#use-cases">Use Cases</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#mcp-tools">MCP Tools</a>
</p>

---

## The Problem

AI agents need to use the web. But every automation tool gets detected and blocked:

- Selenium, Playwright, Puppeteer &rarr; `navigator.webdriver = true`
- Chrome DevTools Protocol &rarr; detectable protocol markers
- Synthetic events &rarr; `isTrusted: false`

Even "stealth" plugins get flagged by modern bot detection (Arkose Labs, Cloudflare Turnstile, PerimeterX). Your agent can't sign up for accounts, can't fill out forms on protected sites, can't pass CAPTCHAs.

## The Solution

Navvi gives your agent a real browser with real input. No protocol tricks, no stealth patches &mdash; just a Firefox window controlled by OS-level mouse and keyboard, exactly like a human sitting at a desk.

- **Real mouse events** that websites cannot distinguish from a person
- **Persistent identities** &mdash; cookies, logins, and history survive across sessions
- **Live view** &mdash; connect via VNC when your agent needs human help (CAPTCHAs, OAuth)
- **20 MCP tools** &mdash; drop into any Claude Code project

## Use Cases

**Account creation for AI personas.** Sign up for email, dev platforms, social accounts. Fill every form field, handle dropdowns and date pickers, get all the way to the CAPTCHA step undetected.

**Visual evidence for pull requests.** Screenshot your staging app before and after a code change. Record a GIF of a user flow. Attach it to the PR automatically.

**OAuth and login flows.** Log into a service once via VNC, and the session persists in a named volume. Your agent reuses the authenticated browser on every future run.

**Web scraping on protected sites.** Navigate sites that block headless browsers. Your agent sees a real Firefox with a real fingerprint.

**QA and smoke testing.** Point your agent at a form-heavy app and let it click through every flow, filling fields and verifying results.

## Quick Start

```bash
# 1. Build
docker build -t navvi container/

# 2. Start
docker run -d --name navvi-default \
  -p 8024:8024 -p 6080:6080 \
  -v navvi-profile-default:/home/user/.mozilla \
  navvi

# 3. Use (via MCP, CLI, or HTTP)
curl -X POST localhost:8024/navigate -d '{"url":"https://example.com"}'
curl -X POST localhost:8024/find -d '{"selector":"a"}'
curl localhost:8024/screenshot | jq -r .base64 | base64 -d > shot.png
```

Or with Claude Code:

```
navvi_start persona=default
navvi_open url=https://example.com
navvi_find selector="input[type=email]"
navvi_fill x=512 y=498 value="hello@example.com"
navvi_screenshot
```

## How It Works

```
Your AI agent (Claude Code, etc.)
    |
    | MCP tools / HTTP API
    v
+--------------------------------------+
|  Docker container                    |
|                                      |
|  Firefox  <-- Marionette (navigate)  |
|     |                                |
|  Xvfb    <-- xdotool (click, type)  |
|     |                                |
|  x11vnc  --> noVNC (live view)       |
|                                      |
|  navvi-server (REST API on :8024)    |
+--------------------------------------+
    |
    v
  Volume: persistent Firefox profile
```

**Navigation** goes through Firefox Marionette &mdash; a built-in protocol that doesn't expose automation markers.

**All input** goes through xdotool &mdash; OS-level mouse and keyboard events that are indistinguishable from a real user.

**Screenshots** are captured at the display level, not through the browser API.

**Profiles persist** in Docker named volumes. Stop a container, start it again &mdash; you're still logged in.

## MCP Tools

| Tool | What it does |
|------|-------------|
| `navvi_start` | Start a browser container for a persona |
| `navvi_stop` | Stop container (profile preserved) |
| `navvi_open` | Navigate to a URL |
| `navvi_find` | Find element by CSS selector &rarr; screen coordinates |
| `navvi_click` | Click at (x, y) |
| `navvi_fill` | Click + type text into a field |
| `navvi_press` | Press a key (Enter, Tab, Escape...) |
| `navvi_scroll` | Scroll the page |
| `navvi_drag` | Drag from point A to point B |
| `navvi_mousedown` | Press and hold (for CAPTCHAs) |
| `navvi_mouseup` | Release mouse button |
| `navvi_screenshot` | Capture the screen |
| `navvi_vnc` | Get live view URL for human help |
| `navvi_url` | Get current page URL |
| `navvi_record_start` | Start recording a video |
| `navvi_record_stop` | Stop and assemble MP4 |
| `navvi_record_gif` | Convert recording to GIF |

### The Workflow

```
navvi_find("input[type=email]")  -->  { x: 512, y: 498 }
navvi_fill(x=512, y=498, value="me@example.com")
navvi_screenshot()  -->  verify it worked
```

`navvi_find` is the key tool. It finds elements by CSS selector and returns **screen-ready coordinates** that you pass directly to `navvi_click` or `navvi_fill`. No coordinate math required.

### When Your Agent Gets Stuck

Some CAPTCHAs (Arkose Labs, image puzzles) require human eyes. When that happens:

```
navvi_vnc()  -->  http://127.0.0.1:6080/vnc.html?autoconnect=true
```

Send the URL to the user. They solve the CAPTCHA in their browser, your agent continues.

## Personas

Define a persona in `personas/`:

```yaml
name: default
description: Default browser persona
browser:
  locale: en-US
  timezone: America/Santiago
```

Each persona gets its own Docker volume (`navvi-profile-<name>`). Start it, log into your services via VNC, and the session persists forever. Your agent reuses the authenticated browser every time.

## License

Apache 2.0

<p align="center">
  <img src="docs/navvi-logo.png" alt="Navvi" width="120" />
</p>

<h1 align="center">Navvi</h1>

<p align="center">
  <strong>Give your AI agent a real browser identity.</strong>
  <br />
  Persistent browser personas that remember logins, manage credentials, and never get detected.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#use-cases">Use Cases</a> &middot;
  <a href="#how-it-works">How It Works</a> &middot;
  <a href="#mcp-tools">MCP Tools</a>
</p>

---

## The Problem

Every time your AI agent needs to use the web, it starts from scratch. No cookies, no saved passwords, no history. It has to log in again and again &mdash; and half the time the automation gets detected and blocked.

- Agent fills a login form &rarr; site detects Selenium/Playwright &rarr; blocked
- Agent stores a password in a variable &rarr; session ends &rarr; password gone
- Agent tries to reuse a browser &rarr; cookies wiped &rarr; logged out again
- You paste credentials into the chat &rarr; now they're in your conversation history

Your agent has no identity. Every session is a stranger.

## The Solution

Navvi gives your agent a persistent browser with its own identity. A [Camoufox](https://github.com/daijro/camoufox) (anti-detect Firefox) that remembers where it's been, stays logged in, and manages its own credentials &mdash; without ever exposing passwords to the AI.

- **Persistent sessions** &mdash; cookies, logins, and history survive restarts
- **Credential vault** &mdash; passwords stored in [gopass](https://github.com/gopasspw/gopass), auto-filled into forms without the AI ever seeing them
- **Undetectable input** &mdash; OS-level mouse and keyboard events (`isTrusted: true`)
- **Live view** &mdash; VNC link for when a human needs to step in (CAPTCHAs, OAuth, 2FA)
- **21 MCP tools** &mdash; drop into any Claude Code project

## Quick Start

### 1. Build the Docker image

```bash
git clone https://github.com/Fellowship-dev/navvi.git
cd navvi
docker build -t navvi:camoufox -f container/Dockerfile container/
```

### 2. Add to Claude Code

```bash
claude mcp add navvi -- uvx navvi
```

Or add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "navvi": {
      "command": "uvx",
      "args": ["navvi"]
    }
  }
}
```

Restart Claude Code and your agent has 21 browser tools.

### 3. Use

```
navvi_start                                     → spin up a browser
navvi_open url=https://example.com              → navigate
navvi_find selector="input[type=email]"         → locate element → (x, y)
navvi_fill x=512 y=498 value="me@example.com"  → type into it
navvi_screenshot                                → see what happened
```

Or log in using stored credentials (password never visible to the AI):

```
navvi_creds action=list                         → show stored logins
navvi_creds action=autofill entry=default/gmail  → fill username + password
navvi_press key=Enter                           → submit
```

## Use Cases

**Persistent logins.** Log into a service once &mdash; your agent stays logged in across sessions. No more re-entering credentials, no more expired sessions, no more "please log in again."

**Secure credential management.** Passwords live in gopass inside the container. The `autofill` action types them directly into the browser &mdash; the AI never sees the raw password in its context.

**Visual evidence for PRs.** Screenshot your staging app before and after a code change. Record a user flow as a GIF. Attach it to the pull request.

**Form automation on protected sites.** Fill complex forms with dropdowns, date pickers, and multi-step wizards. OS-level input passes bot detection that blocks Selenium and Playwright.

**Human handoff for hard CAPTCHAs.** When the agent hits a CAPTCHA it can't solve, it sends you a VNC link. You solve it in your browser, the agent continues.

## How It Works

```
Your AI agent (Claude Code, etc.)
    |
    | MCP protocol (stdio)
    v
  navvi (FastMCP, Python)
    |
    | HTTP → localhost:8024
    v
+--------------------------------------+
|  Docker container                    |
|                                      |
|  Firefox  ←  Marionette (navigate)   |
|     |                                |
|  Xvfb     ←  xdotool (click, type)  |
|     |                                |
|  x11vnc   →  noVNC (live view)       |
|                                      |
|  gopass (credential vault)           |
|  navvi-server (REST API)             |
+--------------------------------------+
    |
    v
  Docker volume (persistent profile)
```

**Navigation** uses Firefox Marionette &mdash; a built-in protocol with no detectable automation markers.

**All input** uses xdotool &mdash; OS-level events that websites cannot distinguish from a real person.

**Credentials** are stored in gopass inside the container. The `autofill` action reads gopass and types directly into Firefox &mdash; the password travels from vault to browser, never through the AI.

**Profiles persist** in Docker named volumes. Stop a container, start it next week &mdash; still logged in.

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
| `navvi_mousedown` | Press and hold |
| `navvi_mouseup` | Release mouse button |
| `navvi_mousemove` | Move mouse without clicking |
| `navvi_screenshot` | Capture the screen |
| `navvi_creds` | List, get metadata, or autofill credentials from gopass |
| `navvi_vnc` | Get live view URL for human handoff |
| `navvi_url` | Get current page URL |
| `navvi_record_start` | Start recording a video |
| `navvi_record_stop` | Stop and assemble MP4 |
| `navvi_record_gif` | Convert recording to GIF |
| `navvi_status` | Show running containers |
| `navvi_list` | List available Codespaces (remote mode) |

### Key Workflow

`navvi_find` is the primary way to get coordinates. It returns screen-ready `(x, y)` values that account for browser chrome. Pass them directly to `navvi_click` or `navvi_fill`.

```
navvi_find("button[type=submit]")  →  { x: 512, y: 563, text: "Log in" }
navvi_click(x=512, y=563)
```

For dropdowns: `navvi_find` the button &rarr; `navvi_click` to open &rarr; `navvi_find` the options &rarr; `navvi_click` the one you want.

### When Your Agent Needs Help

Some sites require human intervention (CAPTCHAs, OAuth consent, 2FA codes). The agent asks for help:

```
navvi_vnc()  →  http://127.0.0.1:6080/vnc.html?autoconnect=true
```

Open the URL, do what the agent can't, and it picks up where you left off.

## Personas

Each persona is a separate browser identity with its own cookies, credentials, and history.

```yaml
# personas/default.yaml
name: default
description: Default browser persona
browser:
  locale: en-US
  timezone: America/Santiago
```

Personas are backed by Docker named volumes (`navvi-profile-<name>`). Create as many as you need &mdash; one for each service, project, or team member.

## Requirements

- **Docker** &mdash; the browser runs in a container
- **uv** &mdash; `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`)
- **ffmpeg** (optional) &mdash; only needed for video recording

## License

MIT

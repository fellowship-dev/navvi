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
  <a href="https://pypi.org/project/navvi/"><img src="https://img.shields.io/pypi/v/navvi" alt="PyPI" /></a>
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
- **Undetectable input** &mdash; OS-level mouse and keyboard events (`isTrusted: true`), `navigator.webdriver = false`
- **Live view** &mdash; VNC link for when a human needs to step in (CAPTCHAs, OAuth, 2FA)
- **Persona management** &mdash; create multiple browser identities with accounts, credentials, and action history
- **MCP-native** &mdash; Resources, Prompts, and progressive disclosure built into the protocol

## Quick Start

### 1. Build the Docker image

```bash
git clone https://github.com/Fellowship-dev/navvi.git
cd navvi
docker build -t navvi:camoufox -f container/Dockerfile container/
```

### 2. Add to Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "navvi": {
      "command": "uvx",
      "args": ["navvi@latest"],
      "env": {
        "NAVVI_GPG_PASSPHRASE": "pick-any-random-string-here"
      }
    }
  }
}
```

`NAVVI_GPG_PASSPHRASE` enables the credential vault (gopass). On first boot, Navvi generates a GPG key protected by this passphrase. The key persists in a Docker volume across restarts.

> **Keep your passphrase safe.** If you lose it and the Docker volume is deleted, all stored passwords are unrecoverable.

### 3. Use

Just tell your agent what to do:

```
"Search DuckDuckGo for 'navvi browser' and list the top results"
"Log into Tutanota with stored credentials"
"Go to github.com/Fellowship-dev/navvi and screenshot the README"
```

Navvi's journey tools (`navvi_browse`, `navvi_login`) handle navigation, element finding, clicking, typing, and screenshots internally. No manual step-by-step needed.

<details>
<summary>For fine-grained control: atomic tools</summary>

Atomic tools are hidden by default. Unlock them when you need precise control:

```
navvi_atomic(enable=true)                          → unlock low-level tools
navvi_open url=https://example.com                 → navigate
navvi_find selector="input[type=email]"            → locate element → (x, y)
navvi_fill x=512 y=498 value="me@example.com"     → type into it
navvi_screenshot                                   → see what happened
```

</details>

### 4. Optional: Install companion agents

Companion agents give Claude Code dedicated browsing subagents &mdash; isolates browser work from your main conversation.

```bash
curl -fsSL https://raw.githubusercontent.com/Fellowship-dev/navvi/main/install-companions.sh | bash
```

This installs `navvi-browse` and `navvi-login` agents into `.claude/agents/`.

## Use Cases

**Persistent logins.** Log into a service once &mdash; your agent stays logged in across sessions. No more re-entering credentials, no more expired sessions.

**Secure credential management.** Passwords live in gopass inside the container. The `autofill` action types them directly into the browser &mdash; the AI never sees the raw password.

**Visual evidence for PRs.** Screenshot your staging app before and after a code change. Record a user flow as a GIF. Attach it to the pull request.

**Form automation on protected sites.** Fill complex forms with dropdowns, date pickers, and multi-step wizards. OS-level input passes bot detection that blocks Selenium and Playwright.

**Human handoff for hard CAPTCHAs.** When the agent hits a CAPTCHA it can't solve, it sends you a VNC link. You solve it in your browser, the agent continues.

## How It Works

```
Your AI agent (Claude Code, etc.)
    |
    | MCP protocol (stdio)
    v
  navvi (FastMCP, Python — via uvx)
    |
    | HTTP → localhost:8024
    v
+--------------------------------------+
|  Docker container                    |
|                                      |
|  Camoufox ←  Marionette (navigate)  |
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
  ~/.navvi/navvi.db (persona state)
```

**Anti-detection** uses [Camoufox](https://github.com/daijro/camoufox) &mdash; a patched Firefox with fingerprint masking at the C++ level. `navigator.webdriver` returns `false`.

**All input** uses xdotool &mdash; OS-level events that websites cannot distinguish from a real person.

**Credentials** are stored in gopass inside the container. Three secure actions:
- `generate` &mdash; creates a random password inside the container, stores in gopass. The password **never** leaves the container or appears in AI context.
- `import` &mdash; bulk-import existing credentials from a JSON file on the host. Passwords appear briefly in the localhost request, never in AI context.
- `autofill` &mdash; reads gopass and types directly into the browser via xdotool. The password never travels through the AI.

**Personas** persist in Docker named volumes (browser profiles) and SQLite (config, accounts, action logs).

## MCP Tools

By default, Navvi shows 11 high-level tools. Atomic tools unlock on demand.

### Journey tools (default)

| Tool | What it does |
|------|-------------|
| `navvi_browse` | **Primary tool** &mdash; give it an instruction + URL, it handles everything |
| `navvi_login` | Log into a service using stored gopass credentials |

### Lifecycle

| Tool | What it does |
|------|-------------|
| `navvi_start` | Start a browser container for a persona |
| `navvi_stop` | Stop container (profile preserved) |
| `navvi_status` | Show running containers and health |

### Observation

| Tool | What it does |
|------|-------------|
| `navvi_screenshot` | Capture the screen |
| `navvi_vnc` | Get live VNC URL for human handoff |

### Persona management

| Tool | What it does |
|------|-------------|
| `navvi_persona` | Create, update, list, delete browser personas |
| `navvi_account` | Track accounts per persona (service, email, gopass ref) |

### Progressive disclosure

| Tool | What it does |
|------|-------------|
| `navvi_atomic` | Unlock/hide 12 low-level tools (click, find, fill, etc.) |

<details>
<summary>Atomic tools (hidden by default)</summary>

| Tool | What it does |
|------|-------------|
| `navvi_open` | Navigate to a URL |
| `navvi_find` | Find element by CSS selector &rarr; screen (x, y) |
| `navvi_click` | Click at coordinates |
| `navvi_fill` | Click + type text |
| `navvi_press` | Press a key |
| `navvi_scroll` | Scroll the page |
| `navvi_drag` | Drag between two points |
| `navvi_mousedown/up/move` | Low-level mouse control |
| `navvi_url` | Get current page URL |
| `navvi_creds` | Manage gopass credentials: list, get, generate, import, autofill |
| `navvi_list` | List available Codespaces (remote mode) |

</details>

### Recording tools (hidden by default)

| Tool | What it does |
|------|-------------|
| `navvi_record_start` | Start recording screenshots |
| `navvi_record_stop` | Assemble MP4 |
| `navvi_record_gif` | Convert to GIF |

## MCP Resources

Read persona state without tool calls:

| URI | What it returns |
|-----|----------------|
| `personas://list` | All personas with account counts |
| `persona://{name}/state` | Config, accounts, recent actions |
| `persona://{name}/accounts` | Account details |
| `audit://{name}/log` | Last 20 actions |

## MCP Prompts

Structured workflows available as prompt templates:

| Prompt | What it does |
|--------|-------------|
| `signup_flow` | Step-by-step account creation on a service |
| `login_flow` | Log in using stored credentials |
| `qa_walk` | Walk a page for QA &mdash; screenshot, find issues, report |

## Personas

Each persona is a separate browser identity with its own cookies, credentials, and history. Managed via MCP tools:

```
navvi_persona(action="create", name="mybot", description="GitHub admin", stealth="high")
navvi_persona(action="list")
navvi_account(action="add", persona="mybot", service="github.com", email="bot@x.com")
```

Persona config and state live in `~/.navvi/navvi.db`. Browser profiles persist in Docker named volumes (`navvi-profile-<name>`).

## Requirements

- **Docker** &mdash; the browser runs in a container
- **uv** &mdash; `curl -LsSf https://astral.sh/uv/install.sh | sh` (or `brew install uv`)
- **NAVVI_GPG_PASSPHRASE** &mdash; any random string, enables the gopass credential vault. Set in `.mcp.json` env.
- **ffmpeg** (optional) &mdash; only needed for video recording
- **ANTHROPIC_API_KEY** (optional) &mdash; enables Haiku vision for `navvi_browse` ($0.002/step). Without it, falls back to heuristics.

## License

MIT

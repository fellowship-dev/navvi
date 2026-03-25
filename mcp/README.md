# Navvi MCP Server

MCP server for local and remote browser automation via PinchTab.

## Setup

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "navvi": {
      "command": "node",
      "args": ["/path/to/navvi/mcp/server.mjs"]
    }
  }
}
```

## Available Tools

### Lifecycle

| Tool | Description |
|------|-------------|
| `navvi_start` | Start in `local` or `remote` mode. Checks deps, offers install commands if missing |
| `navvi_stop` | Stop PinchTab (local) or Codespace + port forward (remote) |
| `navvi_status` | Show mode, PinchTab reachability, running browser instances |
| `navvi_list` | List available Codespaces (remote mode) |

### Browser Control

| Tool | Description |
|------|-------------|
| `navvi_up` | Launch a browser instance for a persona |
| `navvi_down` | Stop instance(s) |
| `navvi_open` | Navigate to a URL |
| `navvi_snapshot` | Get accessibility tree (~800 tokens) |
| `navvi_click` | Click element by ref or x,y coordinates |
| `navvi_fill` | Type into element by ref (multi-strategy with verification) |
| `navvi_drag` | Drag element by ref or x,y — `mouse`, `html5`, or `auto` strategy |
| `navvi_mousedown` | Press and hold mouse (for long-press or manual drag) |
| `navvi_mouseup` | Release mouse button |
| `navvi_mousemove` | Move mouse to coordinates (hover) |
| `navvi_press` | Press a keyboard key |
| `navvi_screenshot` | Capture page as PNG |

### CAPTCHA Handling

See [`docs/captchas.md`](../docs/captchas.md) for strategies by CAPTCHA type (puzzle drag, press-and-hold, HTML5 DnD, iframe isolation).

## Modes

**Local** — runs PinchTab directly on your machine. Needs:
- PinchTab (`brew install anthropics/tap/pinchtab`)
- Chrome or Chromium

**Remote** — spins up a GitHub Codespace, port-forwards PinchTab. Needs:
- GitHub CLI (`brew install gh`)

If dependencies are missing, `navvi_start` tells you exactly what to install.

## Workflow

```
navvi_start(mode: "local")     # or "remote"
navvi_up(persona: "dev")   # launch browser
navvi_open(url: "https://...")  # navigate
navvi_snapshot()                # read the page
navvi_stop()                   # done
```

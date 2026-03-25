# Navvi MCP Server

FastMCP server for local and remote browser automation via Camoufox.

## Setup

```bash
claude mcp add navvi -- uvx navvi
```

Or add to your `.mcp.json`:

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

## Development

Run the server locally (from repo root):

```bash
uv run python -m navvi
```

Or directly:

```bash
pip install -e .
navvi
```

## Available Tools

### Lifecycle

| Tool | Description |
|------|-------------|
| `navvi_start` | Start a browser container (local Docker or remote Codespace) |
| `navvi_stop` | Stop container(s) — Firefox profile preserved in Docker volume |
| `navvi_status` | Show mode, running containers, API health |
| `navvi_list` | List available Codespaces (remote mode) |

### Browser Control

| Tool | Description |
|------|-------------|
| `navvi_open` | Navigate to a URL |
| `navvi_find` | Find element by CSS selector → screen coordinates |
| `navvi_click` | Click at (x, y) coordinates |
| `navvi_fill` | Click + type text into a field |
| `navvi_press` | Press a keyboard key |
| `navvi_drag` | Drag from point A to point B |
| `navvi_mousedown` | Press and hold mouse button |
| `navvi_mouseup` | Release mouse button |
| `navvi_mousemove` | Move mouse without clicking |
| `navvi_scroll` | Scroll the page |
| `navvi_screenshot` | Capture the screen |
| `navvi_url` | Get current page URL |
| `navvi_vnc` | Get live view URL for human handoff |

### Credentials

| Tool | Description |
|------|-------------|
| `navvi_creds` | List, get, or autofill credentials from gopass |

### Recording

| Tool | Description |
|------|-------------|
| `navvi_record_start` | Start recording screenshots |
| `navvi_record_stop` | Stop and assemble MP4 |
| `navvi_record_gif` | Convert recording to GIF |

## Workflow

```
navvi_start()                              → spin up browser
navvi_open(url="https://...")              → navigate
navvi_find(selector="input[type=email]")   → get coordinates
navvi_fill(x=512, y=498, value="me@x.com") → type into field
navvi_screenshot()                          → verify
navvi_stop()                                → done
```

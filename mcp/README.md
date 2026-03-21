# Navvi MCP Server

MCP server for Codespace lifecycle management and PinchTab browser control as Claude Code tools.

## Setup

Copy `mcp.json` to your project's `.mcp.json`, or add the navvi entry to an existing one:

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

### Codespace Lifecycle

| Tool | Description |
|------|-------------|
| `navvi_codespaces_list` | List available Codespaces (running and stopped) |
| `navvi_codespace_start` | Create new or resume stopped Codespace |
| `navvi_codespace_stop` | Stop a running Codespace |
| `navvi_codespace_connect` | Port-forward PinchTab from Codespace to localhost |
| `navvi_codespace_disconnect` | Stop port forwarding |

### Browser Control

| Tool | Description |
|------|-------------|
| `navvi_up` | Launch a browser instance for a persona |
| `navvi_down` | Stop instance(s) |
| `navvi_status` | List running instances and connection status |
| `navvi_open` | Navigate to a URL |
| `navvi_snapshot` | Get accessibility tree (~800 tokens) |
| `navvi_click` | Click element by ref |
| `navvi_fill` | Type into element by ref |
| `navvi_screenshot` | Capture page as PNG |

## How It Works

```
Claude Code → MCP stdio → server.mjs → gh cs → Codespace → PinchTab → Chrome
```

Typical workflow:
1. `navvi_codespaces_list` — see what's available
2. `navvi_codespace_start` — spin up or resume a Codespace
3. `navvi_codespace_connect` — port-forward PinchTab to localhost
4. `navvi_up` / `navvi_open` / `navvi_snapshot` — browse
5. `navvi_codespace_stop` — done, stop billing

Zero dependencies — uses Node built-in `http` module and `gh` CLI only.

## Example

```
User: "Go to dev.to and show me the trending articles"

Claude Code:
  → navvi_codespaces_list()        # check what's available
  → navvi_codespace_start()        # spin up compute
  → navvi_codespace_connect()      # tunnel PinchTab to localhost
  → navvi_up(persona: "fry-dev")   # launch browser
  → navvi_open(url: "https://dev.to")
  → navvi_snapshot()               # read the page
```

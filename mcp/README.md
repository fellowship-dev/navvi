# Navvi MCP Server

MCP server that wraps PinchTab's HTTP API as Claude Code tools.

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

| Tool | Description |
|------|-------------|
| `navvi_up` | Launch a browser instance for a persona |
| `navvi_down` | Stop instance(s) |
| `navvi_status` | List running instances |
| `navvi_open` | Navigate to a URL |
| `navvi_snapshot` | Get accessibility tree (~800 tokens) |
| `navvi_click` | Click element by ref |
| `navvi_fill` | Type into element by ref |
| `navvi_screenshot` | Capture page as PNG |

## How It Works

```
Claude Code → MCP stdio → server.mjs → HTTP → PinchTab → Chrome
```

Zero dependencies — uses Node built-in `http` module only. PinchTab must be running on port 9867.

## Example

Once configured, Claude Code sees Navvi tools natively:

```
User: "Go to dev.to and show me the trending articles"

Claude Code:
  → navvi_up(persona: "fry-dev")
  → navvi_open(url: "https://dev.to")
  → navvi_snapshot()
  → [reads accessibility tree, finds article links]
```

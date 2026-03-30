# Contributing to Navvi

Thanks for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/fellowship-dev/navvi.git
cd navvi

# Build the container image locally
docker build -t navvi -f container/Dockerfile container/

# Install the MCP server in editable mode
pip install -e .

# Run the MCP server (points to local image)
NAVVI_IMAGE=navvi python -m navvi
```

Set `NAVVI_IMAGE=navvi` in your `.mcp.json` env to use the locally built image instead of GHCR.

## Reporting Issues

Please [open an issue](https://github.com/fellowship-dev/navvi/issues) with:
- What you expected to happen
- What actually happened
- Steps to reproduce

## Pull Requests

1. Fork the repo
2. Create a branch (`git checkout -b my-fix`)
3. Make your changes
4. Test locally with `NAVVI_IMAGE=navvi`
5. Open a PR

## Good First Issues

Look for issues labeled [`good first issue`](https://github.com/fellowship-dev/navvi/labels/good%20first%20issue) — these are great starting points.

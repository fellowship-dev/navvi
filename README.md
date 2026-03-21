# Navvi

Agentic browser persona manager. Each persona is a persistent browser identity with its own cookies, credentials, and profile — running in a Codespace with headed Chrome.

Spin up per task. Tear down when done.

## How It Works

```
Claude Code (brain)
    ↓
Navvi (persona + browser orchestration)
    ↓
PinchTab (HTTP API, stealth, accessibility tree)
    ↓
Headed Chrome in Codespace (VNC + CDP)
    ↓
Real websites with isTrusted events
```

## Quick Start

1. Create a Codespace from this repo
2. PinchTab + Chromium install automatically
3. Define personas in `.navvi/personas/*.yml`
4. Launch:

```bash
# Via PinchTab (recommended — stealth + accessibility tree)
./scripts/launch-pinchtab.sh fry-dev --headed

# Or use the CLI wrapper
./scripts/navvi.sh launch fry-dev --headed
./scripts/navvi.sh open https://dev.to
./scripts/navvi.sh snapshot    # 800 tokens, not 10K
./scripts/navvi.sh screenshot  # full page PNG

# Direct Chrome (fallback — raw CDP, no stealth)
./scripts/launch-chrome.sh fry-dev
```

## Structure

```
.devcontainer/           # Codespace config (desktop-lite + Chromium + PinchTab)
.navvi/
├── personas/            # Persona definitions (YAML, committed)
└── profiles/            # Browser profiles with cookies (volume-mounted)
scripts/
├── navvi.sh             # CLI wrapper for PinchTab API
├── launch-pinchtab.sh   # Launch PinchTab server for a persona
└── launch-chrome.sh     # Launch raw Chrome with CDP (fallback)
```

## PinchTab API

PinchTab runs on port 9867 and provides:

```bash
# Launch a browser instance
curl -X POST localhost:9867/instances/launch \
  -d '{"name":"fry-dev","mode":"headed"}'

# Open a URL
curl -X POST localhost:9867/instances/$ID/tabs/open \
  -d '{"url":"https://dev.to"}'

# Get accessibility tree (800 tokens vs 10K for screenshots)
curl localhost:9867/tabs/$TAB/snapshot

# Perform action by element ref
curl -X POST localhost:9867/tabs/$TAB/action \
  -d '{"type":"click","ref":"e42"}'

# Screenshot
curl localhost:9867/tabs/$TAB/screenshot -o page.png
```

## Persona Definition

```yaml
# .navvi/personas/fry-dev.yml
name: fry-dev
description: Fry's developer persona
email: ayuda.intro@gmail.com
credentials: $BW_ENTRY_NAME
services:
  - dev.to
  - github.com
browser:
  stealth: true
  locale: en-US
  timezone: America/Santiago
```

## Profile Persistence

Profiles live in `.navvi/profiles/`, mounted as a Docker volume. They persist across Codespace rebuilds automatically — no backup/restore needed.

## Why PinchTab + Headed Chrome?

- **Stealth** — patches `navigator.webdriver`, spoofs UA, hides automation
- **Accessibility tree** — 800 tokens to read a page (5-13x cheaper than screenshots)
- **isTrusted events** — passes CAPTCHA detection via VNC
- **Persistent sessions** — cookies survive restarts
- **HTTP API** — framework-agnostic, works with any agent

## Companion: Flowchad

Navvi is the browser hands. [Flowchad](https://github.com/Fellowship-dev/flowchad) is the QA brain.

Flowchad defines what to test. Navvi handles headed execution when headless won't cut it (CAPTCHAs, OAuth, stealth).

## License

MIT

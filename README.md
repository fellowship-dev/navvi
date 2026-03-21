# Navvi

Agentic browser persona manager. Each persona is a persistent browser identity with its own cookies, credentials, and profile — running in a Codespace with headed Chrome.

Spin up per task. Tear down when done.

## How It Works

```
Claude Code (brain)
    ↓
Navvi (persona + browser orchestration)
    ↓
Headed Chrome in Codespace (VNC + CDP)
    ↓
Real websites with isTrusted events
```

## Quick Start

1. Create a Codespace from this repo
2. Chrome launches with VNC on port 6080, CDP on port 9222
3. Define personas in `.navvi/personas/*.yml`
4. Launch a persona: `./scripts/launch-chrome.sh fry-dev`

## Structure

```
.devcontainer/       # Codespace config (desktop-lite + Chromium)
.navvi/
├── personas/        # Persona definitions (YAML, committed)
└── profiles/        # Browser profiles with cookies (gitignored)
scripts/
├── launch-chrome.sh   # Launch headed Chrome for a persona
├── export-profile.sh  # Tar a profile for backup
└── import-profile.sh  # Restore a profile from tar
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

Profiles live in `.navvi/profiles/` (gitignored). For backup across Codespace rebuilds:

```bash
# Export
./scripts/export-profile.sh fry-dev /tmp/fry-dev-profile.tar.gz

# Import
./scripts/import-profile.sh /tmp/fry-dev-profile.tar.gz
```

## Why Headed Chrome?

- `isTrusted=true` mouse/keyboard events — passes CAPTCHA detection
- OAuth popups, cookie banners, multi-step wizards work naturally
- VNC gives visual debugging — see what the agent sees
- Persistent profiles keep you logged in across sessions

## Companion: Flowchad

Navvi is the browser hands. [Flowchad](https://github.com/Fellowship-dev/flowchad) is the QA brain.

Flowchad defines what to test. Navvi handles headed execution when headless won't cut it (CAPTCHAs, OAuth, stealth).

## License

MIT

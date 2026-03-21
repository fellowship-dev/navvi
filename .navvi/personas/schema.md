# Persona Definition Schema

Each persona lives in `.navvi/personas/<name>.yml`. One file per identity.

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Unique persona identifier (used as profile dir name) |
| `description` | string | What this persona is for |
| `email` | string | Primary email for this identity |

## Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `credentials` | string | — | Bitwarden entry name (env var ref with `$`) |
| `services` | list | `[]` | Services this persona uses (for seeding/status) |
| `seed_urls` | list | `[]` | URLs to visit on first launch (build browsing history) |
| `browser.stealth` | bool | `true` | Enable stealth patches (webdriver, UA spoofing) |
| `browser.locale` | string | `en-US` | Browser locale |
| `browser.timezone` | string | — | Timezone override |
| `browser.viewport` | string | `1280x720` | Default viewport size |
| `browser.mode` | string | `headed` | Default launch mode: `headed` or `headless` |

## Example

```yaml
# .navvi/personas/fry-dev.yml
name: fry-dev
description: Fry's developer persona for blogging and community
email: ayuda.intro@gmail.com
credentials: $BW_GOOGLE_AYUDA
services:
  - dev.to
  - github.com
  - lobste.rs
seed_urls:
  - https://dev.to
  - https://github.com/trending
  - https://lobste.rs
browser:
  stealth: true
  locale: en-US
  timezone: America/Santiago
  mode: headed
```

## Conventions

- Persona name = profile directory name in `.navvi/profiles/`
- Credentials reference Bitwarden entries — never hardcode passwords
- `seed_urls` are visited on `navvi seed <name>` to build organic browsing history
- Services list is informational — used by `navvi status` to show what a persona can access

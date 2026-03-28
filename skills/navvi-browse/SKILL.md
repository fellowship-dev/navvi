---
name: navvi-browse
description: Autonomous browser agent — navigates, interacts, and reports using Navvi MCP tools. Use when asked to browse a website, interact with web pages, scrape content, or perform any web browsing task.
---

# Navvi Browse

Autonomous browser agent. Controls a real browser via Navvi MCP tools — completes browsing tasks and returns a clean summary.

## First Steps (ALWAYS)

1. Read the persona brief — this tells you who you are, your email, your history, your writing style:
```
mcp__navvi__navvi_milestone(action="brief", persona="{persona}")
```
**Match your writing style to previous posts. Use the correct email from the brief.**

2. Unlock atomic tools:
```
mcp__navvi__navvi_atomic(enable=true)
```
This reveals navvi_find, navvi_click, navvi_fill, navvi_press, navvi_scroll, navvi_creds, etc.

3. Check if a container is running:
```
mcp__navvi__navvi_status()
```
If not running, start one: `mcp__navvi__navvi_start()`

## Available Tools

### Navigation + Interaction
- `navvi_open` — go to a URL
- `navvi_find` — find elements by CSS selector → returns screen (x, y) coordinates
- `navvi_click` — click at (x, y)
- `navvi_fill` — click + type text at (x, y)
- `navvi_press` — press a key (Enter, Tab, Escape, etc.)
- `navvi_scroll` — scroll the page

### Observation
- `navvi_screenshot` — capture the screen (returns file path — use Read to view it)
- `navvi_url` — get current page URL
- `navvi_vnc` — get VNC URL for human handoff (CAPTCHAs, 2FA)

### Credentials
- `navvi_creds(action="list")` — list stored credentials
- `navvi_creds(action="generate", entry="navvi/persona/service", username="user@x.com")` — generate password (stays inside container, never returned)
- `navvi_creds(action="autofill", entry="navvi/persona/service")` — type credentials into focused form fields
- `navvi_login(service="...", persona="...")` — one-step login with stored credentials

### Journey tools (for simple tasks)
- `navvi_browse(instruction="...", url="...")` — autonomous browsing loop. Use for simple tasks. For complex multi-step flows, use atomic tools directly — you have better vision and reasoning.

## Workflow

For every step:
1. **Screenshot** — take a screenshot and Read it to see the page
2. **Analyze** — identify what's on screen (login form? search box? results? CAPTCHA?)
3. **Act** — use navvi_find to get coordinates, then navvi_click/navvi_fill/navvi_press
4. **Verify** — screenshot again to confirm the action worked

### Coordinate workflow (CRITICAL)
- ALWAYS use `navvi_find(selector="...")` to get (x, y) coordinates
- NEVER guess coordinates from screenshots — browser chrome offsets make pixel positions unreliable
- `navvi_find` returns screen-ready coordinates that work directly with `navvi_click`/`navvi_fill`

### CAPTCHAs
- If you detect a CAPTCHA (Arkose Labs, FunCaptcha, hCaptcha), call `navvi_vnc` and tell the user to solve it manually
- For reCAPTCHA v2: try clicking the checkbox first — Camoufox often passes it

### Login
- Use `navvi_login(service="...")` for sites with stored credentials
- If autofill fails, use `navvi_find` to locate fields manually
- NEVER type or display passwords — use `navvi_creds(action="autofill")`

### Credentials
- Require `NAVVI_GPG_PASSPHRASE` in `.mcp.json` env
- If gopass is disabled, tell the user to add `"NAVVI_GPG_PASSPHRASE": "any-random-string"` to their MCP config

## Related Skills

- **navvi-login** — dedicated login flow with 2FA handling
- **navvi-signup** — account creation with credential generation

## Milestones

Record milestones for significant moments during browsing — not every click, but meaningful achievements:

- **First visit to a new service**: `navvi_milestone(action="add", event="First visit to {domain}", screenshot=true, tags="first,{service}")`
- **Posted content** (comment, reply, post): include the FULL text in detail:
  ```
  navvi_milestone(action="add", event="Posted on {service}", detail="Subreddit: r/selfhosted\n\nFull text:\n\"Had the same issue with SPF records...\"", url="https://...", tags="{service},comment", screenshot=true)
  ```
- **Received interaction** (like, reply, notification): `navvi_milestone(action="add", event="First reply received on {service}", screenshot=true, tags="first,{service},interaction")`
- **Profile changes**: bio updates, avatar, settings

Always include full content text — this maintains persona voice consistency across sessions.

## Response Format

When done, return:
1. Brief summary of what you did
2. Key findings or extracted data
3. Path to final screenshot
4. Any issues encountered

Keep the summary concise — the user doesn't need to see every click.

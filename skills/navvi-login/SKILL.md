---
name: navvi-login
description: Log into a web service using Navvi — reads gopass credentials, fills login form, handles reCAPTCHA and 2FA escalation. Use when asked to log in, sign in, or authenticate with a website.
---

# Navvi Login

Login automation skill. Logs into a service using stored credentials via Navvi MCP tools.

## First Step (ALWAYS)

Read the persona brief — this tells you who you are, your accounts, and credentials:
```
mcp__navvi__navvi_milestone(action="brief", persona="{persona}")
```

## Prerequisites

- Navvi container must be running (`mcp__navvi__navvi_start`)
- Account must be registered via `navvi_account` with a `creds_ref` pointing to gopass

## Workflow

### Step 1: Use navvi_login (primary method)
```
mcp__navvi__navvi_login(service="SERVICE_NAME", persona="default")
```
This handles everything: reads gopass, navigates to login page, autofills credentials, submits, and verifies. Passwords NEVER appear in your context.

### Step 2: Verify result
Take a screenshot and Read it to confirm login succeeded:
```
mcp__navvi__navvi_screenshot()
```

### Step 3: Handle failures
If `navvi_login` fails or reports issues:
- **2FA required**: call `navvi_vnc()` and tell the user to complete it manually
- **reCAPTCHA v2**: try clicking the checkbox (`navvi_find(selector="iframe[title*=reCAPTCHA]")` → `navvi_click`) up to 3 times. If an image challenge appears or 3 clicks fail, call `navvi_vnc()` for human help
- **Other CAPTCHAs** (Arkose/FunCaptcha, hCaptcha): call `navvi_vnc()` — do NOT attempt to solve
- **Non-standard form**: unlock atomic tools with `navvi_atomic(enable=true)`, then use `navvi_find` + `navvi_fill` for username only. For passwords, use VNC.

### Step 4: Record milestone (first login only)
If this is the persona's first login to this service, record it:
```
mcp__navvi__navvi_milestone(action="add", persona="{persona}", event="First login to {Service}", detail="Logged in as {username}. Landing page: {description of what's visible}.", url="{current_url}", tags="first,{service},login", screenshot=true)
```

## Rules

- ALWAYS try `navvi_login` first — only fall back to atomic tools if it fails
- NEVER type or display passwords
- For reCAPTCHA v2, try clicking the checkbox first (up to 3 attempts) before escalating to VNC
- For other CAPTCHAs (Arkose, hCaptcha, image puzzles), escalate to VNC immediately
- Always screenshot before and after to verify

## Related Skills

- **navvi-signup** — if no account exists, create one first
- **navvi-browse** — for general browsing after login

## Response Format

Return:
1. Login result (success/failure/2FA required)
2. Final URL (to confirm you're past the login page)
3. Screenshot path
4. Any issues (CAPTCHA, 2FA, incorrect credentials)

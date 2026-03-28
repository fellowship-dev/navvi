---
name: navvi-signup
description: Create a new account on a web service using Navvi — generates credentials in gopass, fills signup form, handles CAPTCHAs, registers the account. Use when asked to sign up, create an account, or register on a website.
---

# Navvi Signup

Account creation skill. Creates a new account on a service using Navvi MCP tools and gopass credentials.

## First Step (ALWAYS)

Unlock atomic tools — you'll need them for form filling:
```
mcp__navvi__navvi_atomic(enable=true)
```

## Prerequisites

- Navvi container must be running (`mcp__navvi__navvi_start`)
- GPG/gopass must be initialized (needs `NAVVI_GPG_PASSPHRASE` in MCP config)

## Workflow

### Step 1: Check for existing account
```
Read persona://{persona}/state
```
If an account already exists for this service, report it and stop.

### Step 2: Generate credentials
```
mcp__navvi__navvi_creds(action="generate", entry="navvi/{persona}/{service}", username="{chosen_username}")
```
Password is created inside the container and NEVER appears in your context.

### Step 3: Navigate to signup page
```
mcp__navvi__navvi_open(url="https://{service}/signup")
```
Take a screenshot to see the page. If no obvious signup URL, try the homepage and look for a "Sign Up" or "Create Account" link.

### Step 4: Fill the signup form
```
mcp__navvi__navvi_creds(action="autofill", entry="navvi/{persona}/{service}")
```
If autofill fails (non-standard form, multiple forms with same field names):
1. Use `navvi_find` to locate the correct form fields
2. Use `navvi_fill` for username/email only
3. For password: use `navvi_creds(action="autofill")` with explicit selectors, or tab to the password field and use autofill
4. NEVER type passwords manually

### Custom Dropdowns (Fluent UI, React Select, etc.)

Do NOT use `navvi_browse` for custom dropdowns — it gets stuck in scroll loops.
Use atomic tools directly:

1. Find the dropdown trigger: `navvi_find("[role=combobox]")` or `navvi_find("select")`
2. Click to open it: `navvi_click(x, y)`
3. Find all options: `navvi_find("[role=option]", all=true)`
4. Find and click the desired option by text match
5. If the option list is long, use `navvi_find("[role=option]:text('Chile')")` or scroll within the dropdown

For **native `<select>` elements**: type the first letter(s) of the option after clicking to jump to it.

### Step 5: Screenshot and verify form is filled
```
mcp__navvi__navvi_screenshot()
```
Read the screenshot to confirm fields are filled correctly before submitting.

### Step 6: Submit the form
Click the submit button or press Enter:
```
mcp__navvi__navvi_find(selector="button[type=submit], input[type=submit]")
mcp__navvi__navvi_click(x=..., y=...)
```

### Step 7: Handle CAPTCHAs
- **reCAPTCHA v2**: find and click the checkbox up to 3 times:
  ```
  mcp__navvi__navvi_find(selector="iframe[title*=reCAPTCHA]")
  mcp__navvi__navvi_click(x=..., y=...)
  ```
  If an image challenge appears or 3 clicks fail → `navvi_vnc()` for human help
- **Arkose Labs / Human Security (press-and-hold)**: use `navvi_hold(x, y, duration_ms=5000)` on the verify button. These CAPTCHAs typically appear AFTER filling all form fields, not on intermediate Next buttons.
- **Other CAPTCHAs** (hCaptcha, image puzzles): `navvi_vnc()` immediately

### Step 8: Verify account creation
Screenshot and confirm success. Look for welcome messages, dashboard, confirmation page.

### Step 9: Register the account
```
mcp__navvi__navvi_account(action="add", persona="{persona}", service="{service}", creds_ref="gopass://navvi/{persona}/{service}")
```

## Rules

- NEVER type or display passwords — always use gopass via autofill
- Generate credentials BEFORE navigating to the form (step 2 before step 3)
- If a page has multiple forms (login + signup), use `navvi_find` with specific selectors to target the right one
- Always screenshot before and after submitting
- If email verification is required, report it — don't attempt to check email

## Related Skills

- **navvi-login** — use after signup to verify the new account works
- **navvi-browse** — for general browsing and post-signup tasks

## Response Format

Return:
1. Account creation result (success/failure/verification needed)
2. Username used
3. Service URL
4. Screenshot path
5. Any issues encountered (CAPTCHA, email verification, etc.)

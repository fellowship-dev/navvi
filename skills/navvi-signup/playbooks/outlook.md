# Outlook / Microsoft Account Signup Playbook

Tested flow as of March 2026. Microsoft changes their UI frequently — verify each step with screenshots.

## URL

`https://signup.live.com`

## Flow (7 steps)

### Step 1: Email

Page title: "Create your Microsoft account"

- The email field and a `@outlook.com` domain dropdown are shown
- Type the username only (e.g. `april.voss.research`) — do NOT include `@outlook.com`
- Verify the domain dropdown shows `@outlook.com` (it's the default): `navvi_find("[role=combobox][name*=domain]")`
- Click Next: `navvi_find("button[type=submit]")` → `navvi_click(x, y)`
- **No CAPTCHA on this step** — if Next doesn't advance, check for validation errors (email taken, invalid chars)

### Step 2: Password

Page title: "Create your password"

- Use `navvi_creds(action="autofill", entry="...", x=PASSWORD_X, y=PASSWORD_Y)` to fill password securely
- The page has only a password field (no username field) — autofill handles this
- Click Next: `navvi_find("button[type=submit]")` → `navvi_click(x, y)`

### Step 3: Details (country + birthdate)

Page title: "Add some details"

- **Country**: Chile is the default if persona locale is `es-CL`. Check with `navvi_find("[id*=Country], [role=combobox][aria-label*=country]")`. If already correct, do NOT touch the dropdown.
- **Birthdate**: 3 fields
  - Month: Fluent UI combobox → `navvi_find("#BirthMonthDropdown")` → click → `navvi_find("[role=option]", all=true)` → click desired month
  - Day: Same pattern → `navvi_find("#BirthDayDropdown")` → click → find option → click
  - Year: Number input → `navvi_find("input[name=BirthYear]")` → `navvi_fill(x, y, "1991")`
- Use plausible fake data (NOT real personal info)
- Click Next

### Step 4: Name

Page title: "Add your name"

- Two text inputs: `navvi_find("#firstNameInput")` and `navvi_find("#lastNameInput")`
- **IMPORTANT**: Click each field explicitly before typing. The `navvi_fill` command auto-clicks at (x,y) but the fields are close together — verify with `navvi_find` after filling to confirm values are in the right fields.
- Click Next

### Step 5: CAPTCHA (Arkose Labs / Human Security)

This is where the CAPTCHA appears — a press-and-hold verification button.

- Find the verify button (usually the submit/Next button on this page)
- Use `navvi_hold(x, y, duration_ms=5000)` — press and hold for 5 seconds
- If it fails or shows an image puzzle → `navvi_vnc()` for human intervention

### Step 6: Privacy notice

- Click "OK" or "Accept" button
- `navvi_find("button[id*=accept], button[type=submit]")` → click

### Step 7: "Stay signed in?"

- Click "Yes" to stay signed in
- `navvi_find("button[id*=accept], button[type=submit]")` → click
- Final page: `account.microsoft.com` — signed in

## Selectors Reference

| Element | Selector |
|---|---|
| Email input | `input[type=email]` |
| Domain dropdown | `[role=combobox][id*=domain]` |
| Password input | `input[type=password]` |
| Country dropdown | `[role=combobox][id*=Country]` |
| Month dropdown | `#BirthMonthDropdown` |
| Day dropdown | `#BirthDayDropdown` |
| Year input | `input[name=BirthYear]` |
| First name | `#firstNameInput` |
| Last name | `#lastNameInput` |
| Next/Submit button | `button[type=submit]` |
| Dropdown options | `[role=option]` |

## Common Pitfalls

1. **navvi_fill types into wrong field** — always `navvi_find` first, then use the returned (x,y)
2. **Country dropdown scroll loop** — do NOT use `navvi_browse` for this. Chile is usually already selected.
3. **CAPTCHA is at step 5, NOT step 1** — the email Next button has no CAPTCHA
4. **Year is a number input, not a dropdown** — use `navvi_fill`, not dropdown click pattern
5. **Persona viewport** — ensure browser window is maximized so all form elements are visible

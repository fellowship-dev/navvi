# CAPTCHA Handling with Navvi

## Strategies by CAPTCHA Type

### Puzzle Drag (Proton, slider puzzles)
- Take a screenshot to identify the puzzle piece and target slot positions
- Use `navvi_drag` with `x, y, dragX, dragY, strategy: "mouse"` — this sends proper CDP mouse events with `buttons: 1` and interpolated path
- Coordinates are **page-relative** unless the CAPTCHA is inside an iframe (see below)
- If the puzzle resets, there's usually a "Reset puzzle piece" button in the accessibility tree

### Press-and-Hold (Arkose Labs / FunCaptcha)
- Use `navvi_mousedown` at the target coordinates, wait (sleep), then `navvi_mouseup`
- These CAPTCHAs detect `isTrusted` on mouse events — CDP events have `isTrusted=false`, so this may not work in all cases
- On local macOS with cliclick available, use the peekaboo skill instead for OS-level input

### HTML5 Drag-and-Drop (Sortable.js, react-dnd)
- Use `navvi_drag` with `ref, targetRef, strategy: "html5"`
- This dispatches synthetic `dragstart/dragover/drop/dragend` events via JS
- Only works with ref-based targeting (not x,y coordinates)

### Image Selection ("Click all squares with X")
- Use `navvi_screenshot` to see the grid
- Calculate grid cell coordinates from the image dimensions
- Use `navvi_click` with x,y for each matching cell
- These often rotate on failure — budget for 2-3 attempts

### Text/Audio CAPTCHAs
- Inspect the page for audio alternatives — many CAPTCHAs offer an audio button
- For text CAPTCHAs (distorted letters), take a screenshot and attempt to read visually

## Iframe CAPTCHAs

Many CAPTCHAs (Proton, reCAPTCHA, hCaptcha) render inside an **iframe**. This matters because:

1. **Coordinates are page-relative, not iframe-relative** — CDP `Input.dispatchMouseEvent` sends coordinates relative to the page viewport. If the CAPTCHA is inside an iframe, the coordinates still work because CDP dispatches at the page level.

2. **Accessibility tree shows iframe content** — `navvi_inspect` traverses into iframes automatically. You'll see the iframe's elements with refs, but interactive elements inside may not be clickable by ref (the ref resolution happens in the main frame's DOM).

3. **When ref-based clicking fails inside iframes** — fall back to coordinate-based clicking:
   - Take a `navvi_screenshot` to see the full page
   - Identify the element's position visually
   - Use `navvi_click` or `navvi_drag` with x,y coordinates

4. **Nested iframes** — some CAPTCHAs use multiple iframe layers. The same coordinate-based approach works since CDP events target the page viewport.

## Alternative Verification

Before brute-forcing a visual CAPTCHA, check for alternatives:
- **Email verification tab** — Proton and others offer email-based verification. Click the "Email" tab in the verification dialog and use an existing email to receive a code.
- **Phone verification** — some services accept SMS verification instead of CAPTCHA
- **Skip CAPTCHA entirely** — some sites only show CAPTCHAs for suspicious sessions. Try with a persona that has browsing history (cookies/profile persistence).

## Auto Strategy

`navvi_drag` with `strategy: "auto"` (default) tries mouse events first, then checks if the DOM changed. If no change is detected and a `targetRef` is provided, it falls back to HTML5 DnD events. This handles most cases automatically:
- Sliders and canvas puzzles → mouse strategy works
- Sortable lists and DnD UIs → html5 fallback kicks in

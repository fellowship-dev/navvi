#!/bin/bash
# Launch headed Chrome with CDP enabled for a given persona.
# Usage: ./scripts/launch-chrome.sh [persona-name]
#
# Runs in the Codespace with DISPLAY=:1 (VNC).
# Profile stored in .navvi/profiles/<persona>/

PERSONA="${1:-default}"
PROFILE_DIR="$(pwd)/.navvi/profiles/$PERSONA"
mkdir -p "$PROFILE_DIR"

echo "Launching Chrome for persona: $PERSONA"
echo "  Profile: $PROFILE_DIR"
echo "  CDP:     http://127.0.0.1:9222"

# Use Playwright's bundled Chromium
CHROMIUM="$(npx playwright install --dry-run chromium 2>/dev/null | grep -o '/.*chrome' | head -1)"
if [ -z "$CHROMIUM" ]; then
  CHROMIUM="$(find "$HOME" -name 'chrome' -path '*/chromium*' -type f 2>/dev/null | head -1)"
fi

if [ -z "$CHROMIUM" ]; then
  echo "Error: Chromium not found. Run: npx playwright install chromium"
  exit 1
fi

exec "$CHROMIUM" \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-sync \
  --disable-background-networking \
  --disable-extensions \
  --start-maximized \
  "$2"

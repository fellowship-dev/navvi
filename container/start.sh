#!/bin/bash
# Navvi container entrypoint: start Xvfb, Firefox, x11vnc, noVNC, API server.
set -e

DISPLAY="${DISPLAY:-:1}"
SCREEN_SIZE="${SCREEN_SIZE:-1024x768x24}"
NAVVI_PORT="${NAVVI_PORT:-8024}"
VNC_PORT="${VNC_PORT:-6080}"
LOCALE="${LOCALE:-en-US}"
TIMEZONE="${TIMEZONE:-UTC}"

export DISPLAY
export TZ="$TIMEZONE"

# Initialize gopass if GPG key is provided
if [ -n "${GPG_PRIVATE_KEY:-}" ]; then
  echo "[navvi] Importing GPG key for gopass..."
  echo "$GPG_PRIVATE_KEY" | gpg --batch --import 2>/dev/null
  GPG_ID=$(gpg --list-secret-keys --keyid-format long 2>/dev/null | grep sec | head -1 | awk '{print $2}' | cut -d/ -f2)
  if [ -n "$GPG_ID" ]; then
    echo "${GPG_ID}:6:" | gpg --import-ownertrust 2>/dev/null
    if [ ! -d "$HOME/.local/share/gopass/stores/root" ]; then
      gopass init --path "$HOME/.local/share/gopass/stores/root" "$GPG_ID" 2>/dev/null
    fi
    echo "[navvi] Gopass ready (key: ${GPG_ID:0:8}...)"
  fi
  unset GPG_PRIVATE_KEY
fi

echo "[navvi] Starting Xvfb on $DISPLAY ($SCREEN_SIZE)..."
Xvfb "$DISPLAY" -screen 0 "$SCREEN_SIZE" -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

# Verify Xvfb is running
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[navvi] ERROR: Xvfb failed to start"
  exit 1
fi

echo "[navvi] Starting Firefox ESR (Marionette on :2828)..."
firefox-esr \
  --marionette \
  --no-remote \
  -width 1024 -height 768 \
  about:blank &
FIREFOX_PID=$!
sleep 2

# Verify Firefox is running
if ! kill -0 "$FIREFOX_PID" 2>/dev/null; then
  echo "[navvi] ERROR: Firefox failed to start"
  exit 1
fi

echo "[navvi] Starting x11vnc..."
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -bg -q 2>/dev/null

echo "[navvi] Starting noVNC on port $VNC_PORT..."
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen "$VNC_PORT" --web /opt/novnc &
NOVNC_PID=$!
sleep 1

echo "[navvi] Starting navvi-server on port $NAVVI_PORT..."
exec python3 /opt/navvi/navvi-server.py \
  --port "$NAVVI_PORT" \
  --display "$DISPLAY"

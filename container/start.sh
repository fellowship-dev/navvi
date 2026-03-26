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

# --- Persistence setup (Codespaces) ---
# Codespaces only persist /workspaces. Symlink browser profile, GPG, and
# gopass store to persistent storage so sessions survive restarts.
PERSIST_DIR="/workspaces/.codespaces/.persistedshare/navvi"
if [ -d "/workspaces/.codespaces/.persistedshare" ]; then
  mkdir -p "$PERSIST_DIR"

  # Browser profile
  if [ -d "$PERSIST_DIR/mozilla" ] && [ ! -L "$HOME/.mozilla" ]; then
    rm -rf "$HOME/.mozilla"
    ln -s "$PERSIST_DIR/mozilla" "$HOME/.mozilla"
    echo "[navvi] Browser profile linked to persistent storage"
  elif [ -d "$HOME/.mozilla" ] && [ ! -L "$HOME/.mozilla" ]; then
    cp -a "$HOME/.mozilla" "$PERSIST_DIR/mozilla"
    rm -rf "$HOME/.mozilla"
    ln -s "$PERSIST_DIR/mozilla" "$HOME/.mozilla"
    echo "[navvi] Browser profile moved to persistent storage"
  fi

  # GPG keyring
  if [ -d "$PERSIST_DIR/gnupg" ] && [ ! -L "$HOME/.gnupg" ]; then
    rm -rf "$HOME/.gnupg"
    ln -s "$PERSIST_DIR/gnupg" "$HOME/.gnupg"
    echo "[navvi] GPG keyring linked to persistent storage"
  fi

  # Gopass store
  if [ -d "$PERSIST_DIR/gopass/stores" ] && [ ! -L "$HOME/.local/share/gopass/stores" ]; then
    mkdir -p "$HOME/.local/share/gopass"
    rm -rf "$HOME/.local/share/gopass/stores"
    ln -s "$PERSIST_DIR/gopass/stores" "$HOME/.local/share/gopass/stores"
    echo "[navvi] Gopass store linked to persistent storage"
  fi
fi

# --- Gopass init (opt-in: provide GPG_PRIVATE_KEY env var) ---
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
elif [ -n "$(gpg --list-secret-keys 2>/dev/null)" ]; then
  # Existing key from persistent volume (Docker volumes or Codespaces)
  GPG_ID=$(gpg --list-secret-keys --keyid-format long 2>/dev/null | grep sec | head -1 | awk '{print $2}' | cut -d/ -f2)
  if [ -n "$GPG_ID" ] && [ ! -d "$HOME/.local/share/gopass/stores/root" ]; then
    gopass init --path "$HOME/.local/share/gopass/stores/root" "$GPG_ID" 2>/dev/null
  fi
  echo "[navvi] Gopass ready (existing key: ${GPG_ID:0:8}...)"
else
  echo "[navvi] Gopass disabled — no GPG key. Set GPG_PRIVATE_KEY env var to enable credential management."
fi

# --- Graceful shutdown ---
# Firefox must shut down cleanly to flush cookies/IndexedDB to disk.
cleanup() {
  echo "[navvi] Shutting down gracefully..."
  if [ -n "$FIREFOX_PID" ] && kill -0 "$FIREFOX_PID" 2>/dev/null; then
    kill -TERM "$FIREFOX_PID" 2>/dev/null
    # Wait up to 10s for Firefox to flush profile data
    for i in $(seq 1 10); do
      kill -0 "$FIREFOX_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$FIREFOX_PID" 2>/dev/null || true
    echo "[navvi] Camoufox stopped"
  fi
  if [ -n "$API_PID" ]; then kill "$API_PID" 2>/dev/null; fi
  if [ -n "$NOVNC_PID" ]; then kill "$NOVNC_PID" 2>/dev/null; fi
  if [ -n "$XVFB_PID" ]; then kill "$XVFB_PID" 2>/dev/null; fi
  exit 0
}
trap cleanup SIGTERM SIGINT

# --- Start services ---
echo "[navvi] Starting Xvfb on $DISPLAY ($SCREEN_SIZE)..."
Xvfb "$DISPLAY" -screen 0 "$SCREEN_SIZE" -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[navvi] ERROR: Xvfb failed to start"
  exit 1
fi

echo "[navvi] Starting Camoufox (Marionette on :2828)..."
camoufox-bin \
  --marionette \
  --no-remote \
  -width 1024 -height 768 \
  about:blank &
FIREFOX_PID=$!
sleep 2

if ! kill -0 "$FIREFOX_PID" 2>/dev/null; then
  echo "[navvi] ERROR: Camoufox failed to start"
  exit 1
fi

echo "[navvi] Starting x11vnc..."
x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -bg -q 2>/dev/null

echo "[navvi] Starting noVNC on port $VNC_PORT..."
/opt/novnc/utils/novnc_proxy --vnc localhost:5900 --listen "$VNC_PORT" --web /opt/novnc &
NOVNC_PID=$!
sleep 1

echo "[navvi] Starting navvi-server on port $NAVVI_PORT..."
python3 /opt/navvi/navvi-server.py \
  --port "$NAVVI_PORT" \
  --display "$DISPLAY" &
API_PID=$!

# Wait for any child to exit (keeps the shell alive to handle SIGTERM)
wait

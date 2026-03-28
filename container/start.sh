#!/bin/bash
# Navvi container entrypoint: start Xvfb, Firefox, x11vnc, noVNC, API server.
set -e

DISPLAY="${DISPLAY:-:1}"
SCREEN_SIZE="${SCREEN_SIZE:-1920x1080x24}"
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

# --- Gopass init ---
# Priority: 1) GPG_PRIVATE_KEY (pre-existing key), 2) existing key in volume, 3) NAVVI_GPG_PASSPHRASE (generate new)
if [ -n "${GPG_PRIVATE_KEY:-}" ]; then
  # User provided a pre-existing GPG key
  echo "[navvi] Importing GPG key for gopass..."
  echo "$GPG_PRIVATE_KEY" | gpg --batch --import 2>/dev/null
  GPG_ID=$(gpg --list-secret-keys --keyid-format long 2>/dev/null | grep sec | head -1 | awk '{print $2}' | cut -d/ -f2)
  if [ -n "$GPG_ID" ]; then
    echo "${GPG_ID}:6:" | gpg --import-ownertrust 2>/dev/null
    if [ ! -d "$HOME/.local/share/gopass/stores/root" ]; then
      gopass init --path "$HOME/.local/share/gopass/stores/root" "$GPG_ID" 2>/dev/null
    fi
    echo "[navvi] Gopass ready (imported key: ${GPG_ID:0:8}...)"
  fi
  unset GPG_PRIVATE_KEY
elif [ -n "$(gpg --list-secret-keys 2>/dev/null)" ]; then
  # Existing key from persistent volume (survives container restarts)
  GPG_ID=$(gpg --list-secret-keys --keyid-format long 2>/dev/null | grep sec | head -1 | awk '{print $2}' | cut -d/ -f2)
  if [ -n "$GPG_ID" ] && [ ! -d "$HOME/.local/share/gopass/stores/root" ]; then
    gopass init --path "$HOME/.local/share/gopass/stores/root" "$GPG_ID" 2>/dev/null
  fi
  echo "[navvi] Gopass ready (existing key: ${GPG_ID:0:8}...)"
elif [ -n "${NAVVI_GPG_PASSPHRASE:-}" ]; then
  # Generate a new GPG key protected by the user's passphrase
  echo "[navvi] Generating GPG key for gopass (first boot)..."
  # Generate key in background — don't block container startup
  # Uses Ed25519 (no entropy needed, instant) instead of RSA
  echo "[navvi] Generating GPG key in background..."
  (
    gpg --batch --passphrase "" --quick-generate-key "Navvi <navvi@local>" ed25519 cert never 2>/dev/null
    GPG_FPR=$(gpg --list-secret-keys --with-colons 2>/dev/null | grep fpr | head -1 | cut -d: -f10)
    if [ -n "$GPG_FPR" ]; then
      gpg --batch --passphrase "" --quick-add-key "$GPG_FPR" cv25519 encr never 2>/dev/null
      echo "${GPG_FPR}:6:" | gpg --import-ownertrust 2>/dev/null
      echo "allow-loopback-pinentry" >> "$HOME/.gnupg/gpg-agent.conf" 2>/dev/null
      echo "pinentry-mode loopback" >> "$HOME/.gnupg/gpg.conf" 2>/dev/null
      gpgconf --kill gpg-agent 2>/dev/null
      GPG_ID=$(echo "$GPG_FPR" | tail -c 17)
      gopass init --path "$HOME/.local/share/gopass/stores/root" "$GPG_ID" 2>/dev/null
      echo "[navvi] Gopass ready (new key: ${GPG_ID:0:8}...)"
    fi
  ) &
else
  echo "[navvi] Gopass disabled — set NAVVI_GPG_PASSPHRASE in your .mcp.json env to enable credential management."
  echo "[navvi]   Example: \"NAVVI_GPG_PASSPHRASE\": \"any-random-string-here\""
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

echo "[navvi] Starting window manager..."
openbox &
sleep 0.5

echo "[navvi] Starting Camoufox (Marionette on :2828)..."
camoufox-bin \
  --marionette \
  --no-remote \
  about:blank &
FIREFOX_PID=$!
sleep 2

if ! kill -0 "$FIREFOX_PID" 2>/dev/null; then
  echo "[navvi] ERROR: Camoufox failed to start"
  exit 1
fi

# Maximize browser window to fill the virtual display
echo "[navvi] Maximizing browser window..."
for i in 1 2 3; do
  WID=$(xdotool search --onlyvisible --class "firefox\|Navigator\|camoufox" 2>/dev/null | head -1)
  if [ -n "$WID" ]; then
    xdotool windowactivate "$WID" windowsize "$WID" 1920 1080 windowmove "$WID" 0 0 2>/dev/null
    echo "[navvi] Window $WID maximized"
    break
  fi
  sleep 1
done

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

# Keep alive — wait on the API server (critical process)
# If noVNC or x11vnc crash, the container stays up. Only API server death kills it.
wait $API_PID

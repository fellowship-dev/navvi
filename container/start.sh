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

  # Browser profile (Camoufox uses .camoufox, not .mozilla)
  if [ -d "$PERSIST_DIR/camoufox" ] && [ ! -L "$HOME/.camoufox" ]; then
    rm -rf "$HOME/.camoufox"
    ln -s "$PERSIST_DIR/camoufox" "$HOME/.camoufox"
    echo "[navvi] Browser profile linked to persistent storage"
  elif [ -d "$HOME/.camoufox" ] && [ ! -L "$HOME/.camoufox" ]; then
    cp -a "$HOME/.camoufox" "$PERSIST_DIR/camoufox"
    rm -rf "$HOME/.camoufox"
    ln -s "$PERSIST_DIR/camoufox" "$HOME/.camoufox"
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

# Helper: migrate gopass + GPG to persistent storage after init (Codespaces only).
# Called after gopass init to ensure credentials survive restarts.
persist_gopass() {
  PERSIST_DIR="/workspaces/.codespaces/.persistedshare/navvi"
  [ ! -d "/workspaces/.codespaces/.persistedshare" ] && return 0

  mkdir -p "$PERSIST_DIR"

  # Migrate GPG keyring if not already persisted
  if [ -d "$HOME/.gnupg" ] && [ ! -L "$HOME/.gnupg" ]; then
    cp -a "$HOME/.gnupg" "$PERSIST_DIR/gnupg"
    rm -rf "$HOME/.gnupg"
    ln -s "$PERSIST_DIR/gnupg" "$HOME/.gnupg"
    echo "[navvi] GPG keyring moved to persistent storage"
  fi

  # Migrate gopass store if not already persisted
  if [ -d "$HOME/.local/share/gopass/stores" ] && [ ! -L "$HOME/.local/share/gopass/stores" ]; then
    mkdir -p "$PERSIST_DIR/gopass"
    cp -a "$HOME/.local/share/gopass/stores" "$PERSIST_DIR/gopass/stores"
    rm -rf "$HOME/.local/share/gopass/stores"
    ln -s "$PERSIST_DIR/gopass/stores" "$HOME/.local/share/gopass/stores"
    echo "[navvi] Gopass store moved to persistent storage"
  fi
}

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
    persist_gopass
  fi
  unset GPG_PRIVATE_KEY
elif [ -n "$(gpg --list-secret-keys 2>/dev/null)" ]; then
  # Existing key from persistent volume (survives container restarts)
  GPG_ID=$(gpg --list-secret-keys --keyid-format long 2>/dev/null | grep sec | head -1 | awk '{print $2}' | cut -d/ -f2)
  if [ -n "$GPG_ID" ] && [ ! -d "$HOME/.local/share/gopass/stores/root" ]; then
    gopass init --path "$HOME/.local/share/gopass/stores/root" "$GPG_ID" 2>/dev/null
  fi
  persist_gopass
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
      persist_gopass
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
# Firefox/Camoufox can override window size after initial render,
# so we retry multiple times with increasing delays.
maximize_window() {
  WID=$(DISPLAY="$DISPLAY" xdotool search --name "Firefox" 2>/dev/null | head -1)
  [ -z "$WID" ] && WID=$(DISPLAY="$DISPLAY" xdotool search --name "Camoufox" 2>/dev/null | head -1)
  [ -z "$WID" ] && WID=$(DISPLAY="$DISPLAY" xdotool search --name "about:blank" 2>/dev/null | head -1)
  if [ -n "$WID" ]; then
    DISPLAY="$DISPLAY" xdotool windowactivate "$WID" windowmove "$WID" 0 0 windowsize "$WID" 1920 1080 2>/dev/null
    echo "[navvi] Window $WID maximized to 1920x1080 at 0,0"
    return 0
  fi
  echo "[navvi] No Firefox window found to maximize"
  return 1
}

echo "[navvi] Maximizing browser window..."
for i in 1 2 3 4 5; do
  if maximize_window; then
    break
  fi
  sleep 1
done

# Re-maximize after Firefox finishes restoring its saved window geometry.
(
  for delay in 3 5 8; do
    sleep "$delay"
    maximize_window
  done
) &

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

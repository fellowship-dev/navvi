#!/bin/bash
# Navvi CLI v2 — Docker container lifecycle + navvi-server HTTP API wrapper.
# Usage:
#   ./scripts/navvi.sh start [persona] [--remote]   Start container for persona
#   ./scripts/navvi.sh stop [persona]                Stop container (or all)
#   ./scripts/navvi.sh status                        List running containers
#   ./scripts/navvi.sh open <url>                    Open URL in browser
#   ./scripts/navvi.sh click <x> <y>                 Click at coordinates
#   ./scripts/navvi.sh type <text>                   Type text
#   ./scripts/navvi.sh key <keyname>                 Press key
#   ./scripts/navvi.sh screenshot [output-path]      Capture screenshot
#   ./scripts/navvi.sh vnc                           Show noVNC URL
#   ./scripts/navvi.sh build                         Build the Docker image
#   ./scripts/navvi.sh record start [output]         Start recording
#   ./scripts/navvi.sh record stop                   Stop recording
#   ./scripts/navvi.sh record gif [input] [output]   Convert to GIF

set -euo pipefail

NAVVI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PERSONAS_DIR="$NAVVI_DIR/personas"
CONTAINER_PREFIX="navvi-"
NAVVI_PORT="${NAVVI_PORT:-8024}"
VNC_PORT="${VNC_PORT:-6080}"
IMAGE="${NAVVI_IMAGE:-navvi}"

CMD="${1:?Usage: navvi.sh <command> [args...]}"
shift

# Read a field from a persona YAML (simple grep, no yq dependency)
read_persona_field() {
  local persona="$1" field="$2"
  local file=""
  for ext in .yaml .yml; do
    [ -f "$PERSONAS_DIR/$persona$ext" ] && file="$PERSONAS_DIR/$persona$ext" && break
  done
  [ -z "$file" ] && echo "" && return
  grep "^[[:space:]]*${field}:" "$file" 2>/dev/null | tail -1 | sed "s/.*${field}:[[:space:]]*//" | sed 's/^"\(.*\)"$/\1/'
}

# Get API base URL for a persona's container
get_api() {
  local persona="${1:-default}"
  local port
  port=$(docker inspect --format '{{(index (index .NetworkSettings.Ports "8024/tcp") 0).HostPort}}' "${CONTAINER_PREFIX}${persona}" 2>/dev/null)
  echo "http://127.0.0.1:${port:-$NAVVI_PORT}"
}

case "$CMD" in
  build)
    echo "Building Navvi Docker image..."
    docker build -t "$IMAGE" "$NAVVI_DIR/container/"
    echo "Done. Image: $IMAGE"
    ;;

  start)
    PERSONA="${1:-default}"
    REMOTE=false
    [ "${2:-}" = "--remote" ] && REMOTE=true

    CNAME="${CONTAINER_PREFIX}${PERSONA}"

    # Check if already running
    if docker ps -q --filter "name=$CNAME" 2>/dev/null | grep -q .; then
      API=$(get_api "$PERSONA")
      echo "Already running: $CNAME"
      echo "  API: $API"
      exit 0
    fi

    # Remove stopped container
    docker rm "$CNAME" 2>/dev/null || true

    # Read persona config
    LOCALE=$(read_persona_field "$PERSONA" "locale")
    TIMEZONE=$(read_persona_field "$PERSONA" "timezone")
    VOLUME="navvi-profile-${PERSONA}"

    echo "Starting $PERSONA..."
    docker run -d \
      --name "$CNAME" \
      -p "${NAVVI_PORT}:8024" \
      -p "${VNC_PORT}:6080" \
      -v "${VOLUME}:/home/user/.camoufox" \
      -v "navvi-gpg:/home/user/.gnupg" \
      -v "navvi-gopass:/home/user/.local/share/gopass" \
      -e "LOCALE=${LOCALE:-en-US}" \
      -e "TIMEZONE=${TIMEZONE:-UTC}" \
      "$IMAGE"

    # Wait for API
    echo -n "Waiting for API..."
    for i in $(seq 1 15); do
      if curl -sf "http://127.0.0.1:${NAVVI_PORT}/health" > /dev/null 2>&1; then
        echo " ready!"
        break
      fi
      echo -n "."
      sleep 1
    done

    echo "  API:    http://127.0.0.1:${NAVVI_PORT}"
    echo "  VNC:    http://127.0.0.1:${VNC_PORT}/vnc.html?autoconnect=true"
    echo "  Volume: $VOLUME"
    ;;

  stop)
    PERSONA="${1:-}"
    if [ -z "$PERSONA" ]; then
      CONTAINERS=$(docker ps -q --filter "name=${CONTAINER_PREFIX}" 2>/dev/null)
      if [ -z "$CONTAINERS" ]; then
        echo "No running Navvi containers."
        exit 0
      fi
      docker ps --filter "name=${CONTAINER_PREFIX}" --format '{{.Names}}' | while read -r NAME; do
        docker stop "$NAME" > /dev/null
        docker rm "$NAME" > /dev/null
        echo "Stopped: $NAME"
      done
    else
      CNAME="${CONTAINER_PREFIX}${PERSONA}"
      docker stop "$CNAME" 2>/dev/null && docker rm "$CNAME" 2>/dev/null
      echo "Stopped: $CNAME (profile preserved in navvi-profile-${PERSONA})"
    fi
    ;;

  status)
    CONTAINERS=$(docker ps --filter "name=${CONTAINER_PREFIX}" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null)
    if [ -z "$CONTAINERS" ]; then
      echo "No running Navvi containers."
      echo ""
      echo "Available personas:"
      for f in "$PERSONAS_DIR"/*.yaml "$PERSONAS_DIR"/*.yml; do
        [ -f "$f" ] || continue
        NAME=$(basename "$f" | sed 's/\.\(yaml\|yml\)$//')
        DESC=$(read_persona_field "$NAME" "description")
        echo "  $NAME — ${DESC:-no description}"
      done
      exit 0
    fi
    echo "Running containers:"
    echo "$CONTAINERS" | while IFS=$'\t' read -r NAME STATUS PORTS; do
      PERSONA="${NAME#$CONTAINER_PREFIX}"
      echo "  $PERSONA — $STATUS"
      echo "    $PORTS"
    done
    ;;

  open)
    URL="${1:?Usage: navvi.sh open <url>}"
    API=$(get_api)
    curl -sf -X POST "$API/navigate" \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"$URL\"}" | python3 -m json.tool 2>/dev/null || true
    ;;

  click)
    X="${1:?Usage: navvi.sh click <x> <y>}"
    Y="${2:?Usage: navvi.sh click <x> <y>}"
    API=$(get_api)
    curl -sf -X POST "$API/click" \
      -H "Content-Type: application/json" \
      -d "{\"x\":$X,\"y\":$Y}" | python3 -m json.tool 2>/dev/null || true
    ;;

  type)
    TEXT="${1:?Usage: navvi.sh type <text>}"
    API=$(get_api)
    curl -sf -X POST "$API/type" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"$TEXT\"}" | python3 -m json.tool 2>/dev/null || true
    ;;

  key)
    KEY="${1:?Usage: navvi.sh key <keyname>}"
    API=$(get_api)
    curl -sf -X POST "$API/key" \
      -H "Content-Type: application/json" \
      -d "{\"key\":\"$KEY\"}" | python3 -m json.tool 2>/dev/null || true
    ;;

  screenshot)
    OUTPUT="${1:-/tmp/navvi-screenshot.png}"
    API=$(get_api)
    # Get base64 PNG and decode
    curl -sf "$API/screenshot" | python3 -c "
import json, sys, base64
data = json.load(sys.stdin)
with open('$OUTPUT', 'wb') as f:
    f.write(base64.b64decode(data['base64']))
print('Screenshot saved to $OUTPUT')
"
    ;;

  vnc)
    echo "http://127.0.0.1:${VNC_PORT}/vnc.html?autoconnect=true"
    ;;

  record)
    SUBCMD="${1:?Usage: navvi.sh record start|stop|gif}"
    shift
    PIDFILE="/tmp/.navvi-ffmpeg.pid"
    RECORDINGS_DIR="$NAVVI_DIR/.navvi/recordings"
    mkdir -p "$RECORDINGS_DIR"

    case "$SUBCMD" in
      start)
        if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
          echo "Already recording (PID $(cat "$PIDFILE")). Stop first."
          exit 1
        fi
        TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
        OUTPUT="${1:-$RECORDINGS_DIR/$TIMESTAMP.mp4}"
        echo "Recording via screenshot polling (TODO: implement in v2 CLI)"
        echo "Use MCP tools navvi_record_start / navvi_record_stop instead."
        ;;

      stop)
        echo "Use MCP tool navvi_record_stop."
        ;;

      gif)
        INPUT="${1:-}"
        if [ -z "$INPUT" ]; then
          INPUT=$(ls -t "$RECORDINGS_DIR"/*.mp4 2>/dev/null | head -1)
          if [ -z "$INPUT" ]; then
            echo "Error: no recordings found."
            exit 1
          fi
        fi
        OUTPUT="${2:-${INPUT%.mp4}.gif}"
        echo "Converting to GIF..."
        ffmpeg -y -i "$INPUT" -vf "fps=8,scale=800:-1:flags=lanczos,palettegen" /tmp/.navvi-palette.png </dev/null 2>/dev/null
        ffmpeg -y -i "$INPUT" -i /tmp/.navvi-palette.png \
          -lavfi "fps=8,scale=800:-1:flags=lanczos [x]; [x][1:v] paletteuse" \
          "$OUTPUT" </dev/null 2>/dev/null
        rm -f /tmp/.navvi-palette.png
        SIZE=$(du -sh "$OUTPUT" | cut -f1)
        echo "Done: $OUTPUT ($SIZE)"
        ;;
      *)
        echo "Usage: navvi.sh record start|stop|gif"
        exit 1
        ;;
    esac
    ;;

  *)
    echo "Unknown command: $CMD"
    echo ""
    echo "Lifecycle:"
    echo "  build                        Build Docker image"
    echo "  start [persona] [--remote]   Start container"
    echo "  stop [persona]               Stop container (or all)"
    echo "  status                       List running containers"
    echo ""
    echo "Browser:"
    echo "  open <url>                   Navigate to URL"
    echo "  click <x> <y>               Click at coordinates"
    echo "  type <text>                  Type text"
    echo "  key <keyname>               Press key"
    echo "  screenshot [path]            Capture screenshot"
    echo "  vnc                          Show noVNC URL"
    echo ""
    echo "Recording:"
    echo "  record start                 Start recording (use MCP)"
    echo "  record stop                  Stop recording (use MCP)"
    echo "  record gif [input] [output]  Convert to GIF"
    exit 1
    ;;
esac

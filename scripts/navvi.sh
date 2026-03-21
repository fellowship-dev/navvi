#!/bin/bash
# Navvi CLI — persona lifecycle + PinchTab HTTP API wrapper.
# Usage:
#   ./scripts/navvi.sh up <persona> [--headless]    Launch persona instance
#   ./scripts/navvi.sh down [persona]               Stop instance(s)
#   ./scripts/navvi.sh reset <persona>              Wipe cookies, keep config
#   ./scripts/navvi.sh seed <persona>               Visit seed_urls to build history
#   ./scripts/navvi.sh status                       List running instances
#   ./scripts/navvi.sh open <url>                   Open URL in active tab
#   ./scripts/navvi.sh snapshot                     Get accessibility tree
#   ./scripts/navvi.sh action <type> <ref> [value]  Perform action on element
#   ./scripts/navvi.sh screenshot [output-path]     Capture page screenshot
#   ./scripts/navvi.sh creds <persona> [service]     Look up credentials via gopass
#   ./scripts/navvi.sh login <persona> <service>     Auto-login to a service
#   ./scripts/navvi.sh record start [output]         Start recording VNC display
#   ./scripts/navvi.sh record stop                   Stop recording
#   ./scripts/navvi.sh record gif [input] [output]   Convert recording to GIF

set -euo pipefail

API="http://127.0.0.1:9867"
NAVVI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PERSONAS_DIR="$NAVVI_DIR/.navvi/personas"
PROFILES_DIR="$NAVVI_DIR/.navvi/profiles"

CMD="${1:?Usage: navvi.sh <command> [args...]}"
shift

# Read a field from a persona YAML (simple grep, no yq dependency)
read_persona_field() {
  local persona="$1" field="$2"
  local file="$PERSONAS_DIR/$persona.yml"
  if [ ! -f "$file" ]; then
    echo ""
    return
  fi
  grep "^${field}:" "$file" 2>/dev/null | sed "s/^${field}:[[:space:]]*//" | sed 's/^"\(.*\)"$/\1/'
}

# Get default mode from persona YAML, fallback to headed
get_mode() {
  local persona="$1"
  local mode
  mode=$(grep "mode:" "$PERSONAS_DIR/$persona.yml" 2>/dev/null | tail -1 | sed 's/.*mode:[[:space:]]*//')
  echo "${mode:-headed}"
}

# Get instance ID by persona name
get_instance() {
  local persona="$1"
  curl -sf "$API/instances" 2>/dev/null | jq -r ".[] | select(.name==\"$persona\") | .id // empty" 2>/dev/null
}

# Get first tab of an instance
get_tab() {
  local inst="$1"
  curl -sf "$API/instances/$inst/tabs" 2>/dev/null | jq -r '.[0].id // empty' 2>/dev/null
}

case "$CMD" in
  up)
    PERSONA="${1:?Usage: navvi.sh up <persona> [--headless]}"
    MODE=$(get_mode "$PERSONA")
    [ "${2:-}" = "--headless" ] && MODE="headless"

    # Check if persona definition exists
    if [ ! -f "$PERSONAS_DIR/$PERSONA.yml" ]; then
      echo "Error: persona not found: $PERSONAS_DIR/$PERSONA.yml"
      echo "Available personas:"
      ls "$PERSONAS_DIR"/*.yml 2>/dev/null | xargs -I{} basename {} .yml | sed 's/^/  /'
      exit 1
    fi

    PROFILE_DIR="$PROFILES_DIR/$PERSONA"
    mkdir -p "$PROFILE_DIR"

    # Check if already running
    EXISTING=$(get_instance "$PERSONA")
    if [ -n "$EXISTING" ]; then
      echo "Persona $PERSONA already running (instance: $EXISTING)"
      exit 0
    fi

    echo "Launching $PERSONA ($MODE)..."
    RESULT=$(curl -sf -X POST "$API/instances/launch" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"$PERSONA\",\"mode\":\"$MODE\",\"profile\":\"$PROFILE_DIR\"}")
    ID=$(echo "$RESULT" | jq -r '.id // empty')

    if [ -z "$ID" ]; then
      echo "Error: failed to launch instance"
      echo "$RESULT"
      exit 1
    fi

    DESC=$(read_persona_field "$PERSONA" "description")
    echo "Up: $PERSONA ($DESC)"
    echo "  Instance: $ID"
    echo "  Profile:  $PROFILE_DIR"
    echo "  API:      $API"
    ;;

  down)
    PERSONA="${1:-}"
    if [ -z "$PERSONA" ]; then
      # Stop all instances
      INSTANCES=$(curl -sf "$API/instances" | jq -r '.[].id // empty')
      if [ -z "$INSTANCES" ]; then
        echo "No running instances."
        exit 0
      fi
      echo "$INSTANCES" | while read -r ID; do
        curl -sf -X DELETE "$API/instances/$ID" > /dev/null
        echo "Stopped instance: $ID"
      done
    else
      ID=$(get_instance "$PERSONA")
      if [ -z "$ID" ]; then
        echo "Persona $PERSONA is not running."
        exit 0
      fi
      curl -sf -X DELETE "$API/instances/$ID" > /dev/null
      echo "Down: $PERSONA (instance: $ID)"
    fi
    ;;

  reset)
    PERSONA="${1:?Usage: navvi.sh reset <persona>}"
    PROFILE_DIR="$PROFILES_DIR/$PERSONA"

    # Stop if running
    ID=$(get_instance "$PERSONA")
    if [ -n "$ID" ]; then
      curl -sf -X DELETE "$API/instances/$ID" > /dev/null
      echo "Stopped running instance."
    fi

    # Wipe profile
    if [ -d "$PROFILE_DIR" ]; then
      rm -rf "$PROFILE_DIR"
      echo "Reset: wiped profile for $PERSONA"
    else
      echo "No profile to reset for $PERSONA"
    fi
    ;;

  seed)
    PERSONA="${1:?Usage: navvi.sh seed <persona>}"
    PERSONA_FILE="$PERSONAS_DIR/$PERSONA.yml"
    if [ ! -f "$PERSONA_FILE" ]; then
      echo "Error: persona not found: $PERSONA_FILE"
      exit 1
    fi

    # Check instance is running
    ID=$(get_instance "$PERSONA")
    if [ -z "$ID" ]; then
      echo "Persona $PERSONA is not running. Run: navvi.sh up $PERSONA"
      exit 1
    fi

    # Extract seed_urls from YAML (lines after seed_urls: that start with "  - ")
    URLS=$(sed -n '/^seed_urls:/,/^[^ ]/{ /^  - /p; }' "$PERSONA_FILE" | sed 's/^  - //')
    if [ -z "$URLS" ]; then
      echo "No seed_urls defined for $PERSONA"
      exit 0
    fi

    echo "Seeding $PERSONA with browsing history..."
    echo "$URLS" | while read -r URL; do
      echo "  Visiting: $URL"
      curl -sf -X POST "$API/instances/$ID/tabs/open" \
        -H "Content-Type: application/json" \
        -d "{\"url\":\"$URL\"}" > /dev/null
      sleep 2
    done
    echo "Seed complete."
    ;;

  status)
    INSTANCES=$(curl -sf "$API/instances" 2>/dev/null)
    if [ -z "$INSTANCES" ] || [ "$INSTANCES" = "[]" ]; then
      echo "No running instances."
      echo ""
      echo "Available personas:"
      ls "$PERSONAS_DIR"/*.yml 2>/dev/null | while read -r F; do
        NAME=$(basename "$F" .yml)
        DESC=$(read_persona_field "$NAME" "description")
        echo "  $NAME — $DESC"
      done
      exit 0
    fi
    echo "Running instances:"
    echo "$INSTANCES" | jq -r '.[] | "  \(.name) — \(.id) (\(.mode // "unknown"))"'
    ;;

  open)
    URL="${1:?Usage: navvi.sh open <url>}"
    INST=$(curl -sf "$API/instances" | jq -r '.[0].id // empty')
    if [ -z "$INST" ]; then
      echo "Error: no running instance. Run: navvi.sh up <persona>"
      exit 1
    fi
    curl -sf -X POST "$API/instances/$INST/tabs/open" \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"$URL\"}" | jq .
    ;;

  snapshot)
    INST=$(curl -sf "$API/instances" | jq -r '.[0].id // empty')
    TAB=$(get_tab "$INST")
    if [ -z "$TAB" ]; then
      echo "Error: no open tab"
      exit 1
    fi
    curl -sf "$API/tabs/$TAB/snapshot" | jq .
    ;;

  action)
    TYPE="${1:?Usage: navvi.sh action <type> <ref> [value]}"
    REF="${2:?Usage: navvi.sh action <type> <ref> [value]}"
    VALUE="${3:-}"
    INST=$(curl -sf "$API/instances" | jq -r '.[0].id // empty')
    TAB=$(get_tab "$INST")
    BODY="{\"type\":\"$TYPE\",\"ref\":\"$REF\""
    [ -n "$VALUE" ] && BODY="$BODY,\"value\":\"$VALUE\""
    BODY="$BODY}"
    curl -sf -X POST "$API/tabs/$TAB/action" \
      -H "Content-Type: application/json" \
      -d "$BODY" | jq .
    ;;

  screenshot)
    OUTPUT="${1:-/tmp/navvi-screenshot.png}"
    INST=$(curl -sf "$API/instances" | jq -r '.[0].id // empty')
    TAB=$(get_tab "$INST")
    curl -sf "$API/tabs/$TAB/screenshot" -o "$OUTPUT"
    echo "Screenshot saved to $OUTPUT"
    ;;

  creds)
    PERSONA="${1:?Usage: navvi.sh creds <persona> [service]}"
    SERVICE="${2:-}"
    GOPASS_PATH="navvi/$PERSONA"

    if ! command -v gopass &>/dev/null; then
      echo "Error: gopass not installed"
      exit 1
    fi

    if [ -n "$SERVICE" ]; then
      # Show specific service credentials
      if ! gopass show "$GOPASS_PATH/$SERVICE" 2>/dev/null; then
        echo "Error: no credentials at $GOPASS_PATH/$SERVICE"
        echo "Add with: gopass insert $GOPASS_PATH/$SERVICE"
        exit 1
      fi
    else
      # List available credentials for this persona
      echo "Credentials for $PERSONA:"
      gopass ls "$GOPASS_PATH" 2>/dev/null || echo "  (none — add with: gopass insert $GOPASS_PATH/<service>)"
    fi
    ;;

  login)
    PERSONA="${1:?Usage: navvi.sh login <persona> <service>}"
    SERVICE="${2:?Usage: navvi.sh login <persona> <service>}"
    GOPASS_PATH="navvi/$PERSONA/$SERVICE"

    # Check instance is running
    ID=$(get_instance "$PERSONA")
    if [ -z "$ID" ]; then
      echo "Error: persona $PERSONA is not running. Run: navvi.sh up $PERSONA"
      exit 1
    fi

    # Get credentials from gopass
    PASS_OUTPUT=$(gopass show "$GOPASS_PATH" 2>/dev/null)
    if [ -z "$PASS_OUTPUT" ]; then
      echo "Error: no credentials at $GOPASS_PATH"
      exit 1
    fi

    PASSWORD=$(echo "$PASS_OUTPUT" | head -1)
    USERNAME=$(echo "$PASS_OUTPUT" | grep "^username:" | sed 's/^username:[[:space:]]*//')
    URL=$(echo "$PASS_OUTPUT" | grep "^url:" | sed 's/^url:[[:space:]]*//')
    TOTP_URI=$(echo "$PASS_OUTPUT" | grep "^totp:" | sed 's/^totp:[[:space:]]*//')

    echo "Login: $PERSONA → $SERVICE"
    [ -n "$URL" ] && echo "  URL:      $URL"
    [ -n "$USERNAME" ] && echo "  Username: $USERNAME"
    echo "  Password: ****"
    [ -n "$TOTP_URI" ] && echo "  TOTP:     available"

    # Output credentials as JSON for agent consumption (not to terminal)
    # Agent reads this to fill forms via PinchTab actions
    CREDS_JSON="{\"service\":\"$SERVICE\""
    [ -n "$USERNAME" ] && CREDS_JSON="$CREDS_JSON,\"username\":\"$USERNAME\""
    CREDS_JSON="$CREDS_JSON,\"password\":\"$PASSWORD\""
    [ -n "$URL" ] && CREDS_JSON="$CREDS_JSON,\"url\":\"$URL\""
    if [ -n "$TOTP_URI" ]; then
      TOTP_CODE=$(gopass otp "$GOPASS_PATH" 2>/dev/null || echo "")
      [ -n "$TOTP_CODE" ] && CREDS_JSON="$CREDS_JSON,\"totp\":\"$TOTP_CODE\""
    fi
    CREDS_JSON="$CREDS_JSON}"

    # Write to temp file for agent to read, not stdout
    CREDS_FILE="/tmp/.navvi-creds-$$"
    echo "$CREDS_JSON" > "$CREDS_FILE"
    echo "  Credentials written to $CREDS_FILE (auto-deleted in 30s)"

    # Auto-delete after 30s
    (sleep 30 && rm -f "$CREDS_FILE") &
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
          echo "Already recording (PID $(cat "$PIDFILE")). Stop first with: navvi.sh record stop"
          exit 1
        fi

        TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
        OUTPUT="${1:-$RECORDINGS_DIR/$TIMESTAMP.mp4}"

        # Record VNC display :1 at 10fps, decent quality
        ffmpeg -y -f x11grab -video_size 1280x720 -framerate 10 \
          -i :1 -c:v libx264 -preset ultrafast -crf 23 \
          -pix_fmt yuv420p "$OUTPUT" </dev/null >/dev/null 2>&1 &
        echo $! > "$PIDFILE"

        echo "Recording started"
        echo "  Output: $OUTPUT"
        echo "  PID:    $(cat "$PIDFILE")"
        echo "  Stop:   navvi.sh record stop"
        ;;

      stop)
        if [ ! -f "$PIDFILE" ]; then
          echo "No active recording."
          exit 0
        fi

        PID=$(cat "$PIDFILE")
        if kill -0 "$PID" 2>/dev/null; then
          # Send SIGINT for clean ffmpeg shutdown
          kill -INT "$PID" 2>/dev/null
          # Wait up to 5s for clean exit
          for i in 1 2 3 4 5; do
            kill -0 "$PID" 2>/dev/null || break
            sleep 1
          done
          kill -9 "$PID" 2>/dev/null || true
          echo "Recording stopped (PID $PID)"
        else
          echo "Recording process already ended."
        fi
        rm -f "$PIDFILE"

        # Show the most recent recording
        LATEST=$(ls -t "$RECORDINGS_DIR"/*.mp4 2>/dev/null | head -1)
        if [ -n "$LATEST" ]; then
          SIZE=$(du -sh "$LATEST" | cut -f1)
          DURATION=$(ffprobe -v quiet -show_entries format=duration -of csv=p=0 "$LATEST" 2>/dev/null | cut -d. -f1)
          echo "  File:     $LATEST"
          echo "  Size:     $SIZE"
          [ -n "$DURATION" ] && echo "  Duration: ${DURATION}s"
          echo "  To GIF:   navvi.sh record gif $LATEST"
        fi
        ;;

      gif)
        INPUT="${1:-}"
        if [ -z "$INPUT" ]; then
          # Use most recent recording
          INPUT=$(ls -t "$RECORDINGS_DIR"/*.mp4 2>/dev/null | head -1)
          if [ -z "$INPUT" ]; then
            echo "Error: no recordings found. Record first with: navvi.sh record start"
            exit 1
          fi
        fi

        OUTPUT="${2:-${INPUT%.mp4}.gif}"

        echo "Converting to GIF..."
        echo "  Input:  $INPUT"
        echo "  Output: $OUTPUT"

        # Two-pass for good quality: generate palette, then use it
        ffmpeg -y -i "$INPUT" -vf "fps=8,scale=800:-1:flags=lanczos,palettegen" \
          /tmp/.navvi-palette.png </dev/null 2>/dev/null
        ffmpeg -y -i "$INPUT" -i /tmp/.navvi-palette.png \
          -lavfi "fps=8,scale=800:-1:flags=lanczos [x]; [x][1:v] paletteuse" \
          "$OUTPUT" </dev/null 2>/dev/null
        rm -f /tmp/.navvi-palette.png

        SIZE=$(du -sh "$OUTPUT" | cut -f1)
        echo "  Done: $OUTPUT ($SIZE)"
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
    echo "  up <persona> [--headless]    Launch persona instance"
    echo "  down [persona]               Stop instance (or all)"
    echo "  reset <persona>              Wipe cookies, keep config"
    echo "  seed <persona>               Visit seed_urls for history"
    echo "  status                       List running instances"
    echo ""
    echo "Browser:"
    echo "  open <url>                   Open URL"
    echo "  snapshot                     Get accessibility tree"
    echo "  action <type> <ref> [value]  Click, fill, etc."
    echo "  screenshot [path]            Capture page"
    echo ""
    echo "Recording:"
    echo "  record start [output]        Start recording VNC display"
    echo "  record stop                  Stop recording"
    echo "  record gif [input] [output]  Convert recording to GIF"
    echo ""
    echo "Credentials:"
    echo "  creds <persona> [service]    Look up gopass credentials"
    echo "  login <persona> <service>    Get credentials for auto-login"
    exit 1
    ;;
esac

#!/bin/bash
# Navvi CLI — thin wrapper around PinchTab HTTP API.
# Usage:
#   ./scripts/navvi.sh launch <persona> [--headed]
#   ./scripts/navvi.sh open <url>
#   ./scripts/navvi.sh snapshot
#   ./scripts/navvi.sh action <type> <ref> [value]
#   ./scripts/navvi.sh screenshot [output-path]
#   ./scripts/navvi.sh status

API="http://127.0.0.1:9867"
CMD="${1:?Usage: navvi.sh <command> [args...]}"
shift

case "$CMD" in
  launch)
    PERSONA="${1:-default}"
    MODE="headless"
    [ "$2" = "--headed" ] && MODE="headed"
    PROFILE_DIR="$(pwd)/.navvi/profiles/$PERSONA"
    mkdir -p "$PROFILE_DIR"
    RESULT=$(curl -sf -X POST "$API/instances/launch" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"$PERSONA\",\"mode\":\"$MODE\",\"profile\":\"$PROFILE_DIR\"}")
    echo "$RESULT" | jq -r '.id // "Error: could not launch instance"'
    ;;

  open)
    URL="${1:?Usage: navvi.sh open <url>}"
    INST=$(curl -sf "$API/instances" | jq -r '.[0].id // empty')
    if [ -z "$INST" ]; then
      echo "Error: no running instance. Run: navvi.sh launch <persona>"
      exit 1
    fi
    curl -sf -X POST "$API/instances/$INST/tabs/open" \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"$URL\"}" | jq .
    ;;

  snapshot)
    INST=$(curl -sf "$API/instances" | jq -r '.[0].id // empty')
    TAB=$(curl -sf "$API/instances/$INST/tabs" | jq -r '.[0].id // empty')
    if [ -z "$TAB" ]; then
      echo "Error: no open tab"
      exit 1
    fi
    curl -sf "$API/tabs/$TAB/snapshot" | jq .
    ;;

  action)
    TYPE="${1:?Usage: navvi.sh action <type> <ref> [value]}"
    REF="${2:?Usage: navvi.sh action <type> <ref> [value]}"
    VALUE="$3"
    INST=$(curl -sf "$API/instances" | jq -r '.[0].id // empty')
    TAB=$(curl -sf "$API/instances/$INST/tabs" | jq -r '.[0].id // empty')
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
    TAB=$(curl -sf "$API/instances/$INST/tabs" | jq -r '.[0].id // empty')
    curl -sf "$API/tabs/$TAB/screenshot" -o "$OUTPUT"
    echo "Screenshot saved to $OUTPUT"
    ;;

  status)
    curl -sf "$API/instances" | jq .
    ;;

  *)
    echo "Unknown command: $CMD"
    echo "Commands: launch, open, snapshot, action, screenshot, status"
    exit 1
    ;;
esac

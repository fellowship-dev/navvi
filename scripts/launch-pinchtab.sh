#!/bin/bash
# Launch PinchTab server for a given persona.
# Usage: ./scripts/launch-pinchtab.sh [persona-name] [--headed]
#
# PinchTab manages its own Chrome instance with stealth injection.
# Profile stored in .navvi/profiles/<persona>/

PERSONA="${1:-default}"
MODE="headless"
if [ "$2" = "--headed" ]; then
  MODE="headed"
fi

PROFILE_DIR="$(pwd)/.navvi/profiles/$PERSONA"
mkdir -p "$PROFILE_DIR"

echo "Launching PinchTab for persona: $PERSONA ($MODE)"
echo "  Profile:  $PROFILE_DIR"
echo "  API:      http://127.0.0.1:9867"
echo ""

# Start PinchTab server
exec pinchtab server \
  --profile "$PROFILE_DIR" \
  --mode "$MODE"

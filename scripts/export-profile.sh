#!/bin/bash
# Export a persona's browser profile as a tar archive.
# Usage: ./scripts/export-profile.sh <persona-name> [output-path]
#
# For backup/restore across Codespace rebuilds.

PERSONA="${1:?Usage: export-profile.sh <persona-name> [output-path]}"
PROFILE_DIR="$(pwd)/.navvi/profiles/$PERSONA"
OUTPUT="${2:-/tmp/$PERSONA-profile.tar.gz}"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "Error: profile directory not found: $PROFILE_DIR"
  exit 1
fi

tar -czf "$OUTPUT" -C ".navvi/profiles" "$PERSONA"
echo "Exported $PERSONA profile to $OUTPUT ($(du -sh "$OUTPUT" | cut -f1))"

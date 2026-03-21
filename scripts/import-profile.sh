#!/bin/bash
# Import a persona's browser profile from a tar archive.
# Usage: ./scripts/import-profile.sh <archive-path>
#
# Extracts into .navvi/profiles/<persona-name>/

ARCHIVE="${1:?Usage: import-profile.sh <archive-path>}"

if [ ! -f "$ARCHIVE" ]; then
  echo "Error: archive not found: $ARCHIVE"
  exit 1
fi

tar -xzf "$ARCHIVE" -C ".navvi/profiles"
echo "Imported profile from $ARCHIVE"
ls -d .navvi/profiles/*/

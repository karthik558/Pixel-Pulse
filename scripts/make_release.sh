#!/usr/bin/env zsh
set -euo pipefail

# Resolve repo root (script is in scripts/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Check requirements
if ! command -v zip >/dev/null 2>&1; then
  echo "Error: 'zip' command not found. Please install zip and retry." >&2
  exit 1
fi

# Extract version from manifest.json
# Prefer jq, then python3, then awk fallback (portable on macOS/BSD)
if [[ ! -f manifest.json ]]; then
  echo "Error: manifest.json not found in $ROOT_DIR" >&2
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  VERSION=$(jq -r '.version // empty' manifest.json)
else
  if command -v python3 >/dev/null 2>&1; then
    VERSION=$(python3 - <<'PY'
import json,sys
with open('manifest.json','r',encoding='utf-8') as f:
    data=json.load(f)
v=str(data.get('version','')).strip()
print(v)
PY
)
  else
    # awk fallback: find the version line and strip everything but the value
    VERSION=$(awk '
      BEGIN{v=""}
      /"version"[[:space:]]*:/ {
        line=$0
        sub(/.*"version"[[:space:]]*:[[:space:]]*"/,"",line)
        sub(/".*/,"",line)
        v=line; print v; exit
      }
    ' manifest.json)
  fi
fi

if [[ -z "${VERSION:-}" ]]; then
  echo "Error: Could not parse version from manifest.json" >&2
  exit 1
fi

ZIP_NAME="Pixel-Pulse_${VERSION}.zip"

# Remove any existing archive of the same name
rm -f "$ZIP_NAME"

# Create archive from repo root, excluding development files
# -X strips extra file attributes for consistent zips
zip -r -X "$ZIP_NAME" . \
  -x ".git/*" \
  -x ".gitignore" \
  -x "scripts/*" \
  -x "scripts/" \
  -x "Pixel-Pulse_*.zip" \
  -x "*.DS_Store"

# Summary
COUNT=$(zipinfo -1 "$ZIP_NAME" | wc -l | tr -d ' ')
echo "Created $ZIP_NAME ($COUNT files)"

#!/bin/bash
# claude-md-guard: PreToolUse hook that blocks invalid writes to CLAUDE.md / AGENTS.md.
# Reads JSON from stdin. Exit 0 = allow, exit 2 + stderr = block.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/config.sh"

INPUT=$(cat)

json_value() {
  local key="$1"
  INPUT_JSON="$INPUT" python3 - "$key" <<'PY'
import json
import os
import sys

key = sys.argv[1]
try:
    data = json.loads(os.environ.get("INPUT_JSON", ""))
except json.JSONDecodeError:
    print("")
    raise SystemExit(0)

value = data
for part in key.split("."):
    if isinstance(value, dict):
        value = value.get(part)
    else:
        value = None
        break

if value is None:
    print("")
elif isinstance(value, bool):
    print("true" if value else "false")
else:
    print(value)
PY
}

FILE_PATH="$(json_value "tool_input.file_path")"
TOOL_NAME="$(json_value "tool_name")"

TARGET_FILE="$(basename "$FILE_PATH")"

# Only guard CLAUDE.md and AGENTS.md
if [[ "$TARGET_FILE" != "CLAUDE.md" && "$TARGET_FILE" != "AGENTS.md" ]]; then
  exit 0
fi

# --- Build the proposed file content in a temp file ---
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

if [ "$TOOL_NAME" = "Write" ]; then
  json_value "tool_input.content" > "$TMP"
elif [ "$TOOL_NAME" = "Edit" ]; then
  if [ ! -f "$FILE_PATH" ]; then
    exit 0  # new file, nothing to validate against
  fi
  OLD_STRING="$(json_value "tool_input.old_string")"
  NEW_STRING="$(json_value "tool_input.new_string")"
  REPLACE_ALL="$(json_value "tool_input.replace_all")"
  if [ -z "$REPLACE_ALL" ]; then
    REPLACE_ALL="false"
  fi

  # Build proposed content by applying the edit
  if [ "$REPLACE_ALL" = "true" ]; then
    python3 -c "
import sys
with open(sys.argv[1]) as f:
    content = f.read()
print(content.replace(sys.argv[2], sys.argv[3]), end='')
" "$FILE_PATH" "$OLD_STRING" "$NEW_STRING" > "$TMP"
  else
    python3 -c "
import sys
with open(sys.argv[1]) as f:
    content = f.read()
print(content.replace(sys.argv[2], sys.argv[3], 1), end='')
" "$FILE_PATH" "$OLD_STRING" "$NEW_STRING" > "$TMP"
  fi
else
  exit 0  # unknown tool, allow
fi

# --- Validate the proposed content ---
ERRORS=()

# Rule: max lines
LINE_COUNT=$(wc -l < "$TMP" | tr -d ' ')
if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
  ERRORS+=("File would have $LINE_COUNT lines (maximum $MAX_LINES)")
fi

# Rule: only allowed top-level headings
while IFS= read -r heading; do
  if ! echo "$ALLOWED_HEADINGS" | grep -qxF "$heading"; then
    ERRORS+=("Unknown heading: \"$heading\"")
  fi
done < <(grep '^# ' "$TMP" | grep -v '^## ')

# Rule: sections requiring items must have at least one
while IFS= read -r section; do
  ITEM_COUNT=$(sed -n "/^${section//\//\\/}$/,/^# /p" "$TMP" | grep -c '^- ' || true)
  if [ "$ITEM_COUNT" -eq 0 ]; then
    ERRORS+=("$section has 0 items (expected lines starting with -)")
  fi
done <<< "$SECTIONS_REQUIRING_ITEMS"

# Rule: minimum backlog items
BACKLOG_ITEMS=$(sed -n '/^# Backlog/,/^# /p' "$TMP" | grep -c '^- ' || true)
if [ "$BACKLOG_ITEMS" -lt "$MIN_BACKLOG_ITEMS" ]; then
  ERRORS+=("Backlog has $BACKLOG_ITEMS items (minimum $MIN_BACKLOG_ITEMS)")
fi

# Rule: <- current marker
HAS_CURRENT=$(grep -c '<- current' "$TMP" || true)
if [ "$HAS_CURRENT" -lt "$MIN_CURRENT_MARKERS" ]; then
  ERRORS+=("Missing '<- current' marker (need at least $MIN_CURRENT_MARKERS)")
fi

# --- Result ---
if [ ${#ERRORS[@]} -gt 0 ]; then
  {
    echo "${TARGET_FILE} validation failed:"
    for e in "${ERRORS[@]}"; do
      echo "  - $e"
    done
  } >&2
  exit 2
fi

exit 0

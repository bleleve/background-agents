#!/usr/bin/env bash
# Create a new fork-local D1 migration with a UTC timestamp prefix.
#
# The numeric NNNN_ range is reserved for upstream (ColeMurray/background-agents).
# Fork migrations use YYYYMMDDHHMMSS_ prefixes so they never collide with upstream's
# sequence when merging. See docs/MIGRATIONS.md.
#
# Usage: scripts/new-migration.sh <snake_case_name>
set -euo pipefail

NAME="${1:?Usage: new-migration.sh <snake_case_name>}"

if ! echo "$NAME" | grep -qE '^[a-z0-9]+(_[a-z0-9]+)*$'; then
  echo "error: name must be snake_case (lowercase, digits, underscores): '$NAME'" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FORK_DIR="$SCRIPT_DIR/../terraform/d1/migrations/fork"
mkdir -p "$FORK_DIR"
TIMESTAMP=$(date -u +%Y%m%d%H%M%S)
FILE="$FORK_DIR/${TIMESTAMP}_${NAME}.sql"

if [ -e "$FILE" ]; then
  echo "error: $FILE already exists (two migrations in the same second?)" >&2
  exit 1
fi

cat > "$FILE" <<EOF
-- ${NAME}
-- Created $(date -u +%Y-%m-%dT%H:%M:%SZ). Fork-local migration (timestamp namespace).
EOF

echo "Created $FILE"

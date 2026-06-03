#!/usr/bin/env bash
# Validate D1 migration filenames across the upstream root and the fork/ subdirectory.
#
# Layout:
#   terraform/d1/migrations/*.sql       -> upstream, numeric NNNN_ prefixes
#   terraform/d1/migrations/fork/*.sql  -> fork-local, timestamp YYYYMMDDHHMMSS_ prefixes
#
# Migrations are keyed by their leading prefix. Two files with the same prefix collide
# silently (d1-migrate.sh applies one, skips the other). This guard turns that into a hard
# error, both at apply time (called by d1-migrate.sh) and in CI (on every PR). It also
# enforces that fork/ files use timestamp prefixes so the numeric range stays upstream-only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${1:-$SCRIPT_DIR/../terraform/d1/migrations}"
FORK_DIR="$MIGRATIONS_DIR/fork"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "error: migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 1
fi

prefixes=""
collect() {
  local dir="$1"
  for file in "$dir"/*.sql; do
    [ -f "$file" ] || continue
    local filename prefix
    filename=$(basename "$file")
    prefix=$(echo "$filename" | grep -oE '^[0-9]+' || true)
    if [ -z "$prefix" ]; then
      echo "error: migration has no numeric/timestamp prefix: $filename" >&2
      exit 1
    fi
    # Fork migrations must use a 14-digit timestamp prefix (run scripts/new-migration.sh).
    if [ "$dir" = "$FORK_DIR" ] && [ "${#prefix}" -ne 14 ]; then
      echo "error: fork migration must use a YYYYMMDDHHMMSS timestamp prefix: $filename" >&2
      exit 1
    fi
    prefixes="$prefixes$prefix"$'\n'
  done
}

collect "$MIGRATIONS_DIR"
[ -d "$FORK_DIR" ] && collect "$FORK_DIR"

duplicates=$(printf '%s' "$prefixes" | sort | uniq -d)

if [ -n "$duplicates" ]; then
  echo "$duplicates" | while read -r dup; do
    [ -n "$dup" ] || continue
    echo "error: duplicate migration prefix '$dup' — multiple files share it:" >&2
    for file in "$MIGRATIONS_DIR"/$dup*.sql "$FORK_DIR"/$dup*.sql; do
      [ -f "$file" ] && echo "  - $file" >&2
    done
  done
  echo "" >&2
  echo "Fork migrations must use timestamp prefixes (run scripts/new-migration.sh)." >&2
  echo "The numeric NNNN_ range is reserved for upstream. See docs/MIGRATIONS.md." >&2
  exit 1
fi

total=$(printf '%s' "$prefixes" | grep -c . || true)
echo "OK: $total migrations, no duplicate prefixes."

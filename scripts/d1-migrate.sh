#!/usr/bin/env bash
set -euo pipefail

DATABASE_NAME="${1:?Usage: d1-migrate.sh <database-name> [migrations-dir]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${2:-$SCRIPT_DIR/../terraform/d1/migrations}"
# Fork-local migrations (timestamp-prefixed) live in a subdirectory so they never share
# a path with upstream's numeric migrations. They apply after all upstream migrations.
FORK_DIR="$MIGRATIONS_DIR/fork"
RECONCILE_FILE="$FORK_DIR/.reconcile.tsv"

WRANGLER="npx wrangler"

# 0. Fail loudly on duplicate prefixes instead of silently skipping a migration.
bash "$SCRIPT_DIR/validate-migrations.sh" "$MIGRATIONS_DIR"

# 1. Ensure tracking table exists
$WRANGLER d1 execute "$DATABASE_NAME" --remote \
  --command "CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )"

# 2. Replay renames of already-applied fork migrations (numeric prefix -> timestamp).
#    Each UPDATE re-keys the tracking row to the new version AND frees the old numeric
#    prefix so upstream can reuse it without being silently skipped. Idempotent.
if [ -f "$RECONCILE_FILE" ]; then
  while IFS=$'\t' read -r OLD_VERSION OLD_NAME NEW_VERSION NEW_NAME; do
    case "$OLD_VERSION" in '' | \#*) continue ;; esac
    [ -n "$NEW_VERSION" ] || continue
    esc() { echo "$1" | sed "s/'/''/g"; }
    $WRANGLER d1 execute "$DATABASE_NAME" --remote --command \
      "UPDATE _schema_migrations
         SET version = '$(esc "$NEW_VERSION")', name = '$(esc "$NEW_NAME")'
       WHERE version = '$(esc "$OLD_VERSION")' AND name = '$(esc "$OLD_NAME")'
         AND NOT EXISTS (SELECT 1 FROM _schema_migrations WHERE version = '$(esc "$NEW_VERSION")')"
  done < "$RECONCILE_FILE"
fi

# 3. Get applied versions (parse JSON output)
APPLIED=$($WRANGLER d1 execute "$DATABASE_NAME" --remote \
  --command "SELECT version FROM _schema_migrations ORDER BY version" \
  --json | jq -r '.[0].results[].version // empty' 2>/dev/null || echo "")

# 4. Apply pending migrations in order: upstream (root) first, then fork.
COUNT=0
for file in "$MIGRATIONS_DIR"/*.sql "$FORK_DIR"/*.sql; do
  [ -f "$file" ] || continue
  FILENAME=$(basename "$file")
  VERSION=$(echo "$FILENAME" | grep -oE '^[0-9]+')

  if echo "$APPLIED" | grep -qxF "$VERSION"; then
    echo "Skip (already applied): $FILENAME"
    continue
  fi

  echo "Applying: $FILENAME"
  $WRANGLER d1 execute "$DATABASE_NAME" --remote --file "$file"

  SAFE_FILENAME=$(echo "$FILENAME" | sed "s/'/''/g")
  $WRANGLER d1 execute "$DATABASE_NAME" --remote \
    --command "INSERT INTO _schema_migrations (version, name) VALUES ('$VERSION', '$SAFE_FILENAME')"

  COUNT=$((COUNT + 1))
done

echo "Done. Applied $COUNT migration(s)."

#!/usr/bin/env bash
#
# Seeds the development database if it needs it, then runs the given command.
#
# Re-seeds when the database is missing, or when SEED_PROFILE names a different
# profile than the one already in /data. That second case is the one that
# matters day to day: `SEED_PROFILE=edge-cases npm run dev:docker` should give
# you edge cases, not silently keep yesterday's realistic data because a file
# happened to exist.
set -euo pipefail

DB_PATH="${SEED_DB_PATH:-/data/dev.db}"
PROFILE="${SEED_PROFILE:-realistic}"
MARKER="${DB_PATH}.profile"

current=""
if [ -f "$MARKER" ]; then
  current="$(cat "$MARKER")"
fi

if [ ! -f "$DB_PATH" ]; then
  echo "entrypoint: no database at $DB_PATH — seeding '$PROFILE'"
  node scripts/seed/index.ts --profile "$PROFILE" --out "$DB_PATH"
elif [ "$current" != "$PROFILE" ]; then
  echo "entrypoint: database holds '${current:-unknown}', want '$PROFILE' — reseeding"
  node scripts/seed/index.ts --profile "$PROFILE" --out "$DB_PATH"
else
  echo "entrypoint: reusing $DB_PATH (profile '$current')"
fi

exec "$@"

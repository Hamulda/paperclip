#!/usr/bin/env bash
set -euo pipefail

# Reset Paperclip test database — drops, recreates, and migrates from scratch
# Usage: ./scripts/reset-test-db.sh [--skip-confirm]
#
# WARNING: This deletes ALL data in paperclip_test!
# Requires: TEST_DATABASE_URL env var pointing to the test database
#
# IMPORTANT: If using Postgres 15+, NULLS NOT DISTINCT syntax requires PG 15+.
# If migrations fail with "syntax error at or near NULLS", ensure PG 15+ is running.
#
# Example: ensure Postgres 15 is running on port 5434 (not the default 5432):
#   /opt/homebrew/opt/postgresql@15/bin/postgres -D /opt/homebrew/var/postgresql@15 -p 5434
#
# Then set: TEST_DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:5434/paperclip_test

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_URL="${TEST_DATABASE_URL:-}"

if [[ -z "$DB_URL" ]]; then
  echo "ERROR: TEST_DATABASE_URL is not set"
  echo "Did you forget to source .env.local?"
  exit 1
fi

# Parse DB name from URL for DROP DATABASE
DB_NAME="$(echo "$DB_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')"
DB_HOST="$(echo "$DB_URL" | sed -n 's|.*//[^@]*@\([^:]*\):.*|\1|p')"
DB_PORT="$(echo "$DB_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')"
DB_USER="$(echo "$DB_URL" | sed -n 's|.*//\([^:]*\):.*|\1|p')"
DB_PASS="$(echo "$DB_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')"

SKIP_CONFIRM="${1:-}"

if [[ "$SKIP_CONFIRM" != "--skip-confirm" ]]; then
  echo "=============================================="
  echo "DANGER: This will DELETE all data in: $DB_NAME"
  echo "=============================================="
  echo ""
  echo "Tables that will be dropped:"
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
    -c "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '%pg_%' AND tablename NOT LIKE '%sql_%'" 2>/dev/null || true
  echo ""
  read -p "Type 'yes' to confirm: " confirm
  if [[ "$confirm" != "yes" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo ">>> Dropping database: $DB_NAME"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$DB_NAME\"" 2>/dev/null

echo ">>> Creating database: $DB_NAME"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres \
  -c "CREATE DATABASE \"$DB_NAME\"" 2>/dev/null

echo ">>> Running migrations..."
cd "$PROJECT_ROOT"
npx tsx packages/db/src/migrate.ts 2>&1 | tail -20

echo ""
echo ">>> Verifying schema..."
echo "Companies columns:"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='companies' ORDER BY ordinal_position" 2>/dev/null

echo ""
echo "Agents columns:"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='agents' ORDER BY ordinal_position" 2>/dev/null

echo ""
echo "Tables:"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -c "\dt" 2>/dev/null

echo ""
echo "Migration entries:"
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT schemaname, tablename, tableowner FROM pg_tables WHERE tablename LIKE '%drizzle%'" 2>/dev/null

echo ""
echo ">>> Running test suite..."
pnpm test -- --run 2>&1 | tail -10

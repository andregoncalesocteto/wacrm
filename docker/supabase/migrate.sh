#!/bin/bash
# Applies supabase/migrations/*.sql once each, in filename order.
set -euo pipefail

psql -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.wacrm_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

applied=0
for f in /migrations/*.sql; do
  name=$(basename "$f")
  done_already=$(psql -tAc "SELECT 1 FROM public.wacrm_migrations WHERE name = '$name'")
  [ -n "$done_already" ] && continue
  echo "applying $name"
  # One transaction per file: a failed migration leaves nothing half-applied
  # and is not recorded, so fixing the file and re-running retries it.
  psql -v ON_ERROR_STOP=1 -q --single-transaction -f "$f" \
    -c "INSERT INTO public.wacrm_migrations (name) VALUES ('$name')"
  applied=$((applied + 1))
done
echo "migrations: $applied applied"

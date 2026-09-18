#!/usr/bin/env bash
# Writes .env.local from .env.docker.example with freshly generated secrets.
# Refuses to overwrite: rotating JWT_SECRET/ENCRYPTION_KEY on a live install
# invalidates sessions and orphans stored WhatsApp tokens.
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -e .env.local ] && { echo ".env.local already exists — not touching it." >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() { # $1 = role
  local h p s
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  p=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$1" "$(date +%s)" "$(( $(date +%s) + 315360000 ))" | b64url)
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)
  printf '%s.%s.%s' "$h" "$p" "$s"
}
hex() { openssl rand -hex "$1"; }

JWT_SECRET=$(hex 24)
ANON=$(jwt anon)
SERVICE=$(jwt service_role)

sed \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex 16)|" \
  -e "s|^JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" \
  -e "s|^ANON_KEY=.*|ANON_KEY=$ANON|" \
  -e "s|^NEXT_PUBLIC_SUPABASE_ANON_KEY=.*|NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON|" \
  -e "s|^SERVICE_ROLE_KEY=.*|SERVICE_ROLE_KEY=$SERVICE|" \
  -e "s|^SUPABASE_SERVICE_ROLE_KEY=.*|SUPABASE_SERVICE_ROLE_KEY=$SERVICE|" \
  -e "s|^SECRET_KEY_BASE=.*|SECRET_KEY_BASE=$(hex 32)|" \
  -e "s|^DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=$(hex 12)|" \
  -e "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$(hex 32)|" \
  -e "s|^AUTOMATION_CRON_SECRET=.*|AUTOMATION_CRON_SECRET=$(hex 32)|" \
  .env.docker.example > .env.local

echo "Wrote .env.local. Still to fill in by hand: META_APP_SECRET (and SMTP_* if you disable auto-confirm)."

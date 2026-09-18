# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## What this is

wacrm: a self-hostable WhatsApp CRM template (Next.js 16 App Router + Supabase + Tailwind 4). Shared inbox, contacts, pipelines, broadcasts, automations/flows, AI reply assistant, public REST API (`/api/v1`), and a separate MCP server in `mcp-server/` (own `package.json`, published as `wacrm-mcp`). Upstream is a template that people fork, so bug fixes and correctness matter more than new scope (see `CONTRIBUTING.md`).

## Commands

```bash
npm run dev            # next dev
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm test               # vitest run (all src/**/*.test.ts[x])
npx vitest run src/lib/whatsapp/send-message.test.ts   # single file
npx vitest run -t "name substring"                     # single test
npm run format         # prettier --write . (format:check to verify)
npm run build

# Docker: app only (external Supabase) — see docs/docker.md
docker compose --env-file .env.local up --build -d
# Docker: app + self-hosted Supabase; ./docker/supabase/generate-env.sh creates .env.local first
docker compose -f docker-compose.yml -f docker-compose.supabase.yml --env-file .env.local up --build -d
```

CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → build with dummy env. `next build` needs `NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY`; `ENCRYPTION_KEY` (64 hex) and `META_APP_SECRET` are read at module load by `lib/whatsapp/*`, and `vitest.config.ts` injects dummies for them. Keep those values consistent between vitest config and CI. Copy `.env.local.example` to `.env.local` for real runs.

Tests are colocated (`foo.ts` + `foo.test.ts`), run in the `node` environment, with mocks cleared between tests (`clearMocks: true`).

## Architecture

**Auth and tenancy.** Everything is scoped to an *account* (team), not a user. Two authentication paths converge on the same account model:
- Dashboard: Supabase cookie session → `lib/auth/account.ts` (`getCurrentAccount`), roles in `lib/auth/roles.ts` (owner/admin/agent/viewer). `src/middleware.ts` refreshes the session and must copy the refreshed cookies onto every redirect/JSON response it returns (`withRefreshedCookies`) — dropping that breaks sessions after idle. Protected path lists in middleware are hardcoded.
- Public API: `Authorization: Bearer wacrm_live_…` → `requireApiKey` in `lib/auth/api-context.ts`. There is no `auth.uid()`, so it uses a **service-role client and every query must be explicitly filtered by `ctx.accountId`** — RLS does not protect you there. Routes live in `app/api/v1/**`, helpers (envelope, pagination, errors) in `lib/api/v1/`.

**Supabase clients.** `lib/supabase/client.ts` / `server.ts` are the RLS-bound browser/server clients. Background paths with no user session (inbound webhook, automation/flow engines, AI auto-reply) use service-role `supabaseAdmin()` from `admin-client.ts` files (`lib/flows`, `lib/automations`, `lib/ai`) — same pattern, deliberately duplicated per module.

**Inbound WhatsApp pipeline.** `app/api/whatsapp/webhook` verifies the Meta HMAC (`lib/whatsapp/webhook-signature.ts`; `META_APP_SECRET` may be comma-separated for multiple Meta apps), resolves the contact/conversation (`resolve-conversation.ts`, `wa-identity.ts`), mirrors media, then fans out to automations (`lib/automations/engine.ts`), flows (`lib/flows/engine.ts`), the AI auto-reply (`lib/ai/auto-reply.ts`), and outbound webhooks (`lib/webhooks/`, HMAC-signed with SSRF guard). Outbound sends go through `lib/whatsapp/send-message.ts` / `meta-api.ts`; WhatsApp tokens are AES-256-GCM encrypted (`encryption.ts`) — rotating `ENCRYPTION_KEY` orphans stored tokens. Broadcast sending/resume logic is in `broadcast-core.ts` / `broadcast-resume.ts`.

**Database.** Numbered SQL migrations in `supabase/migrations/` (next number = highest + 1). They are not auto-applied to deployments (see `docs/docker.md`); the `Migrations` workflow replays them from scratch on Postgres and checks `supabase/ci/verify-schema.sql`. RLS is on every table; membership/role logic lives in RPCs (`018_account_member_rpcs`, `019_invitation_rpcs`). Migrations are shipped history, so add new ones rather than editing old ones. Features that need a migration say so in `docs/` (e.g. webhooks → `028`).

**Docker.** `docker-compose.yml` is the app alone; `docker-compose.supabase.yml` is an overlay adding a trimmed copy of the official Supabase self-hosting stack (db, auth, rest, realtime, storage, imgproxy, Kong, plus Studio + postgres-meta behind Kong's basic auth at the gateway root; no functions/analytics), plus a one-shot `migrate` service (`docker/supabase/migrate.sh`) that applies `supabase/migrations` and records them in `public.wacrm_migrations`. Non-obvious constraints:
- `NEXT_PUBLIC_SUPABASE_URL` is used by both the browser and the Next server, so `localhost` won't work. The default `supabase.localtest.me:8000` resolves to 127.0.0.1 for the browser and, via a network alias on the `kong` service, to the gateway inside Docker. `SUPABASE_HOST`, `SUPABASE_PUBLIC_URL` and `NEXT_PUBLIC_SUPABASE_URL` must agree.
- Everything lives in one `.env.local` (template: `.env.docker.example`, secrets generated by `generate-env.sh`, which refuses to overwrite). `NEXT_PUBLIC_*` changes need `--build`.
- `docker/supabase/api/` and `db/` are copied from the official stack; `roles.sql` is trimmed (no `supabase_functions_admin`, since `webhooks.sql` is omitted). Kong needs `KONG_ROUTER_FLAVOR=expressions` and the `post-function` plugin for the vendored `kong.yml`. Realtime's container name is fixed (`realtime-dev.supabase-realtime`) because Kong routes to it and it derives its tenant id from it.
- Bump image tags by diffing against upstream `supabase/docker/docker-compose.yml`.

**Frontend.** `src/app/(dashboard)/*` pages with feature components in `src/components/<feature>/`; shadcn/base-ui primitives in `components/ui`. Realtime via `hooks/use-realtime.ts`; permission checks via `hooks/use-can.ts`.

**i18n.** `next-intl`; the locale is a deployment-wide env var (`NEXT_PUBLIC_APP_LOCALE`, default `en`), not per-user. Dictionaries are `messages/{en,es,pt,ko}.json`; `src/i18n/*.test.ts` enforce key parity and ICU-safety, so adding a key to `en.json` means adding it to every locale.

## Conventions

- Commits/PRs: imperative, terse first line; run `npm run typecheck` and `npm run format` before pushing; one logical change per PR; branch off latest `main`. Follow `git log` style.
- Docs for users live in `docs/` (`public-api.md`, `mcp.md`, `multi-waba.md`, …) — update them alongside API or MCP changes.

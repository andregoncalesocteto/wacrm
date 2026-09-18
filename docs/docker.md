# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with a single
`app` service. Supabase is external — point the app at your hosted
(or self-hosted) Supabase project via env vars; no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## All-in-one: app + self-hosted Supabase

If you don't want a hosted Supabase project, `docker-compose.supabase.yml`
adds the Supabase services next to the app: Postgres, Auth, PostgREST,
Realtime, Storage (+ imgproxy) and the Kong gateway. A one-shot `migrate`
service applies `supabase/migrations/*.sql` on first boot (and any new
ones on later boots, tracked in `public.wacrm_migrations`).

```bash
./docker/supabase/generate-env.sh     # writes .env.local with fresh secrets
# edit .env.local: set META_APP_SECRET (and SMTP_* if you turn off auto-confirm)

docker compose -f docker-compose.yml -f docker-compose.supabase.yml \
  --env-file .env.local up --build -d
```

The app is on <http://localhost:3000>, the Supabase API gateway on
<http://supabase.localtest.me:8000>. Data lives in the `db-data` and
`storage-data` volumes (`docker compose ... down` keeps them; `down -v`
deletes them).

- **Why `supabase.localtest.me`?** `NEXT_PUBLIC_SUPABASE_URL` is a single
  value used by both the browser and the Next.js server. `localhost` would
  point the server at its own container. `localtest.me` resolves to
  `127.0.0.1` for the browser, and a network alias on the gateway makes the
  app container resolve it to Kong. It needs public DNS on your machine; if
  that's a problem, add `127.0.0.1 supabase.local` to `/etc/hosts` and set
  `SUPABASE_HOST`, `SUPABASE_PUBLIC_URL` and `NEXT_PUBLIC_SUPABASE_URL`
  accordingly.
- **Production:** put a TLS-terminating reverse proxy in front of both
  ports, set `NEXT_PUBLIC_SITE_URL`, `SUPABASE_PUBLIC_URL` and
  `NEXT_PUBLIC_SUPABASE_URL` to the public https URLs, and rebuild. Don't
  publish Postgres. Rotating `JWT_SECRET` invalidates every session and API
  key; rotating `ENCRYPTION_KEY` orphans stored WhatsApp tokens.
- **Studio:** open <http://supabase.localtest.me:8000> and sign in with
  `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` from `.env.local` (Kong's
  basic auth). Studio and postgres-meta run as the `studio` and `meta`
  services.
- **Not included:** Edge Functions, Analytics and the pooler. The
  stack is trimmed from the
  [official self-hosting compose](https://github.com/supabase/supabase/tree/master/docker);
  diff against it when bumping image tags.
- **Auth email:** `ENABLE_EMAIL_AUTOCONFIRM=true` (default) lets accounts
  sign in without SMTP. Set it to `false` and fill `SMTP_*` to require
  confirmation.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`. This includes
  `NEXT_PUBLIC_APP_LOCALE` (`en | ko | pt | es`), so the UI language is
  fixed per image.
- The UI language is chosen by `NEXT_PUBLIC_APP_LOCALE` in `.env.local`
  (e.g. `NEXT_PUBLIC_APP_LOCALE=pt`). After changing it, run
  `up --build` again so the new language is baked into the image. The
  templates (`.env.docker.example`, `.env.local.example`) keep `en` as the
  default.
- Everything else (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Plain Docker (no Compose)

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
  -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 wacrm
```

## Notes

- Database migrations under `supabase/` are **not** run by the
  container — apply them with the Supabase CLI as described in the
  README.
- Received attachments are copied into the `chat-media` Supabase
  Storage bucket, because Meta deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching your project's storage
  quota. Turn it off per account under Settings → WhatsApp →
  Attachment Storage; attachments received while it's off become
  unviewable once Meta drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- Nothing inside the container is scheduled. If you use automation
  Wait steps or flows, point an external scheduler at
  `GET /api/automations/cron` and `GET /api/flows/cron` on this
  deployment, sending the shared secret in the `x-cron-secret` header
  (`AUTOMATION_CRON_SECRET`, see `.env.local.example`). Both return
  503 until that variable is set.

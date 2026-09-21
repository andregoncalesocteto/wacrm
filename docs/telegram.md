# Telegram channel

A store can connect a Telegram **bot** as a channel next to (or instead of)
WhatsApp. Customers message the bot, and the conversation appears in the
shared inbox like any other. This page covers creating the bot, how the
connection works, how to test it on `localhost` and what the channel cannot
do.

## 1. Create the bot (BotFather)

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a display name and a username (must end in `bot`).
3. BotFather replies with the **API token**, shaped like
   `123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw_`. Treat it as a password.
   You can read it again later with `/mybots` → your bot → **API Token**, and
   revoke it there.

## 2. Connect it in the app

Settings → Channels → **Connect channel** → pick the store → **Telegram** →
give the connection a name and paste the token → Save. The app then connects
and tests the channel; the result (and, on failure, the reason and how to fix
it) is shown on the last step. Failed connections stay in the list and can be
retried from their detail screen.

What "connect" does:

- asks Telegram who the bot is (`getMe`) and stores the bot id as the
  connection's external id (so the same bot cannot be connected twice);
- generates a random **`secret_token` per connection**, stores it encrypted
  with the token, and registers the webhook
  `<NEXT_PUBLIC_SITE_URL>/api/channels/telegram/webhook/<connection id>` with
  Telegram (`setWebhook`, updates: messages, edited messages, button taps,
  reactions);
- on every incoming call, the app compares the
  `X-Telegram-Bot-Api-Secret-Token` header with that secret (constant time)
  and drops the request with `401` if it differs.

Only **private chats** are handled. Messages from groups, supergroups and
channels are ignored.

## 3. Test locally: public HTTPS tunnel

Telegram delivers webhooks only to a **public HTTPS URL**. With
`NEXT_PUBLIC_SITE_URL=http://localhost:3000` the app refuses to connect and
says so ("Telegram only delivers webhooks to a public HTTPS URL"). Expose your
dev server through a tunnel and point `NEXT_PUBLIC_SITE_URL` at it.

Cloudflare Tunnel (no account needed for a quick tunnel):

```bash
cloudflared tunnel --url http://localhost:3000
# prints https://<random>.trycloudflare.com
```

ngrok:

```bash
ngrok http 3000
# prints https://<random>.ngrok-free.app
```

Then set it in `.env.local` and restart:

```bash
NEXT_PUBLIC_SITE_URL=https://<random>.trycloudflare.com
```

- `npm run dev`: restart the dev server.
- **Docker**: `NEXT_PUBLIC_*` values are baked at build time, so rebuild:
  `docker compose --env-file .env.local up --build -d` (see
  [docs/docker.md](./docker.md#build-time-vs-runtime-variables)).

Quick tunnel URLs change every time the tunnel restarts. When it does, update
`NEXT_PUBLIC_SITE_URL` and use **Reconnect** on the connection so Telegram gets
the new webhook URL. Port note: Telegram delivers to ports 443, 80, 88 or 8443
only, which tunnels satisfy by serving on 443.

## 4. Test without Telegram: fixtures and `curl`

Sample `Update` payloads live in
`src/lib/channels/providers/telegram/__fixtures__/` (text, photo, voice,
sticker, reply, callback button tap, reactions, group message, ...). The
provider tests use them, and you can replay one against a running app. The
secret is not shown anywhere in the UI, so read it from the database
(credentials are encrypted, so in practice use a test connection you seeded
yourself through `saveConnectionCredentials`, as the tests do):

```bash
curl -i -X POST \
  "http://localhost:3000/api/channels/telegram/webhook/<connection id>" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: <that connection's secret_token>" \
  --data @src/lib/channels/providers/telegram/__fixtures__/text.json
```

Expected: `200` and a new contact, conversation and message in the inbox. The
same payload again is a duplicate (no new rows). A wrong or missing header
returns `401` and nothing is processed; a disabled connection answers `200`
without processing. (Real webhook delivery from Telegram itself requires the
tunnel above and a real bot.)

## 5. Limitations

- **No templates, no interactive lists, no delivery or read receipts.** The
  composer disables what the channel cannot do. Buttons (inline keyboard),
  reactions, typing indicator and media are supported; replies to a message
  are supported.
- **A bot can only message users who already started it** (or wrote to it
  first). The channel is declared "reply after the contact writes". This is
  the known Bot API behaviour, but it was **not confirmed** in the official
  documentation pages we consulted, so verify it with your own bot.
- **Media is sent by URL**, so the file URL must be publicly fetchable by
  Telegram (a private or `localhost` storage URL will fail). Telegram also
  caps captions at 1024 characters and bot uploads by URL at about 50 MB.
- **Groups, supergroups and channels are ignored**; private chats only.
- Edited messages are ignored; only new messages, button taps and reactions
  are recorded.
- Messages the bot sends itself never arrive as updates, so the app records
  them when it sends.

## 6. Security notes

- The bot token is stored **encrypted** (AES-256-GCM, `ENCRYPTION_KEY`) and
  is **never returned by the API or shown again**. The connection detail
  shows it as "provided" with a **Replace** action; replacing saves the new
  token and reconnects. Rotating `ENCRYPTION_KEY` orphans stored tokens.
- The webhook `secret_token` is random per connection and is **regenerated on
  every (re)connect**, which invalidates the previous one at Telegram.
- File download URLs from Telegram embed the bot token; the app never stores
  or logs them, and mirrors received media into its own storage.
- If a token leaks, revoke it in BotFather (`/revoke`) and replace it on the
  connection.

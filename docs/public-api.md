# Public API (`/api/v1`)

The public API lets you drive your wacrm instance from your own
scripts and automations — send messages, manage contacts, launch
broadcasts — without going through the dashboard UI.

> **Status:** stable. Authentication, scopes, rate limiting, the
> messages / contacts / conversations / broadcasts endpoints, and
> outbound event [webhooks](#webhooks) all ship now.

> **Pre-stable until the first client:** the order-journey events endpoint
> (`POST /api/v1/journey/events`, scope `events:write`) and the multi-store, multi-channel
> contract (`/stores`, `/connections`, `connection_id` / `channel` /
> `external_message_id` on messages and conversations, contact `identities`,
> and the new webhook fields) may still change before it is frozen. Breaking
> changes to it are announced in the release notes.

## Authentication

Every request authenticates with an **API key**, sent as a bearer
token:

```
Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are **account-scoped**: a key acts on exactly one account, the
one it was created in. There is no cross-account access.

### Creating a key

In the dashboard: **Settings → API keys → New API key**. Only
**admins and owners** can create keys.

1. Give the key a name (after the integration that will use it).
2. Grant the **scopes** it needs — nothing more (see below).
3. Copy the key. **The full key is shown exactly once.** wacrm
   stores only a SHA-256 hash, so it can never be shown again. If you
   lose it, revoke it and create a new one.

### Revoking a key

**Settings → API keys → Revoke.** Revocation is effective on the
key's next request. Revoked keys stay in the list as an audit trail.

## Scopes

A key can do only what its scopes allow — independent of who created
it. Grant the minimum.

| Scope                | Allows                                                                        |
| -------------------- | ----------------------------------------------------------------------------- |
| `messages:send`      | Send WhatsApp messages                                                        |
| `messages:read`      | Read messages and delivery status                                             |
| `contacts:read`      | List and read contacts                                                        |
| `contacts:write`     | Create and update contacts                                                    |
| `conversations:read` | List and read conversations                                                   |
| `connections:read`   | List stores and channel connections                                           |
| `broadcasts:send`    | Launch broadcast campaigns                                                    |
| `webhooks:manage`    | Register and manage outbound webhooks                                         |
| `events:write`       | Send order-journey events (only `POST /api/v1/journey/events`; reads nothing) |

A key with **no scopes** still authenticates and can call
`GET /api/v1/me` — useful for verifying a key works.

## Response envelope

Every response uses one of two shapes:

```jsonc
// success
{ "data": { /* ... */ } }

// failure
{ "error": { "code": "forbidden", "message": "This API key is missing the 'messages:send' scope" } }
```

Branch on `error.code` (stable); `error.message` is for humans and
may be reworded.

| Status | `code`              | Meaning                                                       |
| ------ | ------------------- | ------------------------------------------------------------- |
| 401    | `unauthorized`      | Missing / malformed / unknown / revoked / expired key         |
| 403    | `forbidden`         | Valid key, but missing the required scope                     |
| 429    | `rate_limited`      | Per-key rate limit exceeded                                   |
| 400    | `bad_request`       | Malformed input                                               |
| 400    | `order_not_found`   | Events API: the `order_id` of an `OrderStatusChanged` is unknown (or not this contact's) |
| 404    | `not_found`         | No such resource                                              |
| 404    | `idtrack_not_found` | Events API: the `idtrack` matches no link sent by the account |
| 404    | `store_not_found`   | Events API: the `store_key` matches no store of the account (do not retry) |
| 410    | `idtrack_expired`   | Events API: the `idtrack` is past its 30-day validity         |
| 500    | `internal`          | Server error                                                  |

## Rate limits

Requests are limited **per key**: **120 requests per minute**. On a
`429`, these headers tell you when to retry:

- `Retry-After` — seconds until the window resets
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

> The limiter is in-memory and **per process**. A single-instance
> deploy (the common case for a self-hosted fork) is fine as-is. If
> you scale to multiple instances, swap the limiter for a shared
> store (Redis/Upstash) — see the note at the top of
> `src/lib/rate-limit.ts`. The limit is otherwise unenforced across
> instances.

## Endpoints

### `GET /api/v1/me`

Returns the account a key is bound to and the scopes it carries.
Requires only a valid key (no scope). Use it to verify a key works
and to discover its scopes.

```bash
curl https://your-crm.example.com/api/v1/me \
  -H "Authorization: Bearer wacrm_live_xxx"
```

```json
{
  "data": {
    "account": { "id": "…", "name": "Acme Inc" },
    "key": { "id": "…", "scopes": ["messages:send"] }
  }
}
```

### `POST /api/v1/messages`

Send a message. Scope: `messages:send`. Address it in one of two ways:

- `{ "conversation_id": "…" }` — reply in an existing conversation.
- `{ "connection_id": "…", "to": "+14155550123" }` — go through a channel
  connection. `to` is an **E.164 number** for WhatsApp (the endpoint
  finds-or-creates the contact + conversation) or the channel's own address
  for others (e.g. a Telegram chat id, which must already have written to the
  bot). `connection_id` may be omitted only when the account has exactly one
  active connection; otherwise the answer is `400 connection_required`.

```bash
curl -X POST https://your-crm.example.com/api/v1/messages \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+14155550123", "type": "text", "text": "Hi 👋" }'
```

`type` is `text` (default), `template`, or a media kind (`image` /
`video` / `document` / `audio`). Media needs `media_url` (and optional
`filename`); `text` doubles as the caption. `template` needs a
`template` object:

```jsonc
{
  "to": "+14155550123",
  "type": "template",
  "template": {
    "name": "order_update",
    "language": "en_US",
    "params": ["A123"], // positional body vars, or a structured object
  },
  "reply_to_message_id": "<uuid>", // optional; must be in the same conversation
}
```

Response (201):

```json
{
  "data": {
    "message_id": "…",
    "external_message_id": "wamid.…",
    "conversation_id": "…",
    "connection_id": "…",
    "channel": "whatsapp_cloud",
    "contact_id": "…",
    "contact_created": true
  }
}
```

`external_message_id` replaces the old `whatsapp_message_id`.

Domain error codes beyond the table above: `connection_required` (400),
`whatsapp_not_configured` (400), `unsupported` (409 — the channel lacks the
capability, e.g. templates on Telegram), `window_closed` (409 — WhatsApp 24h
window), `connection_disabled` (409), `recipient_unreachable` (422),
`meta_error` (502 — the request reached Meta and it rejected the send),
`template_malformed` (500).

### `GET /api/v1/contacts`

List contacts, newest first. Scope: `contacts:read`. Paginated (see
[Pagination](#pagination)). Optional filters: `?search=` (matches name
or phone) and `?tag=<tagId>`.

```json
{
  "data": [
    {
      "id": "…",
      "phone": "14155550123",
      "name": "Jane Doe",
      "identities": [
        {
          "kind": "whatsapp:phone",
          "external_id": "14155550123",
          "handle": null
        }
      ],
      "email": null,
      "company": "Acme",
      "avatar_url": null,
      "tags": [{ "id": "…", "name": "vip", "color": "#3b82f6" }],
      "created_at": "…",
      "updated_at": "…"
    }
  ],
  "meta": { "next_cursor": "…" }
}
```

### `POST /api/v1/contacts`

Create a contact. Scope: `contacts:write`. Send `phone` (E.164, a shortcut
for a `whatsapp:phone` identity) and/or `identities`
(`[{ "kind": "telegram:chat_id", "external_id": "123", "handle": "@maria" }]`;
kinds come from the channels, e.g. `whatsapp:phone`, `whatsapp:bsuid`,
`telegram:chat_id`, `telegram:username`); at least one is required.
`name`, `email`, `company`, and `tags` (an array of tag names, created
if missing) are optional. `phone` is `null` in responses when the contact
has none. **Find-or-create by any identity:** an existing
match returns `200` with the existing contact (its data is not
overwritten); a new contact returns `201`. The response body is the serialized contact (same shape as the
list rows above).

### `GET` / `PATCH /api/v1/contacts/{id}`

Read or update one contact. Scopes: `contacts:read` / `contacts:write`.
`PATCH` updates only the fields you send (`name`, `email`, `company`);
pass `tags` (an array of tag names) to replace the contact's tags. A
contact in another account returns `404`.

### `GET /api/v1/conversations`

List conversations, newest first. Scope: `conversations:read`.
Paginated. Optional filters: `?status=` (`open` / `pending` / `closed`)
and `?contact_id=`. Each conversation carries `connection_id`, `store_id`
and `channel` (e.g. `whatsapp_cloud`, `telegram`), and embeds its contact
(with `identities`; `phone` is `null` when absent) + tags.

### `GET /api/v1/conversations/{id}`

Read one conversation. Scope: `conversations:read`. `404` if it belongs
to another account.

### `GET /api/v1/conversations/{id}/messages`

List a conversation's messages, newest first. Scope: `messages:read`.
Paginated. Each message includes its `direction` (`inbound` /
`outbound`), `status` (delivery state), `whatsapp_message_id`, and
`content_*`. The conversation is verified to belong to your account
first (`404` otherwise).

### `GET /api/v1/stores` and `GET /api/v1/connections`

Read-only discovery of the ids you pass to `POST /api/v1/messages`
(`connection_id`). Scope `connections:read`. Credentials and connection
`config` are never returned. Both return the whole list (`next_cursor` is
always `null`).

- `stores[]`: `id`, `name`, `address`, `phone`, `manager_name`, `menu_url`, `store_code`, `store_acronym`, `business_acronym`, `store_key`, `created_at`. `menu_url` is the store's Digital menu address (an `https://` URL, or `null` when the store has no menu). `store_code`, `store_acronym` and `business_acronym` are the three parts of the store key, each optional (`null` when unset, at most 40 characters, no `/`). `store_key` is computed: `CODE/STORE ACRONYM/BUSINESS ACRONYM` (for example `89/RPA/BLC`), or `null` unless all three parts are set. It is unique per account, ignoring case and edge spaces; two stores of the same site and code but different business acronyms (`89/RPA/BLC`, `89/RPA/PZA`) are different stores. **Migration required:** `063`.
- `connections[]`: `id`, `store_id`, `channel` (e.g. `whatsapp_cloud`, `telegram`), `display_name`, `external_id`, `status`, `enabled` (`false` when the connection was disabled), `last_inbound_at`, `last_outbound_at`, `connected_at`, `created_at`. Optional filter: `?store_id=`.

### `POST /api/v1/journey/events`

Scope `events:write`, meant for the **backend of the digital menu** (never
the browser: the key must stay a server secret, because whoever holds it
can forge a `Purchase`). It reports what a customer does after receiving the
menu link and how their order progresses, so the CRM can move the deal,
recover abandoned carts and notify the customer. The operator-side setup is in
[order-journey.md](./order-journey.md).

> **Pre-stable until the first client.** This contract is frozen when the
> first client integrates; after that a breaking change needs `v2`.
> **Migrations required:** `055` to `062`, and `064` for events without `idtrack` (see [order-journey.md](./order-journey.md#what-to-apply-and-configure)).

**One event per call**, JSON body, no batching. Common fields:

| Field         | Required | Description                                                                                                        |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| `event_id`    | yes      | Unique per account, up to 200 characters. Generate it on your side (a UUID) and reuse it when re-sending.          |
| `name`        | yes      | `ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase` or `OrderStatusChanged`. Anything else is `400`.        |
| `idtrack`     | see below | The opaque value that came back on the menu URL (`?idtrack=…`). Never build, decode or reuse it as a customer id. Optional when `store_key` and `customer.phone` are sent. |
| `occurred_at` | yes      | ISO 8601 with an explicit UTC designator (`Z` or `+00:00`): when it happened on the menu, not when you send it.    |
| `properties`  | per name | Event data, see below. Required by every name except `ViewContent`.                                                |

The `idtrack` is created by the CRM when it sends the store's menu link
(`https://<menu-url>/?idtrack=<token>`, other query parameters of the store's
menu address are kept). It is valid for **30 days**, renewed each time a new
link is sent. It resolves to the contact, conversation and channel connection
that received the link; a customer who opens the menu without `idtrack` (a
bookmark, a direct URL) cannot be attributed, so **do not send events for
that session**. Keep the `idtrack` in the order you store at `Purchase`:
`OrderStatusChanged` arrives hours later, when the browser session is gone.

Every call answers `200` with `{ "data": { "event_id", "journey_id", "stage", "duplicate", "messaging" } }`.
`stage` is the Journey stage after the event: `link_sent`, `browsing`,
`cart`, `checkout` or `won` (`lost` never comes from an event). `messaging` is
described under [Events without `idtrack`](#events-without-idtrack-direct-events).

#### Events without `idtrack` (direct events)

For a customer who reached the menu without a CRM link (Instagram, an old
link, the address typed in), identify them by the store and their phone
instead. These fields are valid on **every** event and optional when an
`idtrack` is present:

| Field                   | Description                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `store_key`             | The whole store key in one field, `CODE/STORE ACRONYM/BUSINESS ACRONYM` (for example `89/RPA/BLC`). Case and edge spaces are ignored. Set on the store in Settings, see `GET /api/v1/stores`. |
| `customer.phone`        | International E.164 **with the `+`** (`+5511999998888`, matching `^\+[1-9]\d{6,14}$`). Any other format is `400`. |
| `customer.name`         | Optional. Used only when the contact does not exist yet; an existing name is **never** overwritten.           |
| `consent.notifications`, `consent.marketing`, `consent.given_at` | The customer's consent per purpose (booleans) and when it was given (ISO 8601 UTC). **`given_at` is required** when any purpose is sent (`400` otherwise). Stored on the contact, see [Consent](#consent). |

- **Identification.** The event needs an `idtrack`, **or** `store_key` together
  with `customer.phone`; otherwise `400 bad_request`. With both, the `idtrack`
  decides; if the phone resolves to a *different* contact, the event is
  attributed by the `idtrack` and its `customer` and `consent` are ignored (the
  CRM logs the conflict, with the phone masked). With an `idtrack`, `store_key`
  is not needed and is not checked.
- **Unknown key.** `404 store_not_found`: fix the configuration; **do not
  retry**. A store that exists but has no usable WhatsApp connection (none, or
  several without a default) still accepts the event; nothing is sent.
- **Contact.** Found by phone with the same matching the WhatsApp inbox uses; if
  it does not exist it is created (origin "menu", with `customer.name` if sent).
  Two simultaneous events for the same new phone end on one contact.
  `OrderStatusChanged` never creates a contact: an unknown phone is
  `400 order_not_found`.
- **Journey.** A direct Journey has origin `menu_direct` (the others are
  `crm_link`), no link sent, and starts at the first stage the event reaches:
  `ViewContent` browsing, `AddToCart` cart, `InitiateCheckout` checkout,
  `Purchase` won (through the normal Purchase flow, with its order). Its
  connection is the store's notice connection, or none when the store has no
  WhatsApp connection (one open Journey per contact and store then). The
  resumptions that depend on the link do not apply to it.
- **`messaging`** says whether the customer can be messaged: `no_connection`
  when the store has no eligible WhatsApp connection; otherwise `eligible` if the
  contact may receive order notices (`consent.notifications` active, or implicit
  because they already wrote to the CRM, see [Consent](#consent)), and
  `no_consent` if not. The automations run for every direct event; each send
  step then decides: a customer who never wrote is messaged only with the consent
  of the step's purpose (order notices use `notifications`). The first message
  goes by approved template on a conversation created closed, which reopens when
  the customer answers. `messaging` only reports the `notifications` case.

##### Consent

The CRM keeps the consent on the **contact**, per purpose: `notifications`
(order notices) and `marketing` (recovery and offers). For each it stores whether
it is active, when it was given (`given_at`), the source (`menu` for events) and,
if it was revoked, when. That is the proof of consent. The menu owns collecting
the consent and sending its current state.

- **Update.** A purpose in `consent` replaces the stored state only when its
  `given_at` is **strictly newer** than the stored decision (the later of the
  given and revoked dates). Equal or older changes nothing, so late or repeated
  events are harmless. A replay of the same `event_id` never applies it again.
- **Revoke.** An explicit `false` revokes **only that purpose** (the revocation
  date is the event's `given_at`). A later `true` with a newer `given_at`
  reactivates it.
- **Omit.** Leaving out `consent`, or one of its purposes, changes nothing:
  omitting is **not** a revocation. Send `false` to revoke.
- **Implicit consent.** A contact who has already written to the CRM is treated
  as consenting to both purposes, as before. An **explicit revocation wins** over
  it: someone who asked to stop is not messaged, until a newer explicit consent
  reactivates the purpose. A contact who never wrote needs the explicit consent.
- **Conflict.** If `idtrack` and `customer.phone` resolve to different
  contacts, the event's `consent` is ignored.
- The operator sees the state, date and source of each purpose in the contact
  panel (read-only).

#### Examples, one per event

Set `URL=https://your-crm.example.com/api/v1/journey/events` and
`AUTH='Authorization: Bearer wacrm_live_…'` (a key with `events:write`).

`ViewContent`: the customer opened the menu or a product. Send it on the
first access of the session; repeats are accepted and counted but never change
the stage. No `properties`.

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "9b1f6c3e-7f64-4c7a-9a1e-1f2b3c4d5e6f",
  "name": "ViewContent",
  "idtrack": "<token from the link>",
  "occurred_at": "2026-10-02T21:14:05Z"
}'
# → 200 { "data": { "event_id": "9b1f…", "journey_id": "…", "stage": "browsing", "duplicate": false } }
```

`AddToCart` and `InitiateCheckout`: the customer changed the cart, or started
checkout. Both take the same `properties` and **always carry the whole cart at
that moment**, not just the new item, so a lost call cannot corrupt the total.
`AddToCart` may repeat, each time with a new `event_id`. `currency` is 3 letters
(ISO 4217); each item has `id`, `quantity` (integer ≥ 1), `unit_price` (≥ 0)
and an optional `name`; 1 to 200 items; `cart.value` ≥ 0.

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "b6d2…", "name": "AddToCart", "idtrack": "<token>",
  "occurred_at": "2026-10-02T21:16:40Z",
  "properties": { "currency": "BRL", "cart": { "value": 89.8, "items": [
    { "id": "pizza-g", "name": "Pizza G", "quantity": 1, "unit_price": 59.9 },
    { "id": "refri-2l", "name": "Soda 2L", "quantity": 1, "unit_price": 29.9 } ] } }
}'
# → 200 { "data": { …, "stage": "cart", "duplicate": false } }

curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "c0a7…", "name": "InitiateCheckout", "idtrack": "<token>",
  "occurred_at": "2026-10-02T21:19:02Z",
  "properties": { "currency": "BRL", "cart": { "value": 89.8, "items": [
    { "id": "pizza-g", "name": "Pizza G", "quantity": 1, "unit_price": 59.9 },
    { "id": "refri-2l", "name": "Soda 2L", "quantity": 1, "unit_price": 29.9 } ] } }
}'
# → 200 { "data": { …, "stage": "checkout", "duplicate": false } }
```

`Purchase`: the order was placed. **Terminal for the Journey**: it closes as
won, creates the order in the CRM and fires the thank-you. `order_id` is your
own order id (up to 200 characters), stable forever; every later
`OrderStatusChanged` refers to it. `items` is required (same item rules as the
cart) and `value` is stored as sent (not checked against the items).

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "c41e…", "name": "Purchase", "idtrack": "<token>",
  "occurred_at": "2026-10-02T21:22:11Z",
  "properties": { "order_id": "PED-2026-104233", "currency": "BRL", "value": 89.8, "items": [
    { "id": "pizza-g", "name": "Pizza G", "quantity": 1, "unit_price": 59.9 },
    { "id": "refri-2l", "name": "Soda 2L", "quantity": 1, "unit_price": 29.9 } ] }
}'
# → 200 { "data": { …, "stage": "won", "duplicate": false } }
```

A second `Purchase` with the same `order_id` and another `event_id` is treated
as a duplicate: `200`, `"duplicate": true`, `Idempotent-Replayed: true`, and
nothing is created or sent again. `order_id` is unique per account.

`OrderStatusChanged`: the order moved on after being placed. Use the `idtrack`
stored with the order.

```bash
curl -X POST $URL -H "$AUTH" -H "Content-Type: application/json" -d '{
  "event_id": "d78a…", "name": "OrderStatusChanged", "idtrack": "<token>",
  "occurred_at": "2026-10-02T21:35:00Z",
  "properties": { "order_id": "PED-2026-104233", "status": "preparing" }
}'
# → 200 { "data": { "event_id": "d78a…", "journey_id": "…", "stage": "won", "duplicate": false } }
```

`status` is a closed set; anything else is `400 bad_request` (the message lists
the valid values):

| `status`           | Meaning                             |
| ------------------ | ----------------------------------- |
| `received`         | Order received by the store         |
| `preparing`        | Being prepared                      |
| `finished`         | Preparation finished                |
| `out_for_delivery` | Out for delivery                    |
| `ready_for_pickup` | Ready for pickup                    |
| `delivered`        | Delivered, or picked up             |
| `cancelled`        | Cancelled (at any moment)           |

The `placed` state is the `Purchase` itself and is not accepted as a status.
Translate your internal states on your side; an internal state with no message
for the customer (such as a "ready to produce" step) is simply not sent.

#### Behavior

- **Only forward.** The stage goes Link sent → Browsing → Cart → Checkout →
  Purchased. An `AddToCart` after `InitiateCheckout` refreshes the cart but never
  moves the stage back, and a late event never overwrites a newer cart (compared
  by `occurred_at`). If an intermediate event never arrives, the final state is
  still correct. The order status also only moves forward: `received` →
  `preparing` → `finished` → `out_for_delivery` **or** `ready_for_pickup` →
  `delivered` (steps may be skipped). The two last-mile statuses are the same
  level: the first to arrive wins and the other is ignored. `cancelled` is
  accepted at any moment before `delivered`; `delivered` and `cancelled` are final.
- **A status that is older than, equal to, or after a final status than the
  current one** is accepted (`200`) but **ignored**: nothing is written and no
  message is sent to the customer.
- **After a `Purchase` the same `idtrack` keeps working.** A new event with it
  opens a **new Journey** (and deal), so a returning customer who reuses the
  session is still attributed. Likewise, an event for a Journey already marked
  lost opens a new one. An event on a token with no open Journey opens one.
- **Idempotency.** `event_id` is unique per account. Re-sending it returns the
  original response (with `"duplicate": true`) and the header
  `Idempotent-Replayed: true`, and repeats no effect: no second message to the
  customer. This holds even after the `idtrack` has expired. Two simultaneous
  requests with the same `event_id` are applied once; if the first is still
  running when the second gives up waiting, the second gets a retryable `500`
  (`internal`): re-send the same `event_id`. Rejected events (4xx) are not
  recorded, so fixing the body (or sending the `Purchase` first) and re-sending works.
- **Order and delivery.** Order of arrival does not matter beyond the rules above.
  Losing a `Purchase` or an `OrderStatusChanged` is the costly case (the CRM would
  treat a buyer as an abandoner, or the customer would miss a notification), so
  send those from an outbox with retries. Retry on `429`, `5xx` and network
  failures with the **same `event_id`** and growing waits (for example 30 s, 2 min,
  10 min, 1 h, 6 h, up to 24 h); **do not retry** `400`, `401`, `403`, `404` or
  `410`, they fail the same way.
- **The events do not send the message themselves.** What the customer receives
  (thank-you, one message per status, reminders) is configured in the CRM as
  automations, see [order-journey.md](./order-journey.md).
- **Errors** (also in the table above): `400 bad_request` (invalid body, unknown
  `name`, `status` outside the set), `400 order_not_found`, `401 unauthorized`,
  `403 forbidden` (no `events:write`), `404 idtrack_not_found`, `404 store_not_found`, `410 idtrack_expired`
  (the customer needs a new link), `429 rate_limited` (120/min per key, honour
  `Retry-After`).
- **`order_not_found`** is returned for `OrderStatusChanged` when the `order_id` is
  unknown, belongs to another account or belongs to another contact than the
  `idtrack`. The three cases answer alike, so nothing leaks. It is a `400` with
  its own `error.code`, so you can tell "send the `Purchase` first" from "fix the
  body". `OrderStatusChanged` opens no Journey and creates no deal; the response
  reports the order's Journey (already `won`).
- The current status and the change history show on the conversation panel and on
  the deal.

### `POST /api/v1/broadcasts`

Launch a template broadcast to a list of recipients. Scope:
`broadcasts:send`. The broadcast + its recipient rows are persisted
immediately and the sends fan out in the background, so the call
returns fast — poll `GET /api/v1/broadcasts/{id}` for progress.

```bash
curl -X POST https://your-crm.example.com/api/v1/broadcasts \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "July promo",
        "connection_id": "…",
        "template_name": "promo_july",
        "template_language": "en_US",
        "recipients": [
          { "to": "+14155550123", "params": ["Jane"] },
          { "to": "+14155550124" }
        ]
      }'
```

`connection_id` may be omitted only when the account has exactly one
active connection (same convention as `POST /api/v1/messages`); with
more than one it is required, with none the call fails
`whatsapp_not_configured`. Recipients are capped at **1000 per
request** — split larger sends. Invalid phone numbers are dropped and
counted as `rejected`. Response (202):

```json
{
  "data": {
    "broadcast_id": "…",
    "status": "sending",
    "total_recipients": 2,
    "accepted": 2,
    "rejected": 0
  }
}
```

This endpoint is currently **template-only** — `template_name` is
required. Non-template channels (e.g. Telegram) and free-message
broadcasts are supported by the dashboard's broadcast wizard, but not
yet exposed here.

Domain error codes beyond the table above: `connection_required` (400
— more than one active connection, `connection_id` needed),
`whatsapp_not_configured` (400 — no connection at all), `not_found`
(404 — `connection_id` doesn't exist or belongs to another account),
`connection_disabled` (409), `content_required` (400 — `template_name`
missing), `template_malformed` (500).

### `GET /api/v1/broadcasts/{id}`

Broadcast status + counts. Scope: `broadcasts:send`. `status` moves
`sending` → `sent`; `delivered_count` / `read_count` keep climbing as
Meta delivery webhooks arrive. `404` for another account's broadcast.

## Pagination

Every list endpoint pages the same way. Request a page size with
`?limit=` (default 50, max 100) and read the next page with the opaque
`meta.next_cursor` from the previous response:

```
GET /api/v1/contacts?limit=50
→ { "data": [ … ], "meta": { "next_cursor": "eyJ…" } }

GET /api/v1/contacts?limit=50&cursor=eyJ…
→ { "data": [ … ], "meta": { "next_cursor": null } }   // last page
```

Cursors are keyset-based (stable under concurrent inserts). Pass the
cursor back verbatim — don't parse it. `next_cursor: null` means the
last page.

## Webhooks

Rather than polling, register an endpoint and wacrm will POST to it when
things happen in your account. **Migration required:** apply
`supabase/migrations/028_webhook_endpoints.sql`.

### Events

| Event                    | Fires when                                 |
| ------------------------ | ------------------------------------------ |
| `message.received`       | An inbound message arrives from a contact  |
| `message.status_updated` | A message you sent changed delivery status |
| `conversation.created`   | A new conversation is opened for a contact |

### Managing endpoints

All under scope `webhooks:manage`.

- `POST /api/v1/webhooks` — register `{ "url": "https://…", "events": ["message.received"] }`. `url` must be `https://`. **The response includes `secret` exactly once** — store it to verify signatures; wacrm keeps only an encrypted copy.
- `GET /api/v1/webhooks` — list your endpoints (never returns the secret).
- `GET /api/v1/webhooks/{id}` — read one.
- `PATCH /api/v1/webhooks/{id}` — update `url`, `events`, or `is_active` (re-enabling clears the failure counter).
- `DELETE /api/v1/webhooks/{id}` — remove one.

```bash
curl -X POST https://your-crm.example.com/api/v1/webhooks \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/wacrm", "events": ["message.received"] }'
# → 201 { "data": { "id": "…", "url": "…", "events": [...], "secret": "whsec_…" } }
```

### Delivery payload

Every delivery is a POST with this envelope; `id` is a unique per-
delivery uuid you can dedupe on, and `data` varies by `event`:

```json
{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": {/* per-event, see below */}
}
```

`data` by event:

```jsonc
// message.received
{ "conversation_id": "…", "contact_id": "…", "whatsapp_message_id": "wamid.…", "external_message_id": "wamid.…", "content_type": "text", "text": "Hi 👋",
  "connection_id": "…", "store_id": "…", "channel": "whatsapp_cloud",
  "contact": { "id": "…", "phone": "15551234567", "identities": [{ "kind": "whatsapp:phone", "external_id": "15551234567", "handle": null }] } }
// conversation.created
{ "conversation_id": "…", "contact_id": "…", "connection_id": "…", "store_id": "…", "channel": "telegram", "contact": { /* as above */ } }
// message.status_updated
{ "whatsapp_message_id": "wamid.…", "external_message_id": "wamid.…", "conversation_id": "…", "status": "delivered",
  "connection_id": "…", "store_id": "…", "channel": "whatsapp_cloud", "contact": { /* as above */ } }
```

Every event carries `connection_id`, `store_id`, `channel` and `contact` (`contact.phone` is `null` when the contact has none, e.g. a Telegram contact; `contact.identities` lists the handles per channel). `whatsapp_message_id` is kept for compatibility; prefer `external_message_id`, which holds the provider's message id on any channel.

Headers: `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`, and `X-Wacrm-Signature`.

### Verifying the signature

`X-Wacrm-Signature: t=<unix_seconds>,v1=<hex>` where `v1 =
HMAC-SHA256(secret, "${t}.${rawBody}")`. Recompute it over the **raw
request body** and compare in constant time; reject if `t` is more than
a few minutes old (replay protection).

```js
const [, t, v1] = header.match(/t=(\d+),v1=([0-9a-f]+)/);
const expected = crypto
  .createHmac('sha256', secret)
  .update(`${t}.${rawBody}`)
  .digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

### Delivery semantics

Delivery is **best-effort**: a single attempt per event with a short
timeout, and **redirects are not followed**. `message.status_updated`
covers messages wacrm stores (inbox + API sends), not broadcast-only
sends, and — because providers re-send and re-order status callbacks —
the same status may arrive more than once or out of order; **dedupe on
`id` and don't assume ordering**. Each consecutive failure increments
`failure_count`; after enough consecutive failures the endpoint is
auto-disabled (`is_active: false`) — re-enable it with `PATCH` (which
resets the counter). Durable retry-with-backoff (a delivery queue) is a
future enhancement; today, treat missed deliveries as possible and
reconcile with the read endpoints when it matters.

**Target restrictions (SSRF).** The `url` must be `https://` and must
resolve to a public address — requests to `localhost`, private/RFC1918
ranges, link-local (incl. cloud metadata `169.254.169.254`), and similar
internal targets are refused at delivery time.

## Roadmap

The public API now covers messaging, contacts, conversations,
broadcasts, and outbound webhooks — the full scope of
[#245](https://github.com/ArnasDon/wacrm/issues/245). The order-journey
events endpoint (`POST /api/v1/journey/events`) is also live; see
[order-journey.md](./order-journey.md). Future ideas (deals/pipelines
reads, templates, flows, a delivery queue for webhooks, batch events) are
not yet scheduled.

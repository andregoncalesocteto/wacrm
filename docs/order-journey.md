# Order Journey (menu link, cart recovery and order notifications)

For operators. The order Journey follows a customer from the menu link you
send in a conversation to the order placed on your **digital menu** (a
separate ordering site), and back into the conversation: reminders when the
customer goes quiet, an abandoned-cart message, a thank-you and one message
per order status. It works the same on WhatsApp and Telegram; nothing in it is
specific to a channel.

## What it is

- A **Journey** is one attempt to order. It opens when the CRM sends a menu link
  (or when the first event of a customer with no open Journey arrives) and
  closes when the order is placed (won) or the attempt is abandoned (lost).
  Each Journey is one deal, so each attempt is measured separately.
- The menu link is the store's menu address plus `?idtrack=<token>`. The token is
  opaque, valid for 30 days and renewed every time a new link is sent.
- The **digital menu's backend** reports what happens (`ViewContent`,
  `AddToCart`, `InitiateCheckout`, `Purchase`, then the order statuses) to
  `POST /api/v1/journey/events`. The contract for that team is in
  [public-api.md](./public-api.md#post-apiv1journeyevents).
- The deal moves through the pipeline **Jornada de Pedido**: Link enviado →
  Navegando → Carrinho → Checkout → Comprou / Perdido. It only moves forward.
  The pipeline is created by the CRM the first time a Journey opens; you can
  rename it and its stages (the CRM finds it by an internal key, not by name).
- A `Purchase` creates the **order** (shown in the conversation's side panel and
  on the deal, with the status and its history) and stores the customer's
  last-purchase date.

## What to apply and configure

**1. Migrations.** The feature needs these (apply them like any other; the
Docker stack's `migrate` service applies them for you, see
[docker.md](./docker.md)):

| Migration | Adds                                                                    |
| --------- | ----------------------------------------------------------------------- |
| `055`     | `stores.menu_url`                                                       |
| `056`     | Journeys, tracking tokens, the deal link to a Journey, the pipeline key |
| `057`     | The event log used for idempotency, and the cart snapshot               |
| `058`     | Orders and the contact's last-purchase date                             |
| `059`     | Order status history                                                    |
| `060`     | The `cancelled` state of parked automation runs                         |
| `061`     | The preset key of automations                                           |
| `062`     | The event that created each order (concurrent duplicate Purchases)      |

**2. The menu address of each store.** **Settings → Stores → edit a store →
Digital menu URL** (`https://…`). Each store sends its own domain. A store with
no address cannot send a menu link: the message is **not sent** and the failure
is visible (in the automation log; for the AI reply, a handoff note explains it).
The preset card and `GET /api/v1/stores` show which stores lack one.

**3. The link in your messages.** Write `{{menu_link}}` in the text of a
"send message" step of an automation, or let the AI reply use it (it is told to
write `{{menu_link}}` and never a fixed URL: remove any menu URL you pasted in
the AI business prompt or knowledge base). The CRM creates the token, sends the
message and then opens the Journey.

**4. An API key for the menu team.** **Settings → API keys → New API key** with
only the scope `events:write`. That key can send events and nothing else (it
reads no contacts, conversations or messages). Give it to the menu team as a
server secret; it must never reach the browser. If it leaks, revoke it: the
revocation applies on the next request.

**5. The preset.** **Automations → Order Journey → Add the Order Journey
preset** creates ten automations, all **off**:

- reminders 10 and 30 minutes after the link (only if the customer has not
  replied, has no cart yet, no agent is assigned and the AI did not hand off; all
  re-checked when the reminder is due);
- the abandoned-cart message, 10 minutes after the last "add to cart" or
  "checkout" without a purchase, once per Journey;
- the thank-you, on `Purchase`;
- one message per order status: `received`, `preparing`, `finished`,
  `out_for_delivery`, `ready_for_pickup`, `delivered`, `cancelled`. `delivered`
  is created too: leave it off if you do not want to message customers then.

The texts come in the language of the deployment (`NEXT_PUBLIC_APP_LOCALE`).
The card lists what is still missing. Review each text, then turn the
automations on in the list. They are ordinary automations: edit, duplicate or
delete them freely. The variables `{{order_id}}`, `{{order_status}}` and
`{{order_value}}` are available in those texts. Running the preset again only
adds what you deleted; it never overwrites your edits.

**6. WhatsApp templates (`fallback_template`).** WhatsApp only allows free text
within 24 hours of the customer's last message. Reminders, abandoned cart and
status updates often go out later, so each "send message" step has a **fallback
template**: an approved template (**Templates**) that is sent instead when the
window is closed, with fixed variables if it has any. Without it, a send
outside the window **fails visibly** (automation log and a failed message in
the conversation); it never silently drops. Telegram has no window, so the field
does nothing there. A message that contains `{{menu_link}}` ignores the fallback
template (the template would not carry the link): outside the window it fails.

**7. The scheduler.** Reminders and abandoned cart are Wait steps, and abandoned
Journeys are closed by the same job. Nothing inside the app runs on a clock:
point an external scheduler at `GET /api/automations/cron` (header
`x-cron-secret`, from `AUTOMATION_CRON_SECRET`) **every 1 to 2 minutes**. With a
5-minute interval a "10 minute" reminder can leave up to 5 minutes late. Details
in [docker.md](./docker.md#notes).

## Reading the funnel

- **Pipelines → Jornada de Pedido** shows the deals by stage. The card shows the
  number of items and the value of the cart. Filters for **channel** and
  **store** narrow the board.
- The **Journey conversion** panel lists, overall, by channel and by store, how
  many Journeys reached each step (in it **or beyond**: a Journey that skipped
  a step still counts as having reached the ones it jumped over), how many were
  lost, and the rate from link sent to purchase. The conversion table is not
  filtered: it always shows every group.
- A Journey becomes **Perdido** after 24 hours without engagement (last event,
  last link, last customer message) once no reminder is still waiting. A later
  `Purchase` opens a new Journey; the lost one is not reopened.
- When a conversation is handed to a human (AI handoff), the note includes the
  Journey stage, the active order and its status, and the last event.

## One set of automations for several brands

The rule is **one set of automations for every brand** in the account. Two tools
keep it that way:

- **`{{store_name}}`** in the text of a "send message" step is replaced by the
  name of the store of the conversation (conversation → connection → store, the
  store's `name`). It works in the texts sent by the Journey event, order status
  and menu link sent triggers. If the conversation has no store (or the run has
  no conversation), the variable becomes empty text and the step log records a
  warning; the send does not fail.
- **Condition "Store business acronym is X"** (`business_acronym_is`) is for the
  rare brand that needs a really different text: duplicate the automation and
  add the condition. The acronym is the store's **business acronym** field,
  compared ignoring case and surrounding spaces. It is read from the database
  when the step runs (also when a run resumes after a wait), never from a
  snapshot. No store or no acronym means false.

**WhatsApp templates.** Templates may have the **same name in every WABA**, each
brand with its own content. A single `fallback_template` then serves all brands:
the send goes out through the store's connection, and Meta resolves the name in
that connection's WABA. This naming convention has **not been tested with two
real WABAs**.

## Known limitations

- **Precision of the reminders** depends on the scheduler interval (step 7).
- **`{{menu_link}}`** works in the text of a "send message" step and in the AI
  auto-reply. It is not expanded in buttons, lists, templates or Flows, nor in
  the AI draft or playground.
- The preset creates **one automation per step, not per channel**, with the text
  in the deployment language. For different texts per channel, duplicate the
  automation and adjust it. Steps are created with no fallback template (the name
  of a template is yours to choose).
- The reminders do not repeat the link (the customer already has it; the text
  invites them to reply). Re-sending the link renews the token and restarts the
  reminders, cancelling the previous ones.
- A `Purchase` that arrives after the abandoned-cart message was sent closes the
  Journey as won and cancels what is pending, but a message already sent cannot
  be taken back. A lost `Purchase` makes the CRM treat a buyer as an abandoner:
  the menu team must send `Purchase` and status events from an outbox with
  retries (see the contract).
- The handoff note and error messages from the engine are in English; they are
  not translated.
- The funnel has no date filter, and the board is filtered, not grouped, by
  channel and store.
- The `idtrack` is a CRM credential: it never appears in the public API's contact
  responses, and `POST /api/v1/contacts` refuses it as an identity.
- No message is sent for customers inactive for 30 days (a later phase); the
  last-purchase date is already stored for it.

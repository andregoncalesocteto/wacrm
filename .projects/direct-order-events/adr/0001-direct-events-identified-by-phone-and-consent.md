# Direct events: identify by store key and phone, and message only with consent

The digital menu can report events for customers who never received a menu link (orders from any origin), identifying the customer by `store_key` plus `customer.phone` instead of an `idtrack`. This relaxes the order journey's ADR 0001 (`../order-journey-recovery/adr/0001-journey-events-server-to-server-with-tracking-token.md`), whose tracking token meant a leaked events key could only touch contacts that had already been sent a link; with a phone number the key can reach any number. We accept that because the gain is covering every order and building the purchase history that the 30-day recovery needs, and we contain the risk by gating every message on **consent** reported by the menu (per purpose, notifications and marketing), opening the first contact only with an approved template, and never messaging without it: without consent the event still feeds orders and the funnel, but nothing is sent.

## Consequences

- When `idtrack` is present it still wins over the phone (a conflict is logged and the event's `customer`/`consent` fields are ignored), so the tracking token of that ADR stays the precise path.
- The events contract now carries personal data (phone, optional name) and consent evidence; the menu team owns collecting consent.
- A leaked `events:write` key can create contacts and, for customers with consent on record, trigger template messages; the per-key rate limit and template-only first contact are the only brakes in the first version.
- Conversations created for customers who never wrote are born closed so they do not flood the open inbox; they reopen when the customer answers.

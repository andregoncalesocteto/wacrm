# wacrm

A multi-store, multi-channel CRM where customers talk to a business through messaging channels. This glossary covers the order journey: how a customer goes from a conversation to an order placed on an external digital menu.

## Order journey

**Digital menu**:
The external ordering site, run by another team, where the customer builds and places an order. Each store has its own menu URL. wacrm never sees inside it; it only learns what the menu reports.
_Avoid_: Cardápio (in code), catalog, shop

**Journey**:
One attempt by a customer to place an order. It opens when wacrm sends a menu link or when a journey event arrives for a contact with no open Journey, and it ends when the order is placed (won) or the attempt is abandoned (lost).
_Avoid_: Funnel, session, flow (a Flow is the chat-builder feature)

**Tracking token**:
An opaque value wacrm mints when it sends a menu link and the menu echoes back as `idtrack`. It identifies one contact, one conversation and one connection, and stays valid until it expires, so a returning customer's later events still resolve.
_Avoid_: idtrack (as a domain term), contact id in URL, session id

**Journey event**:
A behaviour the customer performed on the menu (`ViewContent`, `AddToCart`, `InitiateCheckout`, `Purchase`), named after the Meta Pixel standard events and reported server-to-server by the menu.
_Avoid_: Pixel event, tracking event, analytics event

**Order**:
A purchase placed on the menu, created by a `Purchase` journey event and then advanced through order statuses.
_Avoid_: Purchase (that is the event), sale

**Order status**:
The state of an order after it is placed: received, preparing, finished, out for delivery or ready for pickup, delivered, or cancelled. Reported by the menu side in wacrm's own vocabulary; wacrm decides what message the customer gets.
_Avoid_: Order event, notification (the message is a consequence, not the status)

**Resumption**:
An automatic message sent to a customer whose conversation went quiet after the menu link was sent, at 10 and 30 minutes.
_Avoid_: Follow-up, nudge, reminder

# Direct order events

How the digital menu reports orders for customers who never received a menu link, identified by store and phone, and when wacrm may message them. It extends the order journey context (`../order-journey-recovery/CONTEXT.md`: Journey, Tracking token, Journey event, Order, Order status, Resumption).

## Language

**Store key**:
The identifier of a store in the form `CODE/STORE ACRONYM/BUSINESS ACRONYM` (for example `89/RPA/BLC`), built from three fields registered on the store in wacrm and sent by the digital menu to say which store an event belongs to. Unique per account.
_Avoid_: Store id, store code (that is only its first part)

**Business acronym**:
The last part of the store key (`BLC` for Bella Capri, `PZA` for Pizza Agora). It names the brand a store sells under, so two stores of the same site and code but different businesses are different stores, and message texts and templates vary by it.
_Avoid_: Brand, sigla (in code)

**Consent**:
The customer's permission, given on the digital menu and reported in the events it sends, for wacrm to message them on WhatsApp. It is given per purpose, notifications (order updates) and marketing (reminders and offers). Without it, wacrm records the customer's events but never starts a conversation or sends a message.
_Avoid_: Opt-in flag, permission

**Direct journey**:
A Journey that did not start from a menu link sent by wacrm: the customer reached the menu by another path and the events identify them by store key and phone. The resumptions that depend on the link do not apply to it.
_Avoid_: Organic journey, external journey

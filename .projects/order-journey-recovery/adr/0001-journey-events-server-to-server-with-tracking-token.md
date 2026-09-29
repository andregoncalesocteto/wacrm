# Journey events are reported server-to-server, keyed by an opaque tracking token

The digital menu (owned by another team) reports journey events and order statuses to wacrm from its backend with an API key (`events:write`), never from the customer's browser. Events are attributed through a **tracking token** that wacrm mints when it sends the menu link and the menu echoes back as `idtrack`; the token identifies a contact, conversation and connection, is reusable until it expires, and is not the contact id or phone. We chose this over a browser-side pixel (a public key would let anyone forge `Purchase` and trigger coupons or notifications) and over putting `contactId` in the URL (leaks an internal identifier).

## Consequences

- The menu team must call wacrm from their backend and carry `idtrack` through the whole purchase journey.
- A returning customer keeps sending events on the same token until it expires, so a new event on a token whose Journey is closed opens a new Journey instead of being rejected.
- `/api/v1` is pre-stable until the first client; this contract freezes with it.

# Context Map

## Contexts

- [Order journey](./.projects/order-journey-recovery/CONTEXT.md): how a customer goes from a conversation to an order placed on an external digital menu, and how wacrm follows and recovers that journey
- [Direct order events](./.projects/direct-order-events/CONTEXT.md): how the menu reports orders of customers who never received a menu link, identified by store and phone, and when wacrm may message them

## Relationships

- **Direct order events → Order journey**: extends it; a Direct journey is a Journey (Order journey) that starts from a menu event instead of a menu link, and reuses its Order, Order status and Journey event

-- 062: the event that created an order.
--
-- `origin_event_id` is the `event_id` of the Purchase that inserted the order.
-- Two Purchases with the same `order_id` but different `event_id` can race for
-- the insert; the loser reads this column to know the order belongs to ANOTHER
-- event and answers as a duplicate, instead of mistaking it for its own retry.
-- Orders created before this migration keep NULL (treated as "own retry" when
-- the Journey matches, the previous behaviour).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS origin_event_id TEXT;

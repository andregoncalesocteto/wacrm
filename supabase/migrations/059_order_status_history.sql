-- ============================================================
-- 059_order_status_history
--
-- order-journey-recovery, ticket #8. OrderStatusChanged of the public events
-- API keeps the order's status history on the order itself:
--   * orders.status_history : JSONB array, oldest first, one entry per applied
--                             change: {status, from, occurred_at, recorded_at,
--                             event_id}. Appended together with `status` in a
--                             single UPDATE, so both always agree.
-- No new table, so RLS and merge_contacts (orders already re-pointed in 058)
-- are unchanged. Idempotent.
-- ============================================================

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS status_history JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ============================================================
-- 067_direct_journey_unique_per_store
--
-- direct-order-events, review fix. A direct Journey is looked up by
-- (account, contact, STORE), whatever connection it has now: the store's
-- notice connection can appear, change or be disabled between events, and the
-- two partial unique indexes of 056/064 (per connection, per store without a
-- connection) did not collide, so a second open direct Journey could be born
-- and the Purchase would land on it.
--
--   * Duplicate open `menu_direct` Journeys of the same contact + store are
--     closed first (the most recently active one survives): state/stage
--     `lost`, `closed_at` set; their open deal is marked lost and moved to the
--     pipeline's `lost` stage when it has one.
--   * uq_journeys_open_direct_contact_store: ONE open `menu_direct` Journey per
--     account + contact + store.
-- Idempotent (after the cleanup there is nothing left to close).
-- ============================================================

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY account_id, contact_id, store_id
           ORDER BY COALESCE(last_event_at, created_at) DESC, created_at DESC, id DESC
         ) AS rn
  FROM public.journeys
  WHERE state = 'open' AND origin = 'menu_direct' AND store_id IS NOT NULL
),
closed AS (
  UPDATE public.journeys j
     SET state = 'lost', stage = 'lost', closed_at = now()
    FROM ranked r
   WHERE j.id = r.id AND r.rn > 1
  RETURNING j.id
)
UPDATE public.deals d
   SET status = 'lost',
       stage_id = COALESCE(
         (SELECT s.id FROM public.pipeline_stages s
           WHERE s.pipeline_id = d.pipeline_id AND s.system_key = 'lost'),
         d.stage_id)
  FROM closed c
 WHERE d.journey_id = c.id AND d.status = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS uq_journeys_open_direct_contact_store
  ON public.journeys (account_id, contact_id, store_id)
  WHERE state = 'open' AND origin = 'menu_direct';

-- ============================================================
-- 057_journey_events
--
-- order-journey-recovery, ticket #5. Adds:
--   * journey_events        : one row per accepted event of the public events
--                             API (`POST /api/v1/journey/events`), the first
--                             idempotency store of the v1 routes. UNIQUE
--                             (account_id, event_id) is both the replay lookup
--                             and the lock against two concurrent requests
--                             carrying the same event_id. A row with a NULL
--                             `response` is a claim still being processed.
--   * journeys.cart_items    : the last cart snapshot's items (jsonb), beside
--                             the existing cart_items_count / cart_value.
-- Service-role only (RLS on, NO policy): the rows hold API responses. It has no
-- contact_id, so merge_contacts needs no change. Idempotent.
-- ============================================================

ALTER TABLE public.journeys
  ADD COLUMN IF NOT EXISTS cart_items JSONB;

CREATE TABLE IF NOT EXISTS public.journey_events (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id   UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  journey_id   UUID REFERENCES public.journeys(id) ON DELETE SET NULL,
  -- Original success payload, replayed verbatim for a repeated event_id.
  -- NULL while the first request is still running.
  response     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT journey_events_event_key UNIQUE (account_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_journey_events_journey ON public.journey_events (journey_id);

-- RLS ON and deliberately NO policy: only the service role may touch it.
ALTER TABLE public.journey_events ENABLE ROW LEVEL SECURITY;

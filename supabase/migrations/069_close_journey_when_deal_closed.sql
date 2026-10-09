-- ============================================================
-- 069_close_journey_when_deal_closed
--
-- order-journey fix. An operator can close the DEAL of a Journey by hand: the
-- "Marcar como ganho" / "Marcar como perdido" buttons set `deals.status`, and
-- dragging the card into the "Comprou" / "Perdido" column sets
-- `deals.stage_id`. Neither touched the Journey, which stayed `open`. Every
-- later link and event then landed on that open Journey, whose deal can no
-- longer leave a terminal stage (the app only advances a deal that is still
-- BEFORE the target stage), so the customer's new activity was invisible in
-- the pipeline and no new Journey or deal was ever opened.
--
--   * trg_close_journey_when_deal_closed: when a deal that belongs to a
--     Journey is set to won/lost (status) or moved to the pipeline's won/lost
--     stage, the OPEN Journey closes with the same outcome (state and stage,
--     closed_at). Scheduled messages (resumptions, abandoned cart) re-check
--     `state = 'open'` when they fire, so closing the Journey cancels them.
--     The next link or event opens a NEW Journey and deal; a closed Journey is
--     never reopened (reopening the deal does not reopen it either).
--   * SECURITY DEFINER: agents may update deals but `journeys` has only a
--     SELECT policy, so the trigger has to write as its owner.
--   * The app's own closes (Purchase, the abandonment sweep) update the
--     Journey first and the deal second, so by then the Journey is no longer
--     open and the trigger does nothing.
--   * Backfill: open Journeys whose deal is already won/lost (or sits in such a
--     stage) are closed the same way.
-- Idempotent.
-- ============================================================

CREATE OR REPLACE FUNCTION public.close_journey_when_deal_closed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_outcome text;
BEGIN
  IF NEW.journey_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The outcome the operator chose: the status wins; otherwise the stage the
  -- card was dropped on, when that stage is the pipeline's won/lost one.
  IF NEW.status IN ('won', 'lost') THEN
    v_outcome := NEW.status;
  ELSE
    SELECT s.system_key INTO v_outcome
      FROM public.pipeline_stages s
     WHERE s.id = NEW.stage_id
       AND s.system_key IN ('won', 'lost');
  END IF;

  IF v_outcome IS NOT NULL THEN
    UPDATE public.journeys
       SET state = v_outcome,
           stage = v_outcome,
           closed_at = now()
     WHERE id = NEW.journey_id
       AND state = 'open';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_close_journey_when_deal_closed ON public.deals;
CREATE TRIGGER trg_close_journey_when_deal_closed
  AFTER UPDATE OF status, stage_id ON public.deals
  FOR EACH ROW
  WHEN (
    NEW.journey_id IS NOT NULL
    AND (NEW.status IS DISTINCT FROM OLD.status
         OR NEW.stage_id IS DISTINCT FROM OLD.stage_id)
  )
  EXECUTE FUNCTION public.close_journey_when_deal_closed();

-- Backfill: Journeys that are still open although their deal was closed by hand.
UPDATE public.journeys j
   SET state = c.outcome,
       stage = c.outcome,
       closed_at = now()
  FROM (
    SELECT d.journey_id,
           CASE WHEN d.status IN ('won', 'lost') THEN d.status
                ELSE s.system_key END AS outcome
      FROM public.deals d
      LEFT JOIN public.pipeline_stages s
             ON s.id = d.stage_id
            AND s.system_key IN ('won', 'lost')
     WHERE d.journey_id IS NOT NULL
       AND (d.status IN ('won', 'lost') OR s.system_key IS NOT NULL)
  ) c
 WHERE j.id = c.journey_id
   AND j.state = 'open';

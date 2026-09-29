-- ============================================================
-- 056_order_journeys
--
-- order-journey-recovery, ticket #3. Adds:
--   * tracking_tokens : opaque per (contact, conversation, connection) token
--                       echoed back by the Digital menu as `idtrack`.
--                       Service-role only (RLS on, NO policy): the token is a
--                       credential for the events API.
--   * journeys        : one attempt to place an order (state open/won/lost).
--   * deals.connection_id / deals.journey_id : a deal remembers the connection
--                       it came from and the Journey it represents; at most one
--                       OPEN deal per Journey.
--   * pipelines.system_key / pipeline_stages.system_key : stable keys so the
--                       CRM-managed "Jornada de Pedido" pipeline is found (and
--                       created idempotently) even after an operator renames it.
-- Idempotent. Writes to journeys/tokens happen from the service role only.
-- ============================================================

-- ---- pipelines / stages: stable system keys ----------------------
ALTER TABLE public.pipelines       ADD COLUMN IF NOT EXISTS system_key TEXT;
ALTER TABLE public.pipeline_stages ADD COLUMN IF NOT EXISTS system_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipelines_account_system_key
  ON public.pipelines (account_id, system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_stages_pipeline_system_key
  ON public.pipeline_stages (pipeline_id, system_key) WHERE system_key IS NOT NULL;

-- ---- journeys ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journeys (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id             UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id             UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id        UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  connection_id          UUID NOT NULL REFERENCES public.channel_connections(id) ON DELETE CASCADE,
  deal_id                UUID REFERENCES public.deals(id) ON DELETE SET NULL,
  state                  TEXT NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'won', 'lost')),
  -- Current funnel stage (system key of the pipeline stage); never regresses.
  stage                  TEXT NOT NULL DEFAULT 'link_sent'
    CHECK (stage IN ('link_sent', 'browsing', 'cart', 'checkout', 'won', 'lost')),
  -- Latest menu link sent (anchor of the resumption clocks) and how many.
  link_sent_at           TIMESTAMPTZ NOT NULL,
  link_count             INTEGER NOT NULL DEFAULT 1,
  last_event_at          TIMESTAMPTZ,
  -- ViewContent: first occurrence marks the stage, the rest is a counter.
  view_content_count     INTEGER NOT NULL DEFAULT 0,
  first_view_content_at  TIMESTAMPTZ,
  -- Cart snapshot, replaced by every AddToCart / InitiateCheckout.
  cart_items_count       INTEGER NOT NULL DEFAULT 0,
  cart_value             NUMERIC(12,2) NOT NULL DEFAULT 0,
  cart_currency          TEXT,
  last_add_to_cart_at    TIMESTAMPTZ,
  checkout_started_at    TIMESTAMPTZ,
  purchased_at           TIMESTAMPTZ,
  -- Resumption / abandoned-cart bookkeeping (each message at most once).
  resumption_10_sent_at  TIMESTAMPTZ,
  resumption_30_sent_at  TIMESTAMPTZ,
  abandoned_cart_sent_at TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open Journey per contact + connection.
CREATE UNIQUE INDEX IF NOT EXISTS uq_journeys_open_contact_connection
  ON public.journeys (account_id, contact_id, connection_id) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_journeys_account_state ON public.journeys (account_id, state);
CREATE INDEX IF NOT EXISTS idx_journeys_contact ON public.journeys (contact_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.journeys;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.journeys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.journeys ENABLE ROW LEVEL SECURITY;
-- Members read; writes are service-role only (no write policy on purpose).
DROP POLICY IF EXISTS journeys_select ON public.journeys;
CREATE POLICY journeys_select ON public.journeys FOR SELECT
  USING (is_account_member(account_id));

-- ---- deals: connection + journey -----------------------------------
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES public.channel_connections(id) ON DELETE SET NULL;
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS journey_id UUID
    REFERENCES public.journeys(id) ON DELETE SET NULL;

-- Never two OPEN deals for the same Journey.
CREATE UNIQUE INDEX IF NOT EXISTS uq_deals_open_journey
  ON public.deals (journey_id) WHERE journey_id IS NOT NULL AND status = 'open';

-- ---- tracking_tokens -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tracking_tokens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id      UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id      UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  connection_id   UUID NOT NULL REFERENCES public.channel_connections(id) ON DELETE CASCADE,
  token           TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracking_tokens_token_key UNIQUE (token),
  -- A contact/conversation/connection never holds two tokens: resend renews.
  CONSTRAINT tracking_tokens_target_key UNIQUE (contact_id, conversation_id, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_tracking_tokens_account ON public.tracking_tokens (account_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.tracking_tokens;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.tracking_tokens
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Secrets: RLS ON and deliberately NO policy. Only the service role
-- (which bypasses RLS) may touch this table. Do not add one.
ALTER TABLE public.tracking_tokens ENABLE ROW LEVEL SECURITY;

-- ---- merge_contacts (049/051) also handles journeys + tracking_tokens ----
-- Guard test and verify-schema.sql require every contact_id table to be
-- re-pointed. Tokens/Journeys of a folded conversation follow it to the
-- survivor's conversation; an open Journey that would collide with the
-- survivor's open one (same connection) is closed as lost, with its deal.
CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_account_id   UUID,
  p_survivor_id  UUID,
  p_duplicate_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dup        contacts%ROWTYPE;
  v_conv       RECORD;
  v_target     UUID;
  v_n          INTEGER;
  v_conv_moved INTEGER := 0;
  v_conv_merged INTEGER := 0;
  v_msgs       INTEGER := 0;
  v_deals      INTEGER := 0;
  v_notes      INTEGER := 0;
  v_tags       INTEGER := 0;
  v_values     INTEGER := 0;
  v_idents     INTEGER := 0;
  v_runs       INTEGER := 0;
  v_other      INTEGER := 0;
BEGIN
  IF p_survivor_id = p_duplicate_id THEN
    RAISE EXCEPTION 'same_contact' USING ERRCODE = '22023';
  END IF;

  -- Lock both rows (fixed order) and confirm the account.
  PERFORM 1 FROM contacts
    WHERE id IN (p_survivor_id, p_duplicate_id) AND account_id = p_account_id
    ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM contacts
      WHERE id IN (p_survivor_id, p_duplicate_id) AND account_id = p_account_id) <> 2 THEN
    RAISE EXCEPTION 'contact_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_dup FROM contacts WHERE id = p_duplicate_id;

  -- Conversations.
  FOR v_conv IN
    SELECT * FROM conversations WHERE contact_id = p_duplicate_id ORDER BY created_at, id
  LOOP
    SELECT id INTO v_target FROM conversations
      WHERE contact_id = p_survivor_id AND connection_id = v_conv.connection_id;

    IF v_target IS NULL THEN
      UPDATE conversations SET contact_id = p_survivor_id, updated_at = NOW()
        WHERE id = v_conv.id;
      v_conv_moved := v_conv_moved + 1;
    ELSE
      -- Only one active flow run per conversation: the folded one is
      -- closed when the survivor's conversation already has an active run.
      IF EXISTS (SELECT 1 FROM flow_runs WHERE conversation_id = v_target AND status = 'active') THEN
        UPDATE flow_runs
          SET status = 'failed', ended_at = NOW(), end_reason = 'contact_merged'
          WHERE conversation_id = v_conv.id AND status = 'active';
      END IF;

      UPDATE messages SET conversation_id = v_target WHERE conversation_id = v_conv.id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_msgs := v_msgs + v_n;
      UPDATE message_reactions SET conversation_id = v_target WHERE conversation_id = v_conv.id;
      UPDATE deals SET conversation_id = v_target WHERE conversation_id = v_conv.id;
      UPDATE journeys SET conversation_id = v_target WHERE conversation_id = v_conv.id;
      UPDATE tracking_tokens SET conversation_id = v_target
        WHERE conversation_id = v_conv.id
          AND NOT EXISTS (SELECT 1 FROM tracking_tokens s WHERE s.conversation_id = v_target);
      UPDATE flow_runs SET conversation_id = v_target WHERE conversation_id = v_conv.id;
      UPDATE notifications SET conversation_id = v_target WHERE conversation_id = v_conv.id;
      UPDATE ai_usage_log SET conversation_id = v_target WHERE conversation_id = v_conv.id;
      UPDATE automation_pending_executions SET conversation_id = v_target WHERE conversation_id = v_conv.id;

      UPDATE conversations c
      SET unread_count = c.unread_count + v_conv.unread_count,
          ai_reply_count = COALESCE(c.ai_reply_count, 0) + COALESCE(v_conv.ai_reply_count, 0),
          ai_autoreply_disabled = c.ai_autoreply_disabled OR v_conv.ai_autoreply_disabled,
          status = CASE WHEN c.status = 'closed' AND v_conv.status <> 'closed'
                        THEN v_conv.status ELSE c.status END,
          assigned_agent_id = COALESCE(c.assigned_agent_id, v_conv.assigned_agent_id),
          updated_at = NOW()
      WHERE c.id = v_target;

      UPDATE conversations c
      SET last_message_text = lm.content_text,
          last_message_at = lm.created_at
      FROM (
        SELECT content_text, created_at FROM messages
        WHERE conversation_id = v_target ORDER BY created_at DESC LIMIT 1
      ) lm
      WHERE c.id = v_target;

      DELETE FROM conversations WHERE id = v_conv.id;
      v_conv_merged := v_conv_merged + 1;
    END IF;
  END LOOP;

  -- Plain re-points (no contact-scoped unique constraint).
  UPDATE deals SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_deals = ROW_COUNT;
  UPDATE contact_notes SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;
  UPDATE contact_identities SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_idents = ROW_COUNT;
  UPDATE flow_runs SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_runs = ROW_COUNT;

  -- An open Journey of the duplicate that would collide with the survivor's
  -- open one on the same connection is closed (with its deal) before re-point.
  UPDATE deals SET status = 'lost'
    WHERE status = 'open' AND journey_id IN (
      SELECT j.id FROM journeys j
      WHERE j.contact_id = p_duplicate_id AND j.state = 'open'
        AND EXISTS (
          SELECT 1 FROM journeys s
          WHERE s.contact_id = p_survivor_id AND s.state = 'open'
            AND s.connection_id = j.connection_id
        )
    );
  UPDATE journeys j SET state = 'lost', stage = 'lost', closed_at = NOW()
    WHERE j.contact_id = p_duplicate_id AND j.state = 'open'
      AND EXISTS (
        SELECT 1 FROM journeys s
        WHERE s.contact_id = p_survivor_id AND s.state = 'open'
          AND s.connection_id = j.connection_id
      );
  UPDATE journeys SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_other := v_other + v_n;
  UPDATE tracking_tokens SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_other := v_other + v_n;
  UPDATE broadcast_recipients SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_other := v_other + v_n;
  UPDATE automation_logs SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_other := v_other + v_n;
  UPDATE automation_pending_executions SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_other := v_other + v_n;
  UPDATE notifications SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_other := v_other + v_n;

  -- Conflict-guarded re-points: the survivor's own row wins.
  UPDATE contact_tags ct SET contact_id = p_survivor_id
    WHERE ct.contact_id = p_duplicate_id
      AND NOT EXISTS (
        SELECT 1 FROM contact_tags s
        WHERE s.contact_id = p_survivor_id AND s.tag_id = ct.tag_id
      );
  GET DIAGNOSTICS v_tags = ROW_COUNT;
  DELETE FROM contact_tags WHERE contact_id = p_duplicate_id;

  UPDATE contact_custom_values cv SET contact_id = p_survivor_id
    WHERE cv.contact_id = p_duplicate_id
      AND NOT EXISTS (
        SELECT 1 FROM contact_custom_values s
        WHERE s.contact_id = p_survivor_id AND s.custom_field_id = cv.custom_field_id
      );
  GET DIAGNOSTICS v_values = ROW_COUNT;
  DELETE FROM contact_custom_values WHERE contact_id = p_duplicate_id;

  -- Delete first so the phone unique index is free, then fill the
  -- survivor's empty fields from the removed contact.
  DELETE FROM contacts WHERE id = p_duplicate_id;

  UPDATE contacts s
  SET phone = CASE WHEN s.phone = '' THEN v_dup.phone ELSE s.phone END,
      name = COALESCE(NULLIF(s.name, ''), v_dup.name),
      email = COALESCE(NULLIF(s.email, ''), v_dup.email),
      company = COALESCE(NULLIF(s.company, ''), v_dup.company),
      avatar_url = COALESCE(s.avatar_url, v_dup.avatar_url),
      updated_at = NOW()
  WHERE s.id = p_survivor_id;

  RETURN jsonb_build_object(
    'conversations_moved',  v_conv_moved,
    'conversations_merged', v_conv_merged,
    'messages_moved',       v_msgs,
    'deals',                v_deals,
    'notes',                v_notes,
    'tags',                 v_tags,
    'custom_values',        v_values,
    'identities',           v_idents,
    'flow_runs',            v_runs,
    'other',                v_other
  );
END;
$$;

ALTER FUNCTION public.merge_contacts(UUID, UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_contacts(UUID, UUID, UUID) TO service_role;

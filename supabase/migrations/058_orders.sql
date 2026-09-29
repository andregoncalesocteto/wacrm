-- ============================================================
-- 058_orders
--
-- order-journey-recovery, ticket #6. Adds:
--   * orders                  : one row per Purchase of the public events API,
--                               unique per (account_id, external_order_id).
--                               Members read (RLS); writes are service-role only.
--   * contacts.last_purchase_at : instant of the contact's latest Purchase.
-- `orders.status` already holds the full vocabulary of OrderStatusChanged
-- (ticket #7): a new order starts at 'placed' (the Purchase itself).
-- merge_contacts is redefined below (orders carry contact_id).
-- Idempotent.
-- ============================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS last_purchase_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.orders (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id        UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The Digital menu's own order identifier (`properties.order_id`).
  external_order_id TEXT NOT NULL,
  contact_id        UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id   UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  connection_id     UUID REFERENCES public.channel_connections(id) ON DELETE SET NULL,
  journey_id        UUID REFERENCES public.journeys(id) ON DELETE SET NULL,
  deal_id           UUID REFERENCES public.deals(id) ON DELETE SET NULL,
  -- Tracking token the Purchase came with (origin of the order).
  idtrack           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed', 'received', 'preparing', 'finished',
                      'out_for_delivery', 'ready_for_pickup', 'delivered',
                      'cancelled')),
  status_changed_at TIMESTAMPTZ,
  value             NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL,
  -- [{id, name, quantity, unit_price}]
  items             JSONB NOT NULL DEFAULT '[]'::jsonb,
  placed_at         TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_external_key UNIQUE (account_id, external_order_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON public.orders (contact_id);
CREATE INDEX IF NOT EXISTS idx_orders_conversation ON public.orders (conversation_id);
CREATE INDEX IF NOT EXISTS idx_orders_deal ON public.orders (deal_id);
CREATE INDEX IF NOT EXISTS idx_orders_journey ON public.orders (journey_id);

DROP TRIGGER IF EXISTS set_updated_at ON public.orders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
-- Members read; writes are service-role only (no write policy on purpose).
DROP POLICY IF EXISTS orders_select ON public.orders;
CREATE POLICY orders_select ON public.orders FOR SELECT
  USING (is_account_member(account_id));

-- ---- merge_contacts (056) also handles orders ----
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
      UPDATE orders SET conversation_id = v_target WHERE conversation_id = v_conv.id;
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
  UPDATE orders SET contact_id = p_survivor_id WHERE contact_id = p_duplicate_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_other := v_other + v_n;
  -- Latest purchase of the two contacts survives on the survivor.
  UPDATE contacts SET last_purchase_at = GREATEST(last_purchase_at, v_dup.last_purchase_at)
    WHERE id = p_survivor_id;
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

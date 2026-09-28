-- ============================================================
-- 054_broadcast_free_message_rpc
--
-- broadcast-multi-channel, US-004. `create_broadcast_with_recipients`
-- (037/038/041/046) still only ever inserts template_name/template_language
-- into `broadcasts` — it has no way to write the message_text/
-- message_media_url columns 052 added, so createBroadcast could not persist
-- a free-message broadcast atomically (the parent insert must carry either
-- shape in the SAME statement, or it trips the 052 exclusivity CHECK).
--
-- Adds three DEFAULT NULL params to the end of the signature (old callers
-- keep working unchanged) and writes them straight into the new columns:
--   p_message_text        text  — free-message body
--   p_message_media_url   text  — free-message media
--   p_template_variables  jsonb — campaign-level variable mapping, reused
--                                 for either content shape (052's comment)
-- The old 9-argument overload is dropped first, same as 046 did for the
-- 8-argument one, so an omitted-arg call stays unambiguous. Everything
-- else in the body is unchanged. Idempotent.
-- ============================================================

DROP FUNCTION IF EXISTS public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID);

CREATE OR REPLACE FUNCTION public.create_broadcast_with_recipients(
  p_account_id         UUID,
  p_user_id            UUID,
  p_name               TEXT,
  p_template_name      TEXT,
  p_template_language  TEXT,
  p_total_recipients   INTEGER,
  p_contact_ids        UUID[],
  p_template_params    JSONB[],
  p_connection_id      UUID DEFAULT NULL,
  p_message_text       TEXT DEFAULT NULL,
  p_message_media_url  TEXT DEFAULT NULL,
  p_template_variables JSONB DEFAULT NULL
)
RETURNS TABLE(broadcast_id UUID, recipient_id UUID, contact_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
BEGIN
  INSERT INTO broadcasts (
    account_id, user_id, name, template_name,
    template_language, status, total_recipients, connection_id,
    message_text, message_media_url, template_variables
  )
  VALUES (
    p_account_id, p_user_id, p_name, p_template_name,
    p_template_language, 'sending', p_total_recipients, p_connection_id,
    p_message_text, p_message_media_url, p_template_variables
  )
  RETURNING id INTO v_broadcast_id;

  RETURN QUERY
  WITH ins AS (
    INSERT INTO broadcast_recipients (
      broadcast_id, contact_id, status, template_params
    )
    SELECT v_broadcast_id, t.cid, 'pending', t.prm
    FROM unnest(p_contact_ids, p_template_params) AS t(cid, prm)
    RETURNING id, broadcast_recipients.contact_id
  )
  SELECT v_broadcast_id, ins.id, ins.contact_id
  FROM ins;
END;
$$;

REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID, TEXT, TEXT, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID, TEXT, TEXT, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_broadcast_with_recipients(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, UUID[], JSONB[], UUID, TEXT, TEXT, JSONB) TO service_role;

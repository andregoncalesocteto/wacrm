-- ============================================================
-- 051_final_contract_migration
--
-- Channel abstraction, FINAL contract phase (design.md section 4;
-- PRD US-070). This is the destructive step: the old WhatsApp-only
-- model (`whatsapp_config`, the legacy `contacts` columns) is removed.
-- Everything downstream now goes exclusively through
-- `channel_connections` / `contact_identities`.
--
--   1. message_templates.connection_id  NOT NULL, unique index moves
--      from (user_id, name, language) to (connection_id, name, language)
--   2. broadcasts.connection_id  NOT NULL
--   3. automation_pending_executions.conversation_id / .connection_id
--      NOT NULL
--   4. merge_contacts() (049) and redeem_invitation() (019) stop
--      touching the columns/table this migration drops
--   5. DROP TABLE whatsapp_config
--   6. DROP contacts.wa_user_id / wa_parent_user_id / wa_username
--
-- Backfill before each NOT NULL mirrors 047's pattern for
-- conversations: an account with a whatsapp_cloud connection gets its
-- rows pointed there (enabled one first, oldest); an account with none
-- gets (or reuses) a DISABLED legacy connection so the row still has
-- somewhere valid to point at. On this codebase's own data none of this
-- fires (043-050 already backfilled everything) — it exists so a fork
-- with older, messier data does not fail SET NOT NULL.
-- ============================================================

-- 1a. message_templates.connection_id backfill.
UPDATE message_templates t
SET connection_id = (
  SELECT cc.id FROM channel_connections cc
  WHERE cc.account_id = t.account_id AND cc.channel_type = 'whatsapp_cloud'
  ORDER BY (cc.disabled_at IS NULL) DESC, cc.created_at, cc.id
  LIMIT 1
)
WHERE t.connection_id IS NULL
  AND EXISTS (
    SELECT 1 FROM channel_connections cc
    WHERE cc.account_id = t.account_id AND cc.channel_type = 'whatsapp_cloud'
  );

-- 1b. broadcasts.connection_id backfill (same rule).
UPDATE broadcasts b
SET connection_id = (
  SELECT cc.id FROM channel_connections cc
  WHERE cc.account_id = b.account_id AND cc.channel_type = 'whatsapp_cloud'
  ORDER BY (cc.disabled_at IS NULL) DESC, cc.created_at, cc.id
  LIMIT 1
)
WHERE b.connection_id IS NULL
  AND EXISTS (
    SELECT 1 FROM channel_connections cc
    WHERE cc.account_id = b.account_id AND cc.channel_type = 'whatsapp_cloud'
  );

-- 1c. Accounts with a template or broadcast still NULL (no connection at
--     all) get the same legacy-disabled-connection treatment 047 gave
--     conversations, reusing one it already created for the account.
DO $$
DECLARE
  acc      RECORD;
  v_store  UUID;
  v_conn   UUID;
BEGIN
  FOR acc IN
    SELECT DISTINCT account_id, account_name FROM (
      SELECT t.account_id, a.name AS account_name
      FROM message_templates t JOIN accounts a ON a.id = t.account_id
      WHERE t.connection_id IS NULL
      UNION
      SELECT b.account_id, a.name AS account_name
      FROM broadcasts b JOIN accounts a ON a.id = b.account_id
      WHERE b.connection_id IS NULL
    ) orphans
  LOOP
    SELECT s.id INTO v_store
    FROM stores s WHERE s.account_id = acc.account_id
    ORDER BY s.created_at, s.id LIMIT 1;

    IF v_store IS NULL THEN
      INSERT INTO stores (account_id, name)
      VALUES (acc.account_id, COALESCE(NULLIF(btrim(acc.account_name), ''), 'Loja principal'))
      RETURNING id INTO v_store;
    END IF;

    INSERT INTO channel_connections (
      account_id, store_id, channel_type, display_name, external_id,
      status, config, disabled_at
    ) VALUES (
      acc.account_id, v_store, 'whatsapp_cloud', 'WhatsApp (legado)',
      'legacy-' || acc.account_id::text,
      'disconnected', '{}'::jsonb, now()
    )
    ON CONFLICT (channel_type, external_id) DO NOTHING;

    SELECT cc.id INTO v_conn
    FROM channel_connections cc
    WHERE cc.channel_type = 'whatsapp_cloud'
      AND cc.external_id = 'legacy-' || acc.account_id::text
      AND cc.account_id = acc.account_id;

    UPDATE message_templates SET connection_id = v_conn
      WHERE account_id = acc.account_id AND connection_id IS NULL;
    UPDATE broadcasts SET connection_id = v_conn
      WHERE account_id = acc.account_id AND connection_id IS NULL;
  END LOOP;
END $$;

-- 2. automation_pending_executions: resolve conversation_id (and its
--    connection_id) from the contact's most recent conversation. A row
--    whose contact has no conversation at all cannot resume into
--    anything valid, so — like 047 did for orphan flow_runs — it is
--    dropped rather than left half-migrated.
UPDATE automation_pending_executions p
SET conversation_id = (
  SELECT c.id FROM conversations c
  WHERE c.contact_id = p.contact_id AND c.account_id = p.account_id
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id
  LIMIT 1
)
WHERE p.conversation_id IS NULL AND p.contact_id IS NOT NULL;

UPDATE automation_pending_executions p
SET connection_id = (SELECT c.connection_id FROM conversations c WHERE c.id = p.conversation_id)
WHERE p.connection_id IS NULL AND p.conversation_id IS NOT NULL;

DELETE FROM automation_pending_executions WHERE conversation_id IS NULL;

-- 3. message_templates: unique index moves to (connection_id, name,
--    language) — the same name on two connections of one account no
--    longer collides. Guard against a pre-existing duplicate the way
--    014 did, so a bad merge fails loudly instead of silently keeping
--    the old index.
DO $$
DECLARE
  dupe_count INTEGER;
  sample TEXT;
BEGIN
  SELECT count(*) INTO dupe_count
  FROM (
    SELECT connection_id, name, language
    FROM message_templates
    GROUP BY connection_id, name, language
    HAVING count(*) > 1
  ) dupes;

  IF dupe_count > 0 THEN
    SELECT string_agg(
      connection_id::text || ' / ' || name || ' / ' || COALESCE(language, '(null)') ||
        ' (' || count || ' rows)',
      E'\n  '
    )
    INTO sample
    FROM (
      SELECT connection_id, name, language, count(*) AS count
      FROM message_templates
      GROUP BY connection_id, name, language
      HAVING count(*) > 1
    ) dupe_detail;

    RAISE EXCEPTION
      E'Cannot add UNIQUE(connection_id, name, language) on message_templates — % duplicate combination(s):\n  %\nDelete the rows you do not want to keep, then re-run migrations.',
      dupe_count, sample;
  END IF;
END $$;

ALTER TABLE message_templates ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE broadcasts ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE automation_pending_executions ALTER COLUMN conversation_id SET NOT NULL;
ALTER TABLE automation_pending_executions ALTER COLUMN connection_id SET NOT NULL;

DROP INDEX IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_connection_name_language_key
  ON message_templates (connection_id, name, language);

-- 4a. merge_contacts (049) stops filling the dropped wa_* columns.
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

-- 4b. redeem_invitation (019) stops checking whatsapp_config for domain
--     data and checks the channel-abstraction tables instead.
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, stores/connections, etc.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM stores WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM channel_connections WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- 5. The legacy config table.
DROP TABLE IF EXISTS whatsapp_config;

-- 6. The legacy contact columns (contact_identities is the only source
--    of truth for BSUID/username from here on; the parent BSUID was
--    reference-only and read by no code).
DROP INDEX IF EXISTS idx_contacts_account_wa_user_id;
ALTER TABLE contacts
  DROP COLUMN IF EXISTS wa_user_id,
  DROP COLUMN IF EXISTS wa_parent_user_id,
  DROP COLUMN IF EXISTS wa_username;

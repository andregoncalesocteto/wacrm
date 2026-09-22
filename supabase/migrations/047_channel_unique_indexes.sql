-- ============================================================
-- 047_channel_unique_indexes
--
-- Channel abstraction, "contract" phase for conversations (design.md
-- section 4). IDEMPOTENT: every step is guarded, a re-run changes nothing.
--
--   1. re-run the connection_id backfill for conversations still NULL
--      (created by the old code after 045), from the account's
--      whatsapp_cloud connection: an enabled one first, then the oldest
--   2. accounts that still have NULL-connection conversations (no
--      whatsapp_config, so no connection: it was deleted after the fact)
--      get a DISABLED legacy connection (channel_type 'whatsapp_cloud',
--      external_id 'legacy-<account_id>', status 'disconnected',
--      disabled_at set, NO credentials row) in the account's oldest
--      store (created when the account has none), and their
--      conversations are linked to it, so the history is not lost
--   3. conversations.connection_id SET NOT NULL
--   4. idx_conversations_account_contact (account_id, contact_id) is
--      replaced by UNIQUE (contact_id, connection_id): one conversation
--      per contact AND connection. (connection_id, last_message_at DESC)
--      already exists from 044 (idx_conversations_connection_last_message)
--      and is only created here if missing, never duplicated
--   5. idx_one_active_run_per_contact (account_id, contact_id) is replaced
--      by a partial UNIQUE (conversation_id) WHERE status = 'active'.
--      Before it: active runs with conversation_id NULL (the conversation
--      was deleted, ON DELETE SET NULL) are attached to the contact's most
--      recent conversation, or, when the contact has none, closed as
--      'failed' (end_reason 'conversation_missing_migration_047'), since a
--      run without a conversation cannot send anything anyway. Runs with a
--      NULL conversation_id are not constrained by the new index (NULLs are
--      distinct)
-- ============================================================

-- 1. Backfill leftovers from the old code.
UPDATE conversations c
SET connection_id = (
  SELECT cc.id
  FROM channel_connections cc
  WHERE cc.account_id = c.account_id AND cc.channel_type = 'whatsapp_cloud'
  ORDER BY (cc.disabled_at IS NULL) DESC, cc.created_at, cc.id
  LIMIT 1
)
WHERE c.connection_id IS NULL
  AND EXISTS (
    SELECT 1 FROM channel_connections cc
    WHERE cc.account_id = c.account_id AND cc.channel_type = 'whatsapp_cloud'
  );

-- 2. Legacy disabled connection for accounts with orphan conversations.
DO $$
DECLARE
  acc      RECORD;
  v_store  UUID;
  v_conn   UUID;
BEGIN
  FOR acc IN
    SELECT DISTINCT c.account_id, a.name AS account_name
    FROM conversations c
    JOIN accounts a ON a.id = c.account_id
    WHERE c.connection_id IS NULL
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

    UPDATE conversations
    SET connection_id = v_conn
    WHERE account_id = acc.account_id AND connection_id IS NULL;
  END LOOP;
END $$;

-- 3. Every conversation now belongs to a connection.
ALTER TABLE conversations ALTER COLUMN connection_id SET NOT NULL;

-- 4. One conversation per (contact, connection).
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_contact_connection
  ON conversations (contact_id, connection_id);
DROP INDEX IF EXISTS idx_conversations_account_contact;
CREATE INDEX IF NOT EXISTS idx_conversations_connection_last_message
  ON conversations (connection_id, last_message_at DESC);

-- 5. One active flow run per conversation.
UPDATE flow_runs fr
SET conversation_id = (
  SELECT c.id FROM conversations c
  WHERE c.contact_id = fr.contact_id AND c.account_id = fr.account_id
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id
  LIMIT 1
)
WHERE fr.status = 'active' AND fr.conversation_id IS NULL AND fr.contact_id IS NOT NULL;

UPDATE flow_runs
SET status = 'failed',
    ended_at = now(),
    end_reason = 'conversation_missing_migration_047'
WHERE status = 'active' AND conversation_id IS NULL;

-- Two active runs of one contact would now land on the same conversation
-- only if the old per-contact index had been bypassed; keep the newest.
UPDATE flow_runs fr
SET status = 'failed',
    ended_at = now(),
    end_reason = 'duplicate_active_run_migration_047'
WHERE fr.status = 'active'
  AND EXISTS (
    SELECT 1 FROM flow_runs o
    WHERE o.conversation_id = fr.conversation_id
      AND o.status = 'active'
      AND (o.started_at, o.id) > (fr.started_at, fr.id)
  );

DROP INDEX IF EXISTS idx_one_active_run_per_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_conversation
  ON flow_runs (conversation_id)
  WHERE status = 'active';

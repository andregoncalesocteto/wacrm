-- ============================================================
-- 045_backfill_channel_model
--
-- Channel abstraction, "expand" phase (design.md section 4). Fills the
-- new model from the old one. Pure SQL, IDEMPOTENT: every step is guarded
-- by NOT EXISTS / IS NULL / ON CONFLICT DO NOTHING, so re-running adds
-- and changes nothing.
--
--   1. per account WITH a whatsapp_config row: one store (name = account
--      name) and one channel_connection 'whatsapp_cloud'
--      (external_id = phone_number_id)
--   2. the already-encrypted access_token is copied AS-IS (byte for byte,
--      no cipher key needed here) to channel_connection_credentials with
--      secrets_format = 'wa_token_v0' (single-token format)
--   3. conversations / message_templates / broadcasts .connection_id and
--      automation_pending_executions .conversation_id / .connection_id
--   4. contact_identities from phone_normalized, wa_user_id, wa_username
--
-- Accounts WITHOUT a whatsapp_config get no store and no connection: their
-- rows keep connection_id NULL (nothing to point at). whatsapp_config is
-- untouched. connection_id stays nullable until the "contract" phase.
-- ============================================================

DO $$
DECLARE
  cfg      RECORD;
  v_store  UUID;
BEGIN
  FOR cfg IN
    SELECT wc.*, a.name AS account_name
    FROM whatsapp_config wc
    JOIN accounts a ON a.id = wc.account_id
    WHERE NOT EXISTS (
      SELECT 1 FROM channel_connections cc
      WHERE cc.channel_type = 'whatsapp_cloud' AND cc.external_id = wc.phone_number_id
    )
    ORDER BY wc.created_at, wc.id
  LOOP
    INSERT INTO stores (account_id, name)
    VALUES (cfg.account_id, COALESCE(NULLIF(btrim(cfg.account_name), ''), 'Loja principal'))
    RETURNING id INTO v_store;

    INSERT INTO channel_connections (
      account_id, store_id, channel_type, display_name, external_id,
      status, config, connected_at
    ) VALUES (
      cfg.account_id, v_store, 'whatsapp_cloud',
      COALESCE(NULLIF(btrim(cfg.account_name), ''), 'WhatsApp'),
      cfg.phone_number_id,
      CASE WHEN cfg.status = 'connected' THEN 'connected' ELSE 'disconnected' END,
      jsonb_strip_nulls(jsonb_build_object(
        'waba_id', cfg.waba_id,
        'mirror_inbound_media', cfg.mirror_inbound_media,
        'registered_at', cfg.registered_at,
        'subscribed_apps_at', cfg.subscribed_apps_at,
        'last_registration_error', cfg.last_registration_error,
        'verify_token', cfg.verify_token
      )),
      cfg.connected_at
    );
  END LOOP;
END $$;

-- Credentials: token copied as-is (already AES-GCM ciphertext).
INSERT INTO channel_connection_credentials (connection_id, account_id, secrets_encrypted, secrets_format)
SELECT cc.id, cc.account_id, wc.access_token, 'wa_token_v0'
FROM whatsapp_config wc
JOIN channel_connections cc
  ON cc.channel_type = 'whatsapp_cloud'
 AND cc.external_id = wc.phone_number_id
 AND cc.account_id = wc.account_id
ON CONFLICT (connection_id) DO NOTHING;

-- Connection of each account that has a whatsapp_config.
UPDATE conversations c
SET connection_id = cc.id
FROM whatsapp_config wc
JOIN channel_connections cc
  ON cc.channel_type = 'whatsapp_cloud' AND cc.external_id = wc.phone_number_id
WHERE c.connection_id IS NULL
  AND c.account_id = wc.account_id
  AND cc.account_id = wc.account_id;

UPDATE message_templates t
SET connection_id = cc.id
FROM whatsapp_config wc
JOIN channel_connections cc
  ON cc.channel_type = 'whatsapp_cloud' AND cc.external_id = wc.phone_number_id
WHERE t.connection_id IS NULL
  AND t.account_id = wc.account_id
  AND cc.account_id = wc.account_id;

UPDATE broadcasts b
SET connection_id = cc.id
FROM whatsapp_config wc
JOIN channel_connections cc
  ON cc.channel_type = 'whatsapp_cloud' AND cc.external_id = wc.phone_number_id
WHERE b.connection_id IS NULL
  AND b.account_id = wc.account_id
  AND cc.account_id = wc.account_id;

-- Parked automation runs: conversation = the contact's most recent one
-- (NULL when the contact has none), connection = that conversation's.
UPDATE automation_pending_executions p
SET conversation_id = (
  SELECT c.id FROM conversations c
  WHERE c.contact_id = p.contact_id AND c.account_id = p.account_id
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC, c.id
  LIMIT 1
)
WHERE p.conversation_id IS NULL AND p.contact_id IS NOT NULL;

UPDATE automation_pending_executions p
SET connection_id = c.connection_id
FROM conversations c
WHERE p.connection_id IS NULL
  AND p.conversation_id = c.id
  AND c.connection_id IS NOT NULL;

-- Identities. The first contact (oldest) wins a collision; the rest are
-- skipped, never an error.
INSERT INTO contact_identities (account_id, contact_id, kind, external_id, handle)
SELECT DISTINCT ON (account_id, phone_normalized)
  account_id, id, 'whatsapp:phone', phone_normalized, NULL
FROM contacts
WHERE phone_normalized IS NOT NULL AND phone_normalized <> ''
ORDER BY account_id, phone_normalized, created_at, id
ON CONFLICT (account_id, kind, external_id) DO NOTHING;

INSERT INTO contact_identities (account_id, contact_id, kind, external_id, handle)
SELECT DISTINCT ON (account_id, wa_user_id)
  account_id, id, 'whatsapp:bsuid', wa_user_id, NULL
FROM contacts
WHERE wa_user_id IS NOT NULL AND wa_user_id <> ''
ORDER BY account_id, wa_user_id, created_at, id
ON CONFLICT (account_id, kind, external_id) DO NOTHING;

INSERT INTO contact_identities (account_id, contact_id, kind, external_id, handle)
SELECT DISTINCT ON (account_id, wa_username)
  account_id, id, 'whatsapp:username', wa_username, wa_username
FROM contacts
WHERE wa_username IS NOT NULL AND wa_username <> ''
ORDER BY account_id, wa_username, created_at, id
ON CONFLICT (account_id, kind, external_id) DO NOTHING;

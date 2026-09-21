-- Post-migration assertions for the CI job in
-- `.github/workflows/migrations.yml`.
--
-- `supabase db reset` already fails on any statement Postgres rejects,
-- so this is not about syntax. It's about the quieter failure: a
-- migration that applies cleanly and does nothing. Every DDL statement
-- in this repo is guarded with IF NOT EXISTS / ON CONFLICT so the files
-- can be re-run safely, and that same guard turns a typo'd object name
-- into a silent no-op with a green checkmark.
--
-- Keep this thin. It is a smoke test for "did the migrations actually
-- build the schema", not a spec of it — asserting every column here
-- would just be the migrations restated in a second place, drifting.
DO $$
BEGIN
  -- The core tables, from 001.
  IF to_regclass('public.messages') IS NULL THEN
    RAISE EXCEPTION 'public.messages is missing — migrations did not apply';
  END IF;
  IF to_regclass('public.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION 'public.whatsapp_config is missing — migrations did not apply';
  END IF;

  -- Supabase provides the storage schema; migrations 016/020/023 write
  -- to it. If it is absent the bucket migrations silently accomplish
  -- nothing, which is precisely the case a plain "no errors" run hides.
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION
      'storage.buckets is missing — the storage schema was not available when the bucket migrations ran';
  END IF;

  -- Buckets are UPSERTed, so their absence means the INSERT never ran.
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'chat-media') THEN
    RAISE EXCEPTION 'the chat-media bucket row was not created (migration 023)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'flow-media') THEN
    RAISE EXCEPTION 'the flow-media bucket row was not created (migration 016)';
  END IF;

  -- Account scoping (017) is load-bearing for every RLS policy.
  IF to_regclass('public.accounts') IS NULL THEN
    RAISE EXCEPTION 'public.accounts is missing — migration 017 did not apply';
  END IF;

  -- The BSUID index (040) is the only thing stopping a username-only
  -- WhatsApp sender from forking a new contact per inbound message. A
  -- typo in its name would apply cleanly and guarantee nothing.
  IF to_regclass('public.idx_contacts_account_wa_user_id') IS NULL THEN
    RAISE EXCEPTION
      'idx_contacts_account_wa_user_id is missing — migration 040 did not apply';
  END IF;

  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],uuid)'::regprocedure
     ) NOT LIKE '%RETURNING id, broadcast_recipients.contact_id%' THEN
    RAISE EXCEPTION
      'create_broadcast_with_recipients still has the ambiguous RETURNING — migration 041 did not apply';
  END IF;

  -- The failure-reason columns (042) are only ever written by the
  -- status webhook, which uses an untyped update — a missing column
  -- there is a runtime PostgREST error on every failed send, not a
  -- compile error.
  IF (
    SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages'
      AND column_name IN ('error_code', 'error_title', 'error_details')
  ) <> 3 THEN
    RAISE EXCEPTION
      'messages.error_code/error_title/error_details are missing — migration 042 did not apply';
  END IF;

  -- 043 adds the channel-abstraction tables. The credentials table must
  -- have RLS on and NO policy (service role only): a stray policy would
  -- expose encrypted secrets to members.
  IF to_regclass('public.stores') IS NULL
     OR to_regclass('public.channel_connections') IS NULL
     OR to_regclass('public.channel_connection_credentials') IS NULL
     OR to_regclass('public.contact_identities') IS NULL THEN
    RAISE EXCEPTION
      'stores / channel_connections / channel_connection_credentials / contact_identities are missing — migration 043 did not apply';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'channel_connection_credentials'
  ) THEN
    RAISE EXCEPTION
      'channel_connection_credentials must have no RLS policy (service role only)';
  END IF;
  IF NOT (
    SELECT relrowsecurity FROM pg_class
    WHERE oid = 'public.channel_connection_credentials'::regclass
  ) THEN
    RAISE EXCEPTION 'channel_connection_credentials must have RLS enabled';
  END IF;

  -- Channel abstraction expand columns (044), nullable. conversations.
  -- connection_id became NOT NULL in 047, so it is asserted below, not here.
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND is_nullable = 'YES' AND (
      (table_name = 'message_templates' AND column_name = 'connection_id')
      OR (table_name = 'broadcasts' AND column_name = 'connection_id')
      OR (table_name = 'automation_pending_executions' AND column_name IN ('conversation_id', 'connection_id'))
      OR (table_name = 'quick_replies' AND column_name = 'store_id')
    )
  ) <> 5 THEN
    RAISE EXCEPTION 'nullable channel columns are missing — migration 044 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.notifications'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%connection_down%'
  ) THEN
    RAISE EXCEPTION 'notifications.type must accept connection_down (migration 044)';
  END IF;

  -- Backfill (045): accounts that had a whatsapp_config must have a
  -- connection, and none of their conversations/templates/broadcasts may be
  -- left without connection_id. Accounts WITHOUT a whatsapp_config get no
  -- connection and are deliberately excluded (their rows stay NULL).
  IF EXISTS (
    SELECT 1 FROM whatsapp_config wc
    WHERE NOT EXISTS (
      SELECT 1 FROM channel_connections cc
      WHERE cc.account_id = wc.account_id AND cc.channel_type = 'whatsapp_cloud'
        AND cc.external_id = wc.phone_number_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM channel_connections cc
      JOIN channel_connection_credentials cr ON cr.connection_id = cc.id
      WHERE cc.account_id = wc.account_id AND cc.external_id = wc.phone_number_id
        AND cr.secrets_format = 'wa_token_v0' AND cr.secrets_encrypted = wc.access_token
    )
  ) THEN
    RAISE EXCEPTION 'whatsapp_config without connection/credentials after backfill (migration 045)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.connection_id IS NULL
      AND EXISTS (SELECT 1 FROM whatsapp_config wc WHERE wc.account_id = c.account_id)
  ) THEN
    RAISE EXCEPTION 'conversations with NULL connection_id in an account that has a connection (migration 045)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM message_templates t
    WHERE t.connection_id IS NULL
      AND EXISTS (SELECT 1 FROM whatsapp_config wc WHERE wc.account_id = t.account_id)
  ) OR EXISTS (
    SELECT 1 FROM broadcasts b
    WHERE b.connection_id IS NULL
      AND EXISTS (SELECT 1 FROM whatsapp_config wc WHERE wc.account_id = b.account_id)
  ) THEN
    RAISE EXCEPTION 'templates/broadcasts with NULL connection_id in an account that has a connection (migration 045)';
  END IF;

  -- 046: the broadcast RPC persists the sending connection and the old
  -- 8-argument overload is gone (it would make omitted-arg calls ambiguous).
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],uuid)'::regprocedure
     ) NOT LIKE '%connection_id%' THEN
    RAISE EXCEPTION 'create_broadcast_with_recipients does not store connection_id (migration 046)';
  END IF;
  IF (SELECT COUNT(*) FROM pg_proc WHERE proname = 'create_broadcast_with_recipients') <> 1 THEN
    RAISE EXCEPTION 'create_broadcast_with_recipients has more than one overload (migration 046)';
  END IF;

  -- 047: conversations.connection_id is NOT NULL and none is NULL; one
  -- conversation per (contact, connection); one active flow run per
  -- conversation; the old unique indexes are gone.
  IF (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'conversations'
      AND column_name = 'connection_id'
  ) <> 'NO' THEN
    RAISE EXCEPTION 'conversations.connection_id must be NOT NULL (migration 047)';
  END IF;
  IF EXISTS (SELECT 1 FROM conversations WHERE connection_id IS NULL) THEN
    RAISE EXCEPTION 'conversations with NULL connection_id (migration 047)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_conversations_contact_connection'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(contact_id, connection_id)%'
  ) THEN
    RAISE EXCEPTION 'idx_conversations_contact_connection (contact_id, connection_id) is missing (migration 047)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_conversations_connection_last_message'
      AND indexdef LIKE '%(connection_id, last_message_at DESC)%'
  ) THEN
    RAISE EXCEPTION 'conversations (connection_id, last_message_at DESC) index is missing (migration 047)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_one_active_run_per_conversation'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(conversation_id)%'
      AND indexdef LIKE '%status%active%'
  ) THEN
    RAISE EXCEPTION 'idx_one_active_run_per_conversation is missing (migration 047)';
  END IF;
  IF to_regclass('public.idx_conversations_account_contact') IS NOT NULL
     OR to_regclass('public.idx_one_active_run_per_contact') IS NOT NULL THEN
    RAISE EXCEPTION 'the old unique indexes must be gone (migration 047)';
  END IF;

  -- 048: filter_contacts_by_tags searches contact_identities.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = 'public.filter_contacts_by_tags(uuid[], text, integer, integer)'::regprocedure
      AND pg_get_functiondef(oid) LIKE '%contact_identities%'
  ) THEN
    RAISE EXCEPTION 'filter_contacts_by_tags must search contact_identities (migration 048)';
  END IF;

  RAISE NOTICE 'schema verification passed';
END
$$;

-- Two things this file has already been burned by, both verified in CI
-- rather than assumed:
--
-- 1. It must contain EXACTLY ONE statement. `supabase db query --file`
--    sends the whole file as a prepared statement, and a second
--    top-level statement fails with the distinctly unhelpful "cannot
--    insert multiple commands into a prepared statement" (commit
--    f91a6c8). Add assertions INSIDE the DO block above; do not append
--    a second one.
--
-- 2. A RAISE in here really does fail the job. A deliberately false
--    assertion (commit 42c7db0, run 31579334056) surfaced as
--    `failed to execute query: error: ...` and exited 1. This is not a
--    decorative green tick.

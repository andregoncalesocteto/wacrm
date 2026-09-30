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


  -- 041 repairs create_broadcast_with_recipients, which 037/038 shipped
  -- with an ambiguous bare `RETURNING id, contact_id` (SQLSTATE 42702 on
  -- first call — plpgsql resolves names at execution, not CREATE, so a
  -- plain replay can't catch it). Assert the qualified form is what's
  -- actually installed.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],uuid,text,text,jsonb)'::regprocedure
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
    WHERE table_schema = 'public' AND is_nullable = 'YES'
      AND table_name = 'quick_replies' AND column_name = 'store_id'
  ) <> 1 THEN
    RAISE EXCEPTION 'quick_replies.store_id must stay nullable — migration 044 did not apply';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.notifications'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%connection_down%'
  ) THEN
    RAISE EXCEPTION 'notifications.type must accept connection_down (migration 044)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'notifications' AND column_name = 'connection_id'
  ) THEN
    RAISE EXCEPTION 'notifications.connection_id is missing (migration 050)';
  END IF;

  -- Backfill (045) fed conversations/templates/broadcasts from whatsapp_config;
  -- 051 drops that table and makes the connection_id columns NOT NULL, so
  -- their final state is asserted there instead of re-derived from a table
  -- that no longer exists.

  -- 046: the broadcast RPC persists the sending connection and the old
  -- 8-argument overload is gone (it would make omitted-arg calls ambiguous).
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],uuid,text,text,jsonb)'::regprocedure
     ) NOT LIKE '%connection_id%' THEN
    RAISE EXCEPTION 'create_broadcast_with_recipients does not store connection_id (migration 046)';
  END IF;
  IF (SELECT COUNT(*) FROM pg_proc WHERE proname = 'create_broadcast_with_recipients') <> 1 THEN
    RAISE EXCEPTION 'create_broadcast_with_recipients has more than one overload (migration 046)';
  END IF;

  -- 054: the RPC gains p_message_text/p_message_media_url/p_template_variables
  -- so createBroadcast (US-004) can persist a free-message broadcast atomically.
  IF pg_get_functiondef(
       'public.create_broadcast_with_recipients(uuid,uuid,text,text,text,integer,uuid[],jsonb[],uuid,text,text,jsonb)'::regprocedure
     ) NOT LIKE '%message_media_url%' THEN
    RAISE EXCEPTION 'create_broadcast_with_recipients does not store message_text/message_media_url (migration 054)';
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

  -- 049: merge_contacts must handle EVERY table that has a contact_id
  -- column (a table added later without updating the merge would lose or
  -- orphan rows). Lists the real schema, not a hand-kept list.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid = 'public.merge_contacts(uuid, uuid, uuid)'::regprocedure
  ) THEN
    RAISE EXCEPTION 'merge_contacts is missing (migration 049)';
  END IF;
  DECLARE
    v_missing TEXT;
  BEGIN
    SELECT string_agg(c.table_name, ', ') INTO v_missing
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'contact_id'
      AND t.table_type = 'BASE TABLE'
      AND pg_get_functiondef('public.merge_contacts(uuid, uuid, uuid)'::regprocedure)
          !~ ('UPDATE ' || c.table_name || '( \w+)? SET contact_id');
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'merge_contacts does not handle: % (migration 049)', v_missing;
    END IF;
  END;

  -- 051: final contract. The legacy table/columns are gone, and the
  -- three connection columns this migration finishes are NOT NULL with
  -- no leftover NULL rows.
  IF to_regclass('public.whatsapp_config') IS NOT NULL THEN
    RAISE EXCEPTION 'whatsapp_config must be gone (migration 051)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
      AND column_name IN ('wa_user_id', 'wa_parent_user_id', 'wa_username')
  ) THEN
    RAISE EXCEPTION 'contacts.wa_user_id/wa_parent_user_id/wa_username must be gone (migration 051)';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND is_nullable = 'YES' AND (
      (table_name = 'message_templates' AND column_name = 'connection_id')
      OR (table_name = 'broadcasts' AND column_name = 'connection_id')
      OR (table_name = 'automation_pending_executions' AND column_name IN ('conversation_id', 'connection_id'))
    )
  ) <> 0 THEN
    RAISE EXCEPTION 'message_templates/broadcasts/automation_pending_executions connection columns must be NOT NULL (migration 051)';
  END IF;
  IF EXISTS (SELECT 1 FROM message_templates WHERE connection_id IS NULL)
     OR EXISTS (SELECT 1 FROM broadcasts WHERE connection_id IS NULL)
     OR EXISTS (SELECT 1 FROM automation_pending_executions WHERE conversation_id IS NULL OR connection_id IS NULL)
  THEN
    RAISE EXCEPTION 'NULL connection rows left after migration 051';
  END IF;
  IF to_regclass('public.message_templates_user_name_language_key') IS NOT NULL THEN
    RAISE EXCEPTION 'the old message_templates (user_id, name, language) index must be gone (migration 051)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'message_templates_connection_name_language_key'
      AND indexdef LIKE 'CREATE UNIQUE INDEX%(connection_id, name, language)%'
  ) THEN
    RAISE EXCEPTION 'message_templates (connection_id, name, language) unique index is missing (migration 051)';
  END IF;

  -- 052: broadcasts can carry a template OR a free message. template_name/
  -- template_language become nullable, message_text/message_media_url are
  -- new nullable columns, and a CHECK enforces exclusivity.
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'broadcasts'
      AND column_name IN ('template_name', 'template_language')
      AND is_nullable = 'YES'
  ) <> 2 THEN
    RAISE EXCEPTION 'broadcasts.template_name/template_language must be nullable (migration 052)';
  END IF;
  IF (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'broadcasts'
      AND column_name IN ('message_text', 'message_media_url')
  ) <> 2 THEN
    RAISE EXCEPTION 'broadcasts.message_text/message_media_url are missing (migration 052)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.broadcasts'::regclass AND contype = 'c'
      AND conname = 'broadcasts_content_exclusive_check'
  ) THEN
    RAISE EXCEPTION 'broadcasts_content_exclusive_check is missing (migration 052)';
  END IF;

  -- 053: broadcast_recipients.whatsapp_message_id renamed (expand-only) to
  -- external_message_id, with a matching unique correlation index.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'broadcast_recipients'
      AND column_name = 'external_message_id'
  ) THEN
    RAISE EXCEPTION 'broadcast_recipients.external_message_id is missing (migration 053)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'broadcast_recipients'
      AND indexname = 'idx_broadcast_recipients_external_message_id'
  ) THEN
    RAISE EXCEPTION 'idx_broadcast_recipients_external_message_id is missing (migration 053)';
  END IF;

  -- 055: stores.menu_url (Digital menu address, nullable, https-only CHECK).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stores'
      AND column_name = 'menu_url'
  ) THEN
    RAISE EXCEPTION 'stores.menu_url is missing (migration 055)';
  END IF;

  -- 056: order journeys (journeys, tracking_tokens, deals.connection_id/journey_id).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'journeys'
      AND column_name = 'link_sent_at'
  ) THEN
    RAISE EXCEPTION 'journeys.link_sent_at is missing (migration 056)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tracking_tokens'
      AND column_name = 'token'
  ) THEN
    RAISE EXCEPTION 'tracking_tokens.token is missing (migration 056)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'deals'
      AND column_name = 'connection_id'
  ) THEN
    RAISE EXCEPTION 'deals.connection_id is missing (migration 056)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'deals'
      AND indexname = 'uq_deals_open_journey'
  ) THEN
    RAISE EXCEPTION 'uq_deals_open_journey is missing (migration 056)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'journey_events_event_key'
  ) THEN
    RAISE EXCEPTION 'journey_events unique (account_id, event_id) is missing (migration 057)';
  END IF;

  -- 058: orders (Purchase) + contacts.last_purchase_at.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_external_key'
  ) THEN
    RAISE EXCEPTION 'orders unique (account_id, external_order_id) is missing (migration 058)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'contacts'
      AND column_name = 'last_purchase_at'
  ) THEN
    RAISE EXCEPTION 'contacts.last_purchase_at is missing (migration 058)';
  END IF;

  -- 059: orders.status_history (OrderStatusChanged).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
      AND column_name = 'status_history'
  ) THEN
    RAISE EXCEPTION 'orders.status_history is missing (migration 059)';
  END IF;

  -- 061: automations.preset_key + unique (account_id, preset_key).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'automations'
      AND column_name = 'preset_key'
  ) THEN
    RAISE EXCEPTION 'automations.preset_key is missing (migration 061)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'automations_account_preset_key'
  ) THEN
    RAISE EXCEPTION 'automations_account_preset_key index is missing (migration 061)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders'
      AND column_name = 'origin_event_id'
  ) THEN
    RAISE EXCEPTION 'orders.origin_event_id is missing (migration 062)';
  END IF;

  -- 063: store key fields (generated normalized key, unique index), notice connection.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stores'
      AND column_name = 'store_key_normalized'
  ) THEN
    RAISE EXCEPTION 'stores.store_key_normalized is missing (migration 063)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stores'
      AND column_name = 'notification_connection_id'
  ) THEN
    RAISE EXCEPTION 'stores.notification_connection_id is missing (migration 063)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'stores_account_store_key_uniq'
  ) THEN
    RAISE EXCEPTION 'stores_account_store_key_uniq index is missing (migration 063)';
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

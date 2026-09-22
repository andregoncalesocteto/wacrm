-- ============================================================
-- 044_channel_columns_nullable
--
-- Channel abstraction, "expand" phase (design.md section 4). Adds the
-- new columns next to the old model, all NULLABLE: nothing reads or
-- writes them yet, no existing unique index changes. The backfill and
-- the NOT NULL / unique-index swap belong to later stories.
--
--   conversations.connection_id                  RESTRICT (a connection with
--                                                history cannot vanish)
--   message_templates.connection_id              RESTRICT
--   broadcasts.connection_id                     RESTRICT
--   automation_pending_executions.conversation_id CASCADE (a parked run is
--                                                meaningless without its chat)
--   automation_pending_executions.connection_id  SET NULL (transient row,
--                                                derivable from conversation_id)
--   quick_replies.store_id                       RESTRICT (NULL = network-wide;
--                                                a store with content is not
--                                                deleted silently)
--
-- notifications.type also accepts 'connection_down'.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES channel_connections(id) ON DELETE RESTRICT;
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES channel_connections(id) ON DELETE RESTRICT;
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES channel_connections(id) ON DELETE RESTRICT;
ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;
ALTER TABLE automation_pending_executions
  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES channel_connections(id) ON DELETE SET NULL;
ALTER TABLE quick_replies
  ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id) ON DELETE RESTRICT;

-- Supporting indexes for the new FKs (non-unique).
CREATE INDEX IF NOT EXISTS idx_conversations_connection_last_message
  ON conversations(connection_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_templates_connection ON message_templates(connection_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_connection ON broadcasts(connection_id);
CREATE INDEX IF NOT EXISTS idx_pending_executions_conversation
  ON automation_pending_executions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_pending_executions_connection
  ON automation_pending_executions(connection_id);
CREATE INDEX IF NOT EXISTS idx_quick_replies_store ON quick_replies(store_id);

-- notifications.type: recreate the CHECK (auto-named notifications_type_check).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'connection_down'));

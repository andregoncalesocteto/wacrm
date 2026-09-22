-- ============================================================
-- notifications.connection_id — link a `connection_down` notification
-- (US-067) to the connection that went down. Rows are removed with the
-- connection.
-- ============================================================

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES channel_connections(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_connection
  ON notifications(connection_id)
  WHERE connection_id IS NOT NULL;

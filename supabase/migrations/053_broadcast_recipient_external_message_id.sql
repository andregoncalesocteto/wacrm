-- ============================================================
-- 053_broadcast_recipient_external_message_id
--
-- broadcast-multi-channel, US-002. `broadcast_recipients.whatsapp_message_id`
-- (migration 003) hardcodes WhatsApp in a column read/written by any channel
-- once broadcasts stop assuming WhatsApp (US-004/US-005) — same rename
-- already applied to `/api/v1/messages` in channel-abstraction.
--
-- Expand only: whatsapp_message_id is NOT dropped here (a future
-- story/PRD's job); this migration adds external_message_id, backfills it
-- from whatsapp_message_id, and replicates the unique correlation index.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS external_message_id TEXT;

UPDATE broadcast_recipients
  SET external_message_id = whatsapp_message_id
  WHERE external_message_id IS NULL
    AND whatsapp_message_id IS NOT NULL;

-- UNIQUE so webhook retries can't create duplicate correlations (same
-- guarantee as idx_broadcast_recipients_wamid, migration 003).
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcast_recipients_external_message_id
  ON broadcast_recipients (external_message_id)
  WHERE external_message_id IS NOT NULL;

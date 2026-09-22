-- ============================================================
-- 052_broadcast_content_columns
--
-- broadcast-multi-channel, US-001 (ADR-002). `broadcasts.template_name`/
-- `template_language` are NOT NULL today, which assumes every broadcast
-- is a WhatsApp-approved template. Channels whose `capabilities.initiate`
-- isn't 'template' (Telegram) send a free message instead: text plus
-- optional media. This migration only adds the schema; nothing reads or
-- writes the new columns yet (US-004/US-005).
--
--   broadcasts.template_name / template_language  become nullable
--   broadcasts.message_text                        new, nullable TEXT
--   broadcasts.message_media_url                   new, nullable TEXT
--   CHECK: exactly one of (template_name) / (message_text OR
--     message_media_url) is present — never both, never neither.
--     `template_variables` (already existing, jsonb) stays the single
--     variable-mapping column for both cases.
-- ============================================================

ALTER TABLE broadcasts
  ALTER COLUMN template_name DROP NOT NULL;
ALTER TABLE broadcasts
  ALTER COLUMN template_language DROP NOT NULL;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS message_text TEXT;
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS message_media_url TEXT;

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_content_exclusive_check;
ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_content_exclusive_check
  CHECK (
    (template_name IS NOT NULL)
    <> (message_text IS NOT NULL OR message_media_url IS NOT NULL)
  );

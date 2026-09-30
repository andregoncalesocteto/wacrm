-- 066: a parked run (wait step) may have no conversation yet.
--
-- The abandoned-cart chain of a DIRECT Journey (no CRM link, customer who never
-- wrote) waits 10 minutes before any conversation exists: the conversation is
-- created, closed, only when the message is sent. `conversation_id` and
-- `connection_id` (NOT NULL since 051) become nullable; the run's context
-- carries the store and the Journey, and the resume rebuilds from them.
-- `merge_contacts` already re-points rows by conversation_id / contact_id, which
-- NULL rows simply do not match.

ALTER TABLE automation_pending_executions ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE automation_pending_executions ALTER COLUMN connection_id DROP NOT NULL;

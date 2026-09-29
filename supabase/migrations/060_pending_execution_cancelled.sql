-- 060: allow automation_pending_executions.status = 'cancelled'.
--
-- A renewed menu link restarts the Resumption chain: the engine cancels the
-- parked runs of the previous link (same automation and contact) instead of
-- letting two chains fire. 'done' would misreport them as executed.

ALTER TABLE automation_pending_executions
  DROP CONSTRAINT IF EXISTS automation_pending_executions_status_check;

ALTER TABLE automation_pending_executions
  ADD CONSTRAINT automation_pending_executions_status_check
  CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled'));

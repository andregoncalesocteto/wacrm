-- 061: stable mark for automations created by a preset ("Jornada de pedido").
--
-- `preset_key` identifies WHICH preset automation a row is (for example
-- 'order_journey.resumption'), independent of its name, which the operator may
-- edit. The unique index makes installing a preset idempotent per account: a
-- second install (or a concurrent one) can never create the same automation
-- twice. Rows created by hand, from a template or by duplicating keep NULL.

ALTER TABLE automations
  ADD COLUMN IF NOT EXISTS preset_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS automations_account_preset_key
  ON automations (account_id, preset_key)
  WHERE preset_key IS NOT NULL;

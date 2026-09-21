-- ============================================================
-- 043_stores_and_connections
--
-- Channel abstraction, "expand" phase (design.md section 4). Adds the
-- new model next to the old one; nothing reads these tables yet and
-- whatsapp_config is untouched.
--
--   stores                          a physical store / branch of the account
--   channel_connections             one connected channel (WhatsApp number,
--                                   Telegram bot) belonging to a store
--   channel_connection_credentials  encrypted secrets, RLS ON and NO policy:
--                                   only the service role can read/write
--   contact_identities              per-channel identities of a contact
--                                   (phone, BSUID, username, telegram chat)
--
-- RLS: stores / channel_connections read = member, write = admin+;
-- contact_identities follows contacts (read = member, write = agent+).
-- ============================================================

CREATE TABLE IF NOT EXISTS stores (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  address        TEXT,
  phone          TEXT,
  business_hours JSONB,
  manager_name   TEXT,
  settings       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stores_account ON stores(account_id);

CREATE TABLE IF NOT EXISTS channel_connections (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id           UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id             UUID NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  channel_type         TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected', 'degraded', 'disconnected', 'needs_action')),
  config               JSONB NOT NULL DEFAULT '{}',
  last_inbound_at      TIMESTAMPTZ,
  last_outbound_at     TIMESTAMPTZ,
  last_error           JSONB,
  last_error_at        TIMESTAMPTZ,
  last_health_check_at TIMESTAMPTZ,
  connected_at         TIMESTAMPTZ,
  disabled_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT channel_connections_type_external_id_key UNIQUE (channel_type, external_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_connections_account ON channel_connections(account_id);
CREATE INDEX IF NOT EXISTS idx_channel_connections_store   ON channel_connections(store_id);

CREATE TABLE IF NOT EXISTS channel_connection_credentials (
  connection_id     UUID PRIMARY KEY REFERENCES channel_connections(id) ON DELETE CASCADE,
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  secrets_encrypted TEXT NOT NULL,
  secrets_format    TEXT NOT NULL DEFAULT 'json_v1',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_identities (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id  UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  external_id TEXT NOT NULL,
  handle      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_identities_account_kind_external_id_key UNIQUE (account_id, kind, external_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_identities_contact ON contact_identities(contact_id);

-- updated_at (function from migration 001)
DROP TRIGGER IF EXISTS set_updated_at ON stores;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON channel_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON channel_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON channel_connection_credentials;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON channel_connection_credentials
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stores_select ON stores;
CREATE POLICY stores_select ON stores FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS stores_insert ON stores;
CREATE POLICY stores_insert ON stores FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS stores_update ON stores;
CREATE POLICY stores_update ON stores FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS stores_delete ON stores;
CREATE POLICY stores_delete ON stores FOR DELETE
  USING (is_account_member(account_id, 'admin'));

ALTER TABLE channel_connections ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_connections_select ON channel_connections;
CREATE POLICY channel_connections_select ON channel_connections FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS channel_connections_insert ON channel_connections;
CREATE POLICY channel_connections_insert ON channel_connections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS channel_connections_update ON channel_connections;
CREATE POLICY channel_connections_update ON channel_connections FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS channel_connections_delete ON channel_connections;
CREATE POLICY channel_connections_delete ON channel_connections FOR DELETE
  USING (is_account_member(account_id, 'admin'));

ALTER TABLE contact_identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_identities_select ON contact_identities;
CREATE POLICY contact_identities_select ON contact_identities FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS contact_identities_insert ON contact_identities;
CREATE POLICY contact_identities_insert ON contact_identities FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_identities_update ON contact_identities;
CREATE POLICY contact_identities_update ON contact_identities FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS contact_identities_delete ON contact_identities;
CREATE POLICY contact_identities_delete ON contact_identities FOR DELETE
  USING (is_account_member(account_id, 'agent'));

-- Secrets: RLS ON and deliberately NO policy. Only the service role
-- (which bypasses RLS) may touch this table. Do not add one.
ALTER TABLE channel_connection_credentials ENABLE ROW LEVEL SECURITY;

-- Realtime: the inbox banner listens to connection status changes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'channel_connections'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE channel_connections;
  END IF;
END $$;

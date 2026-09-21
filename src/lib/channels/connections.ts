import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from './admin-client';

/**
 * Single place to read channel connections and their credentials.
 *
 * SERVER-ONLY. Connection reads accept any Supabase client (RLS-bound user
 * client or service role) and never touch the credentials table. Credentials
 * are read ONLY through the service-role client owned by this module:
 * `getConnectionCredentials` takes no client parameter, so a user-scoped
 * client can never be used to obtain (or be handed) secrets. The credentials
 * table has RLS on and no policy, so a user client could not read it anyway.
 * Never log the returned credentials.
 */

export type ChannelConnectionStatus =
  'connected' | 'degraded' | 'disconnected' | 'needs_action';

export interface ChannelConnection {
  id: string;
  account_id: string;
  store_id: string;
  channel_type: string;
  display_name: string;
  external_id: string;
  status: ChannelConnectionStatus;
  config: Record<string, unknown>;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_error: unknown;
  last_error_at: string | null;
  last_health_check_at: string | null;
  connected_at: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Decrypted credentials in the `json_v1` shape (`wa_token_v0` is mapped to it). */
export type ConnectionCredentials = { [key: string]: unknown } & {
  access_token?: string;
};

const CONNECTION_COLUMNS = '*';

export async function getConnectionById(
  id: string,
  client: SupabaseClient = supabaseAdmin()
): Promise<ChannelConnection | null> {
  const { data, error } = await client
    .from('channel_connections')
    .select(CONNECTION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getConnectionById failed: ${error.message}`);
  return (data as ChannelConnection | null) ?? null;
}

export async function getConnectionByExternalId(
  channelType: string,
  externalId: string,
  client: SupabaseClient = supabaseAdmin()
): Promise<ChannelConnection | null> {
  const { data, error } = await client
    .from('channel_connections')
    .select(CONNECTION_COLUMNS)
    .eq('channel_type', channelType)
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) {
    throw new Error(`getConnectionByExternalId failed: ${error.message}`);
  }
  return (data as ChannelConnection | null) ?? null;
}

export async function listConnectionsByAccount(
  accountId: string,
  client: SupabaseClient = supabaseAdmin()
): Promise<ChannelConnection[]> {
  const { data, error } = await client
    .from('channel_connections')
    .select(CONNECTION_COLUMNS)
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (error)
    throw new Error(`listConnectionsByAccount failed: ${error.message}`);
  return (data as ChannelConnection[] | null) ?? [];
}

export async function listConnectionsByStore(
  storeId: string,
  client: SupabaseClient = supabaseAdmin()
): Promise<ChannelConnection[]> {
  const { data, error } = await client
    .from('channel_connections')
    .select(CONNECTION_COLUMNS)
    .eq('store_id', storeId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`listConnectionsByStore failed: ${error.message}`);
  return (data as ChannelConnection[] | null) ?? [];
}

/**
 * Decrypted credentials of a connection, or null when it has none.
 *
 * Formats (`secrets_format`):
 *   - `wa_token_v0`: `secrets_encrypted` is ONE ciphertext holding the
 *     WhatsApp access token (verify_token lives in connection.config).
 *     Returned as `{ access_token }`.
 *   - `json_v1`: `secrets_encrypted` is a JSON object encrypted with encrypt().
 *
 * A `wa_token_v0` row (or any legacy CBC ciphertext) is rewritten as GCM
 * `json_v1` on first read, best-effort: a failed update never throws, the
 * next read simply retries (same idea as the CBC -> GCM upgrade in
 * src/app/api/whatsapp/send/route.ts).
 */
export async function getConnectionCredentials(
  connectionId: string
): Promise<ConnectionCredentials | null> {
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('channel_connection_credentials')
    .select('secrets_encrypted, secrets_format')
    .eq('connection_id', connectionId)
    .maybeSingle();
  if (error)
    throw new Error(`getConnectionCredentials failed: ${error.message}`);
  if (!data) return null;

  const row = data as { secrets_encrypted: string; secrets_format: string };
  const plaintext = decrypt(row.secrets_encrypted);

  let credentials: ConnectionCredentials;
  if (row.secrets_format === 'wa_token_v0') {
    credentials = { access_token: plaintext };
  } else if (row.secrets_format === 'json_v1') {
    credentials = JSON.parse(plaintext) as ConnectionCredentials;
  } else {
    throw new Error(`Unknown secrets_format "${row.secrets_format}"`);
  }

  if (
    row.secrets_format === 'wa_token_v0' ||
    isLegacyFormat(row.secrets_encrypted)
  ) {
    try {
      await admin
        .from('channel_connection_credentials')
        .update({
          secrets_encrypted: encrypt(JSON.stringify(credentials)),
          secrets_format: 'json_v1',
          updated_at: new Date().toISOString(),
        })
        .eq('connection_id', connectionId)
        .eq('secrets_format', row.secrets_format);
    } catch {
      // Best-effort upgrade; never fail the read.
    }
  }

  return credentials;
}

/**
 * Writes (creates or REPLACES) the credentials of a connection as `json_v1`:
 * the JSON object encrypted with encrypt(). Service role only, same as the
 * read side; callers must already have authorised the write (account + role).
 * Never log `credentials`.
 */
export async function saveConnectionCredentials(
  connectionId: string,
  accountId: string,
  credentials: Record<string, unknown>
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('channel_connection_credentials')
    .upsert(
      {
        connection_id: connectionId,
        account_id: accountId,
        secrets_encrypted: encrypt(JSON.stringify(credentials)),
        secrets_format: 'json_v1',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'connection_id' }
    );
  if (error)
    throw new Error(`saveConnectionCredentials failed: ${error.message}`);
}

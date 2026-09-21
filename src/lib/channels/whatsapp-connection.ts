import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getConnectionById,
  getConnectionCredentials,
  listConnectionsByAccount,
  type ChannelConnection,
} from './connections';

/**
 * "Which WhatsApp connection sends for this conversation/account?" (US-014)
 *
 * Replaces the per-caller reads of the legacy config table on the send side.
 * The rule is the same everywhere:
 *   1. the conversation's `connection_id`, when set and it is a
 *      `whatsapp_cloud` connection of this account;
 *   2. otherwise the account's `whatsapp_cloud` connection (the enabled one
 *      first). Fallback needed because conversations created by pre-connection
 *      code (or after migration 045) still have a NULL `connection_id`.
 *
 * An existing conversation ALWAYS sends through ITS connection (US-078): when
 * that connection is disabled it is still the one returned here (never a
 * silent fallback to another connection of the account) and the caller must
 * refuse the send (`disabled_at` set -> `ConnectionDisabledError`). Only a
 * conversation WITHOUT a connection uses the account fallback, which prefers
 * an enabled connection.
 *
 * Connection `status` is deliberately NOT consulted: the legacy config path
 * never looked at it, so a "disconnected" connection sends exactly like the
 * old row did.
 *
 * SERVER-ONLY. `db` is only used for connection/conversation reads (RLS-bound
 * or service role); credentials always come from `getConnectionCredentials`.
 */

const WHATSAPP_CHANNEL = 'whatsapp_cloud';

export interface WhatsAppSendConnection {
  connection: ChannelConnection;
  /** WhatsApp phone_number_id (= connection.external_id). */
  phoneNumberId: string;
  /** Decrypted Meta access token. Never log it. */
  accessToken: string;
}

type ResolveOpts = { connectionId?: string | null; conversationId?: string };

/** The account's WhatsApp connection (enabled first), or null. */
export async function findAccountWhatsAppConnection(
  db: SupabaseClient,
  accountId: string
): Promise<ChannelConnection | null> {
  const rows = (await listConnectionsByAccount(accountId, db)).filter(
    (c) => c.channel_type === WHATSAPP_CHANNEL
  );
  return rows.find((c) => c.disabled_at == null) ?? rows[0] ?? null;
}

/**
 * Strict ownership check for a caller-supplied connection id: it must exist,
 * belong to `accountId` and be a `whatsapp_cloud` connection. Unlike
 * `resolveWhatsAppConnection` it never falls back to the default connection.
 */
export async function isAccountWhatsAppConnection(
  db: SupabaseClient,
  accountId: string,
  connectionId: string
): Promise<boolean> {
  const conn = await getConnectionById(connectionId, db);
  return (
    !!conn &&
    conn.account_id === accountId &&
    conn.channel_type === WHATSAPP_CHANNEL
  );
}

async function conversationConnectionId(
  db: SupabaseClient,
  accountId: string,
  conversationId: string
): Promise<string | null> {
  const { data } = await db
    .from('conversations')
    .select('connection_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  return (
    (data as { connection_id?: string | null } | null)?.connection_id ?? null
  );
}

/**
 * Resolve the WhatsApp connection for a send. Pass `connectionId` when the
 * conversation row is already loaded, or `conversationId` to have it read.
 */
export async function resolveWhatsAppConnection(
  db: SupabaseClient,
  accountId: string,
  opts: ResolveOpts = {}
): Promise<ChannelConnection | null> {
  let connectionId = opts.connectionId ?? null;
  if (!connectionId && opts.conversationId) {
    connectionId = await conversationConnectionId(
      db,
      accountId,
      opts.conversationId
    );
  }
  if (connectionId) {
    const conn = await getConnectionById(connectionId, db);
    if (
      conn &&
      conn.account_id === accountId &&
      conn.channel_type === WHATSAPP_CHANNEL
    ) {
      return conn;
    }
  }
  return findAccountWhatsAppConnection(db, accountId);
}

/**
 * Connection + decrypted access token + phone_number_id, or null when the
 * account has no WhatsApp connection or the connection has no usable token
 * (callers keep raising their own "not configured" error).
 */
export async function loadWhatsAppSendConnection(
  db: SupabaseClient,
  accountId: string,
  opts: ResolveOpts = {}
): Promise<WhatsAppSendConnection | null> {
  const connection = await resolveWhatsAppConnection(db, accountId, opts);
  if (!connection) return null;
  const credentials = await getConnectionCredentials(connection.id);
  const accessToken = credentials?.access_token;
  if (!accessToken) return null;
  return { connection, phoneNumberId: connection.external_id, accessToken };
}

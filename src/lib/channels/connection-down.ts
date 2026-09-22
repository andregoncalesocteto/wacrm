import { channelLog, connCtx } from './log';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from './admin-client';
import type { ChannelConnection } from './connections';

/**
 * `connection_down` notification (US-067). Fires once per TRANSITION into
 * `disconnected` or `needs_action`, for every owner/admin of the account:
 * a write that keeps the connection in the state it already had (a repeated
 * health failure, another auth error) creates nothing. SERVER-ONLY: notification
 * rows have no client INSERT policy, so this uses the service role.
 */

const DOWN_STATES = new Set(['disconnected', 'needs_action']);
const ADMIN_ROLES = ['owner', 'admin'];

type ConnectionRef = Pick<
  ChannelConnection,
  'id' | 'account_id' | 'status' | 'display_name'
>;

/** True when `next` is a down state the connection was not already in. */
export function isConnectionDownTransition(
  previous: string | undefined,
  next: unknown
): boolean {
  return typeof next === 'string' && DOWN_STATES.has(next) && previous !== next;
}

/** Best-effort: never throws, never blocks the send/health path. */
export async function notifyConnectionDown(
  conn: ConnectionRef,
  db?: SupabaseClient
): Promise<void> {
  try {
    const admin = db ?? supabaseAdmin();
    const { data: admins, error } = await admin
      .from('profiles')
      .select('user_id')
      .eq('account_id', conn.account_id)
      .in('account_role', ADMIN_ROLES);
    if (error) throw new Error(error.message);
    const rows = ((admins ?? []) as { user_id: string }[]).map((a) => ({
      account_id: conn.account_id,
      user_id: a.user_id,
      type: 'connection_down',
      connection_id: conn.id,
      // Fallback text; the notifications page renders a translated version.
      title: 'Connection down',
      body: conn.display_name,
    }));
    if (rows.length === 0) return;
    const { error: insErr } = await admin.from('notifications').insert(rows);
    if (insErr) throw new Error(insErr.message);
  } catch (err) {
    channelLog('error', connCtx(conn), 'connection-down notify failed', {
      error: err,
    });
  }
}

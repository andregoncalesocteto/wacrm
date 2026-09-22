import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelConnection } from './connections';
import type { ChannelErrorCode } from './types';

/**
 * Connection state driven by events (US-065). Pure transition functions
 * (`*Patch`) decide what to write; `recordConnectionEvent` applies a patch
 * best-effort. The periodic health check (US-066) reuses the same columns.
 *
 *   - inbound message      -> `last_inbound_at`; leaves `needs_action`
 *   - successful send      -> `last_outbound_at`; leaves `needs_action`
 *   - send error `auth`    -> `needs_action` + `last_error`
 *   - ingestion failure    -> `last_error` (status untouched)
 *
 * "Leaving needs_action" sets `connected` and clears `last_error`: the
 * connection just proved it works. Other states (degraded, disconnected) are
 * owned by connect/disconnect/health and are not touched by traffic.
 * SERVER-ONLY.
 */

export type ConnectionPatch = Record<string, unknown>;

type StateView = Pick<ChannelConnection, 'status'>;

const recovered = (conn: StateView): ConnectionPatch =>
  conn.status === 'needs_action'
    ? { status: 'connected', last_error: null, last_error_at: null }
    : {};

export function inboundPatch(conn: StateView, now: Date): ConnectionPatch {
  return { last_inbound_at: now.toISOString(), ...recovered(conn) };
}

export function outboundSuccessPatch(
  conn: StateView,
  now: Date
): ConnectionPatch {
  return { last_outbound_at: now.toISOString(), ...recovered(conn) };
}

/** Only an `auth` failure changes the state; other send errors are per-message. */
export function sendErrorPatch(
  err: { code?: ChannelErrorCode | string; message?: string },
  now: Date
): ConnectionPatch | null {
  if (err.code !== 'auth') return null;
  return {
    status: 'needs_action',
    last_error: {
      code: 'auth',
      message: err.message ?? 'Authentication failed',
    },
    last_error_at: now.toISOString(),
  };
}

export function ingestFailurePatch(
  failure: { code: string; message: string },
  now: Date
): ConnectionPatch {
  return {
    last_error: { code: failure.code, message: failure.message },
    last_error_at: now.toISOString(),
  };
}

/** Best-effort write: a failed update is logged and never breaks the send/ingest. */
export async function recordConnectionEvent(
  db: SupabaseClient,
  connectionId: string,
  patch: ConnectionPatch | null
): Promise<void> {
  if (!patch || Object.keys(patch).length === 0) return;
  try {
    const { error } = await db
      .from('channel_connections')
      .update(patch)
      .eq('id', connectionId);
    if (error) {
      console.error('[connection-state] update failed:', error.message);
    }
  } catch (err) {
    console.error(
      '[connection-state] update threw:',
      err instanceof Error ? err.message : err
    );
  }
}

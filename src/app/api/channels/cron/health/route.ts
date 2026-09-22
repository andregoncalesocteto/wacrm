import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/channels/admin-client';
import type { ChannelConnection } from '@/lib/channels/connections';
import {
  healthPatch,
  recordConnectionEvent,
} from '@/lib/channels/connection-state';
import { registerBuiltinProviders } from '@/lib/channels/providers';
import { getProvider } from '@/lib/channels/registry';

/**
 * Periodic connection health check (US-066).
 *
 * Calls `provider.health` for every ACTIVE connection (disabled_at is null)
 * and stores the verdict in `status` + `last_health_check_at`. Optional: with
 * no scheduler pointed here, connection state is still driven by events
 * (US-065). Auth is the shared `AUTOMATION_CRON_SECRET` in `x-cron-secret`
 * (503 while unset), like /api/automations/cron and /api/flows/cron.
 * One failing connection never stops the sweep.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '');
  const expectedBuf = Buffer.from(expected);
  if (
    supplied.length !== expectedBuf.length ||
    !timingSafeEqual(supplied, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  registerBuiltinProviders();
  const db = supabaseAdmin();
  const { data, error } = await db
    .from('channel_connections')
    .select('*')
    .is('disabled_at', null);
  if (error) {
    console.error('[channels-health] scan failed:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const connections = (data as ChannelConnection[] | null) ?? [];
  let checked = 0;
  let failed = 0;
  for (const conn of connections) {
    try {
      const health = await getProvider(conn.channel_type).health(conn);
      await recordConnectionEvent(
        db,
        conn.id,
        healthPatch(conn, health, new Date())
      );
      checked += 1;
    } catch (err) {
      failed += 1;
      console.error(
        '[channels-health] check failed:',
        conn.id,
        err instanceof Error ? err.message : err
      );
    }
  }

  return NextResponse.json({ checked, failed });
}

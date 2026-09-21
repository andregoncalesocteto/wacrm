import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { providerFor } from '@/lib/channels/connection-input';
import {
  loadOwnedConnection,
  updateConnection,
} from '@/lib/channels/connection-lifecycle';

/**
 * POST /api/channels/connections/[id]/test — admin+. Live provider.health;
 * updates status, last_health_check_at and last_error, returns the Health.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Ctx) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;

    const conn = await loadOwnedConnection(supabase, accountId, id);
    if (!conn)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const provider = providerFor(conn.channel_type);
    if (!provider.ok) {
      return NextResponse.json(
        { error: provider.error, code: provider.code },
        { status: 400 }
      );
    }

    let health: Awaited<ReturnType<typeof provider.value.health>>;
    try {
      health = await provider.value.health(conn);
    } catch (err) {
      return NextResponse.json(
        {
          error: err instanceof Error ? err.message : 'Health check failed',
          code: 'health_failed',
        },
        { status: 502 }
      );
    }

    const checkedAt = health.checkedAt.toISOString();
    const ok = health.state === 'connected';
    const connection = await updateConnection(supabase, accountId, id, {
      status: health.state,
      last_health_check_at: checkedAt,
      last_error: ok
        ? null
        : { code: health.state, message: health.reason ?? health.state },
      last_error_at: ok ? null : checkedAt,
      ...(ok && !conn.connected_at && { connected_at: checkedAt }),
    });
    return NextResponse.json({
      health: {
        state: health.state,
        reason: health.reason ?? null,
        checked_at: checkedAt,
      },
      connection,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

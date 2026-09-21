import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  loadOwnedConnection,
  updateConnection,
} from '@/lib/channels/connection-lifecycle';

/**
 * POST /api/channels/connections/[id]/enable — admin+. Clears disabled_at.
 * The status stays `disconnected` until a connect/test succeeds.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Ctx) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;

    const conn = await loadOwnedConnection(supabase, accountId, id);
    if (!conn)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const connection = await updateConnection(supabase, accountId, id, {
      disabled_at: null,
      ...(conn.disabled_at && { status: 'disconnected' }),
    });
    return NextResponse.json({ connection });
  } catch (err) {
    return toErrorResponse(err);
  }
}

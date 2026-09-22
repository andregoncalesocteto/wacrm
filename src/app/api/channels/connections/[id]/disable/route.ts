import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { providerFor } from '@/lib/channels/connection-input';
import {
  loadOwnedConnection,
  updateConnection,
} from '@/lib/channels/connection-lifecycle';

/**
 * POST /api/channels/connections/[id]/disable — admin+. Idempotent (already
 * disabled = 200 with `already_disabled`). provider.disconnect is best-effort;
 * credentials are kept. `open_conversations` = conversations of this
 * connection that are not closed, so the UI can warn.
 */

type Ctx = { params: Promise<{ id: string }> };

async function countOpen(
  supabase: Awaited<ReturnType<typeof requireRole>>['supabase'],
  accountId: string,
  id: string
): Promise<number> {
  const { count, error } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('connection_id', id)
    .eq('account_id', accountId)
    .neq('status', 'closed');
  if (error) throw error;
  return count ?? 0;
}

export async function POST(_request: Request, context: Ctx) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;

    const conn = await loadOwnedConnection(supabase, accountId, id);
    if (!conn)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    if (conn.disabled_at) {
      const connection = await updateConnection(supabase, accountId, id, {});
      return NextResponse.json({
        connection,
        open_conversations: await countOpen(supabase, accountId, id),
        already_disabled: true,
      });
    }

    const provider = providerFor(conn.channel_type);
    if (provider.ok) {
      try {
        await provider.value.disconnect(conn);
      } catch (err) {
        console.warn(
          `[channels] disconnect failed for ${id}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    const connection = await updateConnection(supabase, accountId, id, {
      disabled_at: new Date().toISOString(),
      status: 'disconnected',
    });
    return NextResponse.json({
      connection,
      open_conversations: await countOpen(supabase, accountId, id),
      already_disabled: false,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

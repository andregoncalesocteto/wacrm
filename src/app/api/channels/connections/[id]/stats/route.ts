import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

/**
 * GET /api/channels/connections/[id]/stats — any member of the account.
 * Counts of the last 24 h for THIS connection, from `messages` joined through
 * `conversations.connection_id`: received (customer), sent (agent/bot, not
 * failed) and failed (agent/bot, status failed); plus how many conversations
 * the connection has (total and not closed), so the UI can state what a move
 * or a disable affects. Numbers only, never credentials or message content.
 */

type Ctx = { params: Promise<{ id: string }> };

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(_request: Request, context: Ctx) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { id } = await context.params;

    const { data: conn, error: findError } = await supabase
      .from('channel_connections')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (findError) throw findError;
    if (!conn)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const since = new Date(Date.now() - DAY_MS).toISOString();
    const inWindow = () =>
      supabase
        .from('messages')
        .select('id, conversations!inner(connection_id)', {
          count: 'exact',
          head: true,
        })
        .eq('conversations.connection_id', id)
        .gte('created_at', since);

    const [received, sent, failed, total, open] = await Promise.all([
      inWindow().eq('sender_type', 'customer'),
      inWindow().in('sender_type', ['agent', 'bot']).neq('status', 'failed'),
      inWindow().in('sender_type', ['agent', 'bot']).eq('status', 'failed'),
      supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('connection_id', id)
        .eq('account_id', accountId),
      supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('connection_id', id)
        .eq('account_id', accountId)
        .neq('status', 'closed'),
    ]);
    for (const r of [received, sent, failed, total, open]) {
      if (r.error) throw r.error;
    }

    return NextResponse.json({
      since,
      received: received.count ?? 0,
      sent: sent.count ?? 0,
      failed: failed.count ?? 0,
      conversations: total.count ?? 0,
      open_conversations: open.count ?? 0,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { parseStoreInput } from '@/lib/stores/validation';

/**
 * GET  /api/stores — stores of the caller's account (any member), each with a
 *                    summary of its connections (never credentials).
 * POST /api/stores — create a store (admin+).
 */

const CONNECTION_SUMMARY_COLUMNS =
  'id, store_id, channel_type, display_name, status, disabled_at';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const { data: stores, error } = await supabase
      .from('stores')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const { data: connections, error: connError } = await supabase
      .from('channel_connections')
      .select(CONNECTION_SUMMARY_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true });
    if (connError) throw connError;

    const byStore = new Map<string, Record<string, unknown>[]>();
    for (const c of (connections ?? []) as Array<{ store_id: string }>) {
      const { store_id, ...summary } = c as Record<string, unknown> & {
        store_id: string;
      };
      const list = byStore.get(store_id) ?? [];
      list.push(summary);
      byStore.set(store_id, list);
    }

    return NextResponse.json({
      stores: ((stores ?? []) as Array<{ id: string }>).map((s) => ({
        ...s,
        connections: byStore.get(s.id) ?? [],
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = parseStoreInput(body, false);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('stores')
      .insert({ ...parsed.value, account_id: accountId })
      .select('*')
      .single();
    if (error) throw error;

    return NextResponse.json(
      { store: { ...data, connections: [] } },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

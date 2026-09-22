import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { parseStoreInput } from '@/lib/stores/validation';

/**
 * PATCH  /api/stores/[id] — update a store (admin+).
 * DELETE /api/stores/[id] — delete a store (admin+). 409 `has_connections`
 *   when the store has ANY connection, active or disabled.
 *
 * Everything is scoped by the caller's account; a store of another account is
 * a 404.
 */

const HAS_CONNECTIONS = {
  error: 'Store still has channel connections',
  code: 'has_connections',
} as const;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = parseStoreInput(body, true);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    if (Object.keys(parsed.value).length === 0) {
      return NextResponse.json(
        { error: 'No fields to update' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('stores')
      .update(parsed.value)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return NextResponse.json({ store: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;

    const { data: store, error: findError } = await supabase
      .from('stores')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (findError) throw findError;
    if (!store)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const { data: conns, error: connError } = await supabase
      .from('channel_connections')
      .select('id')
      .eq('store_id', id)
      .eq('account_id', accountId)
      .limit(1);
    if (connError) throw connError;
    if (conns && conns.length > 0) {
      return NextResponse.json(HAS_CONNECTIONS, { status: 409 });
    }

    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) {
      // FK ON DELETE RESTRICT: a connection appeared after the check above.
      if (error.code === '23503') {
        return NextResponse.json(HAS_CONNECTIONS, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

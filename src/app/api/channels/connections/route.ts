import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  PUBLIC_COLUMNS,
  isObject,
  parseConfig,
  parseCredentials,
  parseDisplayName,
  providerFor,
  publicConnection,
  resolveExternalId,
} from '@/lib/channels/connection-input';
import { saveConnectionCredentials } from '@/lib/channels/connections';

/**
 * GET  /api/channels/connections — connections of the caller's account (any
 *                                 member), each with `has_conversations`. Never
 *                                 credentials or secret config.
 * POST /api/channels/connections — create one (admin+). Starts `disconnected`;
 *                                 connecting is a separate step.
 */

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('channel_connections')
      .select(PUBLIC_COLUMNS)
      .eq('account_id', accountId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as Array<Record<string, unknown>>;

    // One extra query for the whole account (not one per connection): which
    // of these connections already have conversations. The UI hides "delete"
    // for them; DELETE still enforces it (409), so this is only a hint.
    const withConversations = new Set<string>();
    if (rows.length > 0) {
      const { data: convs, error: convError } = await supabase
        .from('conversations')
        .select('connection_id')
        .eq('account_id', accountId)
        .in(
          'connection_id',
          rows.map((r) => r.id as string)
        );
      if (convError) throw convError;
      for (const c of (convs ?? []) as Array<{ connection_id: string }>) {
        withConversations.add(c.connection_id);
      }
    }

    return NextResponse.json({
      connections: rows.map((r) => ({
        ...publicConnection(r),
        has_conversations: withConversations.has(r.id as string),
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
    if (!isObject(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const bad = (f: { error: string; code?: string; details?: unknown }) =>
      NextResponse.json(
        { error: f.error, code: f.code, details: f.details },
        { status: 400 }
      );

    const provider = providerFor(body.channel_type);
    if (!provider.ok) return bad(provider);
    const name = parseDisplayName(body.display_name);
    if (!name.ok) return bad(name);
    if (typeof body.store_id !== 'string' || !body.store_id) {
      return bad({ error: 'store_id is required' });
    }
    const config = parseConfig(provider.value, body.config ?? {});
    if (!config.ok) return bad(config);
    const credentials = parseCredentials(provider.value, body.credentials);
    if (!credentials.ok) return bad(credentials);
    const externalId = resolveExternalId(body.external_id, config.value);
    if (!externalId.ok) return bad(externalId);

    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('id')
      .eq('id', body.store_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (storeError) throw storeError;
    if (!store) {
      return NextResponse.json({ error: 'Store not found' }, { status: 404 });
    }

    const { data, error } = await supabase
      .from('channel_connections')
      .insert({
        account_id: accountId,
        store_id: body.store_id,
        channel_type: provider.value.type,
        display_name: name.value,
        external_id: externalId.value,
        status: 'disconnected',
        config: config.value,
      })
      .select(PUBLIC_COLUMNS)
      .single();
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          {
            error: 'A connection with this external_id already exists',
            code: 'duplicate_connection',
          },
          { status: 409 }
        );
      }
      throw error;
    }
    const row = data as Record<string, unknown>;

    try {
      await saveConnectionCredentials(
        row.id as string,
        accountId,
        credentials.value
      );
    } catch (err) {
      // No connection without credentials: undo the row.
      await supabase
        .from('channel_connections')
        .delete()
        .eq('id', row.id as string)
        .eq('account_id', accountId);
      throw err;
    }

    return NextResponse.json(
      { connection: publicConnection(row) },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

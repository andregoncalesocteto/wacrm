import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  PUBLIC_COLUMNS,
  resolveExternalIdFor,
  isObject,
  parseConfig,
  parseCredentials,
  parseDisplayName,
  providerFor,
  publicConnection,
} from '@/lib/channels/connection-input';
import {
  getConnectionCredentials,
  saveConnectionCredentials,
} from '@/lib/channels/connections';

/**
 * PATCH  /api/channels/connections/[id] — rename, change config (merged into
 *   the stored one, then validated), merge credentials (given keys replace, the rest is kept), move to another
 *   store of the same account (admin+).
 * DELETE /api/channels/connections/[id] — admin+. 409 `has_conversations`
 *   when the connection has any conversation. Credentials cascade.
 *
 * Scoped by the caller's account; another account's connection is a 404.
 */

type Ctx = { params: Promise<{ id: string }> };

const HAS_CONVERSATIONS = {
  error: 'Connection still has conversations',
  code: 'has_conversations',
} as const;

const notFound = () =>
  NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function PATCH(request: Request, context: Ctx) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;

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

    const { data: existing, error: findError } = await supabase
      .from('channel_connections')
      .select('id, channel_type, external_id, config')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) return notFound();
    const current = existing as {
      channel_type: string;
      external_id: string | null;
      config: Record<string, unknown> | null;
    };

    const provider = providerFor(current.channel_type);
    if (!provider.ok) return bad(provider);

    const patch: Record<string, unknown> = {};
    if ('display_name' in body) {
      const name = parseDisplayName(body.display_name);
      if (!name.ok) return bad(name);
      patch.display_name = name.value;
    }
    if ('config' in body) {
      if (!isObject(body.config)) {
        return bad({
          error: 'config must be an object',
          code: 'invalid_config',
        });
      }
      const merged = parseConfig(provider.value, {
        ...(current.config ?? {}),
        ...body.config,
      });
      if (!merged.ok) return bad(merged);
      patch.config = merged.value;
    }
    let newCredentials: Record<string, unknown> | null = null;
    if ('credentials' in body) {
      const c = parseCredentials(provider.value, body.credentials);
      if (!c.ok) return bad(c);
      newCredentials = c.value;
      // A provider that can identify the account behind its credentials
      // (Telegram: bot id) must not have them swapped for another identity:
      // that would leave this connection's external_id and webhook stale.
      if (provider.value.deriveExternalId) {
        const stored = await getConnectionCredentials(id);
        const derived = await resolveExternalIdFor(
          provider.value,
          undefined,
          { ...(current.config ?? {}) },
          { ...(stored ?? {}), ...c.value }
        );
        if (!derived.ok) {
          return NextResponse.json(
            { error: derived.error, code: derived.code },
            { status: derived.status ?? 400 }
          );
        }
        if (derived.value !== current.external_id) {
          return NextResponse.json(
            {
              error:
                'These credentials belong to a different account; create a new connection instead',
              code: 'credentials_mismatch',
            },
            { status: 409 }
          );
        }
      }
    }
    if ('store_id' in body) {
      if (typeof body.store_id !== 'string' || !body.store_id) {
        return bad({ error: 'store_id must be a string' });
      }
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
      patch.store_id = body.store_id;
    }
    if (Object.keys(patch).length === 0 && !newCredentials) {
      return bad({ error: 'No fields to update' });
    }

    const { data, error } = await supabase
      .from('channel_connections')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
      .select(PUBLIC_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return notFound();

    if (newCredentials) {
      await saveConnectionCredentials(id, accountId, newCredentials, {
        merge: true,
      });
    }

    return NextResponse.json({
      connection: publicConnection(data as Record<string, unknown>),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, context: Ctx) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;

    const { data: existing, error: findError } = await supabase
      .from('channel_connections')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) return notFound();

    const { data: convs, error: convError } = await supabase
      .from('conversations')
      .select('id')
      .eq('connection_id', id)
      .eq('account_id', accountId)
      .limit(1);
    if (convError) throw convError;
    if (convs && convs.length > 0) {
      return NextResponse.json(HAS_CONVERSATIONS, { status: 409 });
    }

    const { error } = await supabase
      .from('channel_connections')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId);
    if (error) {
      // FK ON DELETE RESTRICT: a conversation appeared after the check above.
      if (error.code === '23503') {
        return NextResponse.json(HAS_CONVERSATIONS, { status: 409 });
      }
      throw error;
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

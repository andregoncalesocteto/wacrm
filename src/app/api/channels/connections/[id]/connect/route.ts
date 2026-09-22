import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isObject, providerFor } from '@/lib/channels/connection-input';
import {
  loadOwnedConnection,
  updateConnection,
} from '@/lib/channels/connection-lifecycle';
import type { ChannelErrorInfo } from '@/lib/channels/types';

/**
 * POST /api/channels/connections/[id]/connect — admin+. Runs provider.connect
 * (the provider reads the credentials itself). Body may carry provider
 * options ({ pin }); they are forwarded and NEVER stored or echoed.
 * Provider failure is a 200 with `ok: false` (same as the WhatsApp config
 * route), so the UI can show the remediation message.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Ctx) {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { id } = await context.params;

    let body: unknown = {};
    try {
      const text = await request.text();
      if (text.trim()) body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!isObject(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const conn = await loadOwnedConnection(supabase, accountId, id);
    if (!conn)
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (conn.disabled_at) {
      return NextResponse.json(
        { error: 'Connection is disabled', code: 'disabled' },
        { status: 409 }
      );
    }
    const provider = providerFor(conn.channel_type);
    if (!provider.ok) {
      return NextResponse.json(
        { error: provider.error, code: provider.code },
        { status: 400 }
      );
    }

    const pin = typeof body.pin === 'string' ? body.pin : undefined;
    const now = new Date().toISOString();

    let result: Awaited<ReturnType<typeof provider.value.connect>>;
    try {
      result = await provider.value.connect(conn, { pin });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connect failed';
      result = {
        ok: false,
        message,
        error: { code: 'unknown', message },
      };
    }

    if (result.ok) {
      const config: Record<string, unknown> = {
        ...conn.config,
        subscribed_apps_at: now,
        last_registration_error: null,
      };
      if (result.details?.registration === 'registered') {
        config.registered_at = now;
      }
      const connection = await updateConnection(supabase, accountId, id, {
        status: 'connected',
        connected_at: now,
        last_error: null,
        last_error_at: null,
        config,
      });
      return NextResponse.json({
        ok: true,
        message: result.message ?? null,
        details: result.details ?? null,
        connection,
      });
    }

    const message = result.message ?? result.error?.message ?? 'Connect failed';
    const error: ChannelErrorInfo = result.error ?? {
      code: 'unknown',
      message,
    };
    const needsAction = error.code === 'auth' || error.code === 'invalid';
    const connection = await updateConnection(supabase, accountId, id, {
      status: needsAction ? 'needs_action' : 'disconnected',
      last_error: { ...error, message },
      last_error_at: now,
      config: { ...conn.config, last_registration_error: message },
    });
    return NextResponse.json({ ok: false, message, error, connection });
  } catch (err) {
    return toErrorResponse(err);
  }
}

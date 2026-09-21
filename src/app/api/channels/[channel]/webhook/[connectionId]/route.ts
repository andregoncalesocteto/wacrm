import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/channels/admin-client';
import { ingestInbound } from '@/lib/channels/ingest';
import { conversationCreatedHook, fanoutHook } from '@/lib/channels/fanout';
import { createMediaResolver } from '@/lib/channels/media';
import { registerBuiltinProviders } from '@/lib/channels/providers';
import { getProvider, hasProvider } from '@/lib/channels/registry';

// Same headroom as the WhatsApp webhook: `after()` runs inside this budget
// and inbound processing can download media.
export const maxDuration = 60;

/**
 * Providers that deliver through the generic per-connection webhook
 * (`/api/channels/<channel>/webhook/<connectionId>`). WhatsApp keeps its own
 * app-level route (one Meta app, many numbers).
 */
const GENERIC_WEBHOOK_CHANNELS = new Set(['telegram']);

/**
 * Thin shell, like the WhatsApp route: the provider resolves the connection,
 * verifies the request and parses it; `ingestInbound` stores it after the ack.
 *
 * Order: unknown channel -> 404; unknown connection (or another channel's) ->
 * 404; failed verification -> 401 and NOTHING is processed; a DISABLED
 * connection -> 200 without processing (verified first, so an
 * unauthenticated caller learns nothing; 200 so the provider does not keep
 * retrying a connection the owner switched off). An update with nothing to
 * store (edited message, group chat, unknown type) is acked 200 as well.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ channel: string; connectionId: string }> }
) {
  const { channel } = await context.params;
  registerBuiltinProviders();
  if (!GENERIC_WEBHOOK_CHANNELS.has(channel) || !hasProvider(channel)) {
    return NextResponse.json({ error: 'Unknown channel' }, { status: 404 });
  }
  const provider = getProvider(channel);

  const connection = await provider.resolveConnection(request).catch(() => {
    console.error('[channel-webhook] could not resolve the connection');
    return null;
  });
  if (!connection) {
    return NextResponse.json({ error: 'Unknown connection' }, { status: 404 });
  }

  if (!(await provider.verify(request, connection))) {
    console.warn('[channel-webhook] rejected request with invalid secret');
    return NextResponse.json({ error: 'Invalid secret' }, { status: 401 });
  }

  if (connection.disabled_at) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  // Parse BEFORE the ack: it is pure CPU, and the request body stream is not
  // guaranteed to be readable once the response has been sent (the WhatsApp
  // route reads its raw body first for the same reason). Only the I/O
  // (owner lookup, storage, ingest, fan-out) runs in after().
  let events;
  try {
    events = await provider.parse(request, connection);
  } catch {
    console.error('[channel-webhook] could not parse the update');
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }
  if (events.length === 0) {
    return NextResponse.json({ status: 'ignored' }, { status: 200 });
  }

  after(async () => {
    try {
      const admin = supabaseAdmin();
      // Connections carry no user: rows are attributed to the account owner.
      const { data: ownerRow } = await admin
        .from('accounts')
        .select('owner_user_id')
        .eq('id', connection.account_id)
        .maybeSingle();
      const ownerUserId = ownerRow?.owner_user_id as string | undefined;
      if (!ownerUserId) {
        console.error(
          'Account owner could not be resolved for account:',
          connection.account_id
        );
        return;
      }

      await ingestInbound(admin, connection, events, {
        auditUserId: ownerUserId,
        hooks: {
          resolveMedia: createMediaResolver({
            provider,
            storage: admin.storage,
          }),
          onMessageStored: fanoutHook({ configOwnerUserId: ownerUserId }),
          onConversationCreated: conversationCreatedHook,
        },
      });
    } catch (error) {
      console.error(
        '[channel-webhook] error processing update:',
        error instanceof Error ? error.message : 'unknown'
      );
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

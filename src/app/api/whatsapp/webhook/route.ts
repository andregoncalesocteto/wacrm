import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { getConnectionCredentials } from '@/lib/channels/connections';
import { ingestInbound } from '@/lib/channels/ingest';
import { conversationCreatedHook, fanoutHook } from '@/lib/channels/fanout';
import { createMediaResolver } from '@/lib/channels/media';
import { whatsappCloudProvider } from '@/lib/channels/providers/whatsapp-cloud';
import { readRawBody } from '@/lib/channels/providers/whatsapp-cloud/inbound';
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook';

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media downloads, so give it
// headroom beyond the platform default (Vercel clamps this to the plan's
// ceiling). Tune as needed.
export const maxDuration = 60;

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

interface TemplateChange {
  field: string;
  value?: unknown;
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      );
    }

    // Fetch all WhatsApp connections to check verify tokens. The token
    // lives (encrypted, same format as the legacy config column)
    // in channel_connections.config.verify_token.
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('channel_connections')
      .select('id, config, disabled_at')
      .eq('channel_type', 'whatsapp_cloud');

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError);
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      );
    }

    // Check if any connection's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const conn of configs as any[]) {
      // A disabled connection is a removed config: it no longer verifies.
      if (conn.disabled_at) continue;
      const stored = conn.config?.verify_token;
      if (!stored || typeof stored !== 'string') continue;
      try {
        if (decrypt(stored) === verifyToken) {
          matchedConfig = { ...conn, verify_token: stored };
          break;
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('channel_connections')
          .update({
            config: {
              ...matchedConfig.config,
              verify_token: encrypt(verifyToken),
            },
          })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error
              );
            }
          });
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    );
  } catch (error) {
    console.error('Error in webhook GET verification:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST - Receive messages. A thin shell: the provider resolves the
// connection, verifies the signature and parses the payload; the channel
// core (`ingestInbound`) stores it. Nothing WhatsApp-specific lives here
// besides the template-lifecycle fields.
export async function POST(request: Request) {
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed (cached per request, shared with the provider). request.json()
  // would re-encode and break the signature.
  const rawBody = await readRawBody(request);

  // Null when the payload names no known phone_number_id (e.g. template
  // events). Signature verification is app-level and never needs it.
  const connection = await whatsappCloudProvider
    .resolveConnection(request)
    .catch((error) => {
      console.error('Error fetching connection for webhook:', error);
      return null;
    });

  if (!(await whatsappCloudProvider.verify(request, connection!))) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: { entry?: { id?: string; changes?: TemplateChange[] }[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached promise: on serverless
  // platforms (we run on Vercel) the function can be frozen or terminated
  // the moment the response is sent, so a floating promise's DB writes are
  // not guaranteed to finish. That dropped a non-deterministic *subset* of
  // inbound messages (see issue #301). `after()` hands the callback to the
  // runtime, which keeps the function alive until it resolves (within the
  // route's maxDuration).
  after(async () => {
    try {
      await processWebhook(request, body, connection);
    } catch (error) {
      console.error('Error processing webhook:', error);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}

async function processWebhook(
  request: Request,
  body: { entry?: { id?: string; changes?: TemplateChange[] }[] },
  connection: Awaited<
    ReturnType<typeof whatsappCloudProvider.resolveConnection>
  >
) {
  if (!body.entry) return;

  // Template-lifecycle events (status / quality / components updates from
  // Meta) come in on a different change.field and have a different value
  // shape — they are not channel events. `entry.id` is the WABA id: the
  // handler needs it to resolve the owning account when the template has
  // no local row yet (#534).
  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (isTemplateWebhookField(change.field)) {
        await handleTemplateWebhookChange(
          {
            field: change.field,
            value: change.value as unknown,
            wabaId: entry.id,
          },
          supabaseAdmin()
        );
      }
    }
  }

  const events = await whatsappCloudProvider.parse(request, connection!);
  if (events.length === 0) return;

  if (!connection) {
    console.error('No connection found for the webhook phone_number_id');
    return;
  }

  // Inbound messages need working credentials (media download, replies).
  if (events.some((e) => e.kind === 'message')) {
    const credentials = await getConnectionCredentials(connection.id);
    if (!credentials?.access_token) {
      console.error('No credentials found for connection:', connection.id);
      return;
    }
  }

  // Audit / sender-of-record: connections carry no user, so rows are
  // attributed to the account owner (stable, like the old config owner).
  const { data: ownerRow } = await supabaseAdmin()
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

  await ingestInbound(supabaseAdmin(), connection, events, {
    auditUserId: ownerUserId,
    hooks: {
      resolveMedia: createMediaResolver({
        provider: whatsappCloudProvider,
        storage: supabaseAdmin().storage,
      }),
      onMessageStored: fanoutHook({ configOwnerUserId: ownerUserId }),
      onConversationCreated: conversationCreatedHook,
    },
  });
}

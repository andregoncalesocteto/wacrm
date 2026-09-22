// ============================================================
// POST /api/v1/messages — send a WhatsApp message via the public API.
//
// The headline public endpoint (issue #245). Unlike the dashboard's
// `/api/whatsapp/send` (which takes an internal `conversation_id`),
// this takes a phone number — what an external automation actually
// has — resolves-or-creates the contact + conversation, then runs the
// same shared send core.
//
// Auth: API key with the `messages:send` scope. Account context (and
// the service-role client) come from `requireApiKey`.
//
// Addressing (one of):
//   { "conversation_id": "<uuid>" }               // reply in an existing conversation
//   { "connection_id": "<uuid>", "to": "…" }      // open/continue by connection
// `connection_id` may be omitted only when the account has exactly one active
// connection; otherwise 400 `connection_required`. `to` is E.164 for WhatsApp;
// for other channels it is the provider's address (e.g. a Telegram chat id) and
// the recipient must already have a conversation on that connection.
//
// Body (besides the addressing above):
//   {
//     "type": "text",                        // text|template|interactive|image|video|document|audio (default: text)
//     "text": "Hello!",                      // text body, or media caption
//     "media_url": "https://…/file.pdf",     // required for image/video/document/audio
//     "filename": "invoice.pdf",             // optional, document filename
//     "template": {                          // required when type=template
//       "name": "order_update",
//       "language": "en_US",
//       "params": ["A123"] | { "body": [...] }   // array = positional body; object = structured
//     },
//     "reply_to_message_id": "<uuid>",       // optional, must be in the same conversation
//     "name": "Jane Doe"                     // optional, names a newly-created WhatsApp contact
//   }
//
// Response (201):
//   { "data": { "message_id", "external_message_id", "conversation_id",
//               "connection_id", "channel", "contact_id", "contact_created" } }
// Errors: 400 connection_required, 404 not_found, 409 unsupported |
// window_closed | connection_disabled, 422 recipient_unreachable.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  resolveConversationByAddress,
  resolveConversationByPhone,
} from '@/lib/whatsapp/resolve-conversation';
import {
  getConnectionById,
  listConnectionsByAccount,
  type ChannelConnection,
} from '@/lib/channels/connections';
import { findAccountWhatsAppConnection } from '@/lib/channels/whatsapp-connection';
import { ChannelError } from '@/lib/channels/types';
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message';
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive';

const CHANNEL_ERROR_STATUS: Record<string, number> = {
  unsupported: 409,
  window_closed: 409,
  recipient_unreachable: 422,
};

/** The connection a `{ connection_id?, to }` request goes through. */
async function pickConnection(
  db: Parameters<typeof listConnectionsByAccount>[1],
  accountId: string,
  connectionId: string | null
): Promise<ChannelConnection> {
  if (connectionId) {
    const conn = await getConnectionById(connectionId, db);
    if (!conn || conn.account_id !== accountId) {
      throw new SendMessageError('not_found', 'Connection not found', 404);
    }
    return conn;
  }
  const all = await listConnectionsByAccount(accountId, db);
  const active = all.filter((c) => c.disabled_at == null);
  if (active.length === 1) return active[0];
  if (active.length > 1) {
    throw new SendMessageError(
      'connection_required',
      "'connection_id' is required when the account has more than one active connection",
      400
    );
  }
  if (all.length > 0) {
    throw new SendMessageError(
      'connection_disabled',
      'This connection is disabled. Enable it in Settings to send messages.',
      409
    );
  }
  throw new SendMessageError(
    'whatsapp_not_configured',
    'No channel connected. Please set up a connection first.',
    400
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'messages:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const conversationIdInput =
      typeof body.conversation_id === 'string'
        ? body.conversation_id.trim()
        : '';
    const connectionIdInput =
      typeof body.connection_id === 'string' ? body.connection_id.trim() : '';
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (conversationIdInput && (to || connectionIdInput)) {
      return fail(
        'bad_request',
        "Use either 'conversation_id' or 'connection_id' + 'to', not both",
        400
      );
    }
    if (!conversationIdInput && !to) {
      return fail('bad_request', "'conversation_id' or 'to' is required", 400);
    }

    const type = typeof body.type === 'string' ? body.type : 'text';

    // Unpack the optional `template` object into the flat params the
    // send core expects. `params` as an array → legacy positional body
    // params; as an object → structured header/body/button params.
    const template =
      body.template && typeof body.template === 'object'
        ? (body.template as Record<string, unknown>)
        : null;
    const templateParams = Array.isArray(template?.params)
      ? (template.params as unknown[]).filter(
          (p): p is string => typeof p === 'string'
        )
      : undefined;
    const templateMessageParams =
      template?.params && !Array.isArray(template.params)
        ? template.params
        : undefined;

    // Validate the message shape BEFORE resolveConversationByPhone
    // finds-or-creates a contact + conversation, so a bad payload 400s
    // without leaving an orphan contact/conversation behind.
    // Validated by `validateSendMessageParams` below; the cast just bridges
    // the untyped JSON body to the send-core param type.
    const interactivePayload =
      body.interactive_payload && typeof body.interactive_payload === 'object'
        ? (body.interactive_payload as InteractiveMessagePayload)
        : null;

    validateSendMessageParams({
      messageType: type,
      contentText: typeof body.text === 'string' ? body.text : null,
      mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
      templateName: typeof template?.name === 'string' ? template.name : null,
      interactivePayload,
    });

    // Resolve the conversation: given directly, or found/created through the
    // connection + address. All of it shares `SendMessageError`/`ChannelError`,
    // so one catch maps the whole pipeline to the envelope.
    let resolved: {
      conversationId: string;
      contactId: string;
      contactCreated: boolean;
    };
    let connectionId: string | null;
    if (conversationIdInput) {
      const { data: conv } = await ctx.supabase
        .from('conversations')
        .select('contact_id, connection_id')
        .eq('id', conversationIdInput)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (!conv) {
        return fail('not_found', 'Conversation not found', 404);
      }
      // Legacy conversations without a connection send through the account's
      // WhatsApp one (same fallback as the send core).
      connectionId =
        (conv as { connection_id?: string | null }).connection_id ??
        (await findAccountWhatsAppConnection(ctx.supabase, ctx.accountId))
          ?.id ??
        null;
      resolved = {
        conversationId: conversationIdInput,
        contactId: (conv as { contact_id: string }).contact_id,
        contactCreated: false,
      };
    } else {
      const connection = await pickConnection(
        ctx.supabase,
        ctx.accountId,
        connectionIdInput || null
      );
      if (connection.disabled_at) {
        // Refuse before any contact/conversation is created (US-078).
        throw new SendMessageError(
          'connection_disabled',
          'This connection is disabled. Enable it in Settings to send messages.',
          409
        );
      }
      connectionId = connection.id;
      resolved =
        connection.channel_type === 'whatsapp_cloud'
          ? await resolveConversationByPhone(
              ctx.supabase,
              ctx.accountId,
              to,
              typeof body.name === 'string' ? body.name : null,
              connection
            )
          : await resolveConversationByAddress(
              ctx.supabase,
              ctx.accountId,
              connection,
              to
            );
    }

    const result = await sendMessageToConversation(
      ctx.supabase,
      ctx.accountId,
      {
        conversationId: resolved.conversationId,
        messageType: type,
        contentText: typeof body.text === 'string' ? body.text : null,
        mediaUrl: typeof body.media_url === 'string' ? body.media_url : null,
        filename: typeof body.filename === 'string' ? body.filename : null,
        templateName: typeof template?.name === 'string' ? template.name : null,
        templateLanguage:
          typeof template?.language === 'string' ? template.language : null,
        templateParams,
        templateMessageParams,
        interactivePayload,
        replyToMessageId:
          typeof body.reply_to_message_id === 'string'
            ? body.reply_to_message_id
            : null,
      }
    );

    const connection = connectionId
      ? await getConnectionById(connectionId, ctx.supabase)
      : null;

    return ok(
      {
        message_id: result.messageId,
        external_message_id: result.whatsappMessageId,
        conversation_id: resolved.conversationId,
        connection_id: connectionId,
        channel: connection?.channel_type ?? null,
        contact_id: resolved.contactId,
        contact_created: resolved.contactCreated,
      },
      201
    );
  } catch (err) {
    if (err instanceof ChannelError) {
      const status = CHANNEL_ERROR_STATUS[err.code];
      if (status) return fail(err.code, err.message, status);
    }
    if (err instanceof SendMessageError) {
      const status = err.channelCode
        ? CHANNEL_ERROR_STATUS[err.channelCode]
        : undefined;
      if (status) return fail(err.channelCode!, err.message, status);
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}

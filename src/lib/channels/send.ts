import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin as flowsAdmin } from '@/lib/flows/admin-client';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import {
  interactivePayloadPreviewText,
  validateInteractivePayload,
  type InteractiveMessagePayload,
} from '@/lib/whatsapp/interactive';
import {
  resolveTemplateRow,
  templateBodyParams,
  templateContentText,
} from '@/lib/whatsapp/template-body';
import { supabaseAdmin } from './admin-client';
import type { ChannelConnection } from './connections';
import { findAccountWhatsAppConnection } from './whatsapp-connection';
import { getProvider } from './registry';
import { registerBuiltinProviders } from './providers';
import {
  ChannelError,
  ConnectionDisabledError,
  type Capabilities,
  type ContactIdentity,
  type InteractivePayload,
  type OutboundMessage,
  type SendResult,
} from './types';

/**
 * Single outbound path (US-023): text and media. Reproduces what
 * `sendMessageToConversation` does today, but through the provider contract:
 * load conversation/connection/contact, resolve the target, validate against
 * the provider's capabilities, send, persist, update the conversation, fix the
 * contact address, pause the active flow when a human steps in.
 *
 * A failed provider send persists NOTHING and leaves the conversation alone
 * (pinned by send-message.characterization.test.ts). `error_code` columns are
 * only filled by the failure status event received later (ingest).
 *
 * US-024 adds `template` and `interactive`:
 *  - Template: the core (not the provider, which stays DB-free) resolves the
 *    local `message_templates` row with `resolveTemplateRow` and hands it to the
 *    provider inside `template.provider` (`{ row, messageParams, params }`). The
 *    caller passes send-time values as `template.provider = { messageParams,
 *    params }` and, optionally, a pre-rendered body as `contentText`.
 *  - Interactive: the neutral payload uses `buttonLabel`; what is PERSISTED
 *    (`messages.interactive_payload`) is the legacy shape (`button_label`) the
 *    thread renderer and quick replies already read, so it is converted back.
 * SERVER-ONLY.
 */

export type OutboundActor =
  | { type: 'agent'; userId?: string | null }
  | { type: 'bot' | 'flow' | 'automation' | 'ai' };

export interface SendOutboundInput {
  conversationId: string;
  accountId: string;
  message: OutboundMessage;
  actor: OutboundActor;
  /** Our `messages.id` of the message being quoted (must be in this conversation). */
  replyToMessageId?: string | null;
  /** Template only: caller-rendered body to persist (wins over the row's body). */
  contentText?: string | null;
  /**
   * Conversation preview to use when the message has no text of its own
   * (default `[<content_type>]`). Automations keep their `[template:<name>]`.
   */
  fallbackPreview?: string;
  /** RLS-bound or service-role client; every query is account-scoped either way. */
  db?: SupabaseClient;
}

export interface SendOutboundResult {
  /** Our `messages.id` (the persisted row). */
  messageId: string;
  /** Provider message id (wamid, Telegram message_id). */
  externalMessageId: string;
  connectionId: string;
  /** The delivered address when it differs from the resolved one. */
  resolvedAddress?: string;
}

export class ConversationNotFoundError extends Error {
  constructor() {
    super('Conversation not found');
    this.name = 'ConversationNotFoundError';
  }
}

export class ConnectionNotConfiguredError extends Error {
  constructor() {
    super(
      'WhatsApp not configured. Please set up your WhatsApp integration first.'
    );
    this.name = 'ConnectionNotConfiguredError';
  }
}

/** The provider accepted the message but saving it failed. */
export class OutboundPersistError extends Error {
  constructor(message: string) {
    super(`Message sent to Meta but failed to save to DB: ${message}`);
    this.name = 'OutboundPersistError';
  }
}

/** The local template row exists but is malformed (legacy code `template_malformed`, 500). */
export class TemplateMalformedError extends Error {
  constructor() {
    super(
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it.'
    );
    this.name = 'TemplateMalformedError';
  }
}

/** Stable messages for a channel lacking a capability (the UI can key on them, US-046). */
export const UNSUPPORTED_TEMPLATES =
  'This channel does not support template messages';
export const UNSUPPORTED_BUTTONS =
  'This channel does not support interactive buttons';
export const UNSUPPORTED_LIST =
  'This channel does not support interactive lists';

/** Send-time template data the caller may put in `template.provider`. */
export interface TemplateSendData {
  messageParams?: unknown;
  params?: string[];
}

function toLegacyInteractive(p: InteractivePayload): InteractiveMessagePayload {
  if (p.kind === 'buttons') return p;
  const { buttonLabel, ...rest } = p;
  return { ...rest, button_label: buttonLabel };
}

/**
 * Errors thrown by `provider.send` itself. The legacy HTTP mapping answers 502
 * for every failure that reached the provider (Meta rejected it) and 400 for
 * those raised before it, and both are ChannelErrors with the same codes, so
 * the origin is tracked here.
 */
const providerFailures = new WeakSet<object>();

const WA_PHONE = 'whatsapp:phone';
const WA_BSUID = 'whatsapp:bsuid';

type Row = Record<string, unknown>;

async function loadConnection(
  db: SupabaseClient,
  accountId: string,
  connectionId: string | null
): Promise<ChannelConnection | null> {
  if (connectionId) {
    const { data } = await db
      .from('channel_connections')
      .select('*')
      .eq('id', connectionId)
      .eq('account_id', accountId)
      .maybeSingle();
    if (data) return data as ChannelConnection;
  }
  return findAccountWhatsAppConnection(db, accountId);
}

async function loadIdentities(
  db: SupabaseClient,
  accountId: string,
  contact: Row,
  channelType: string
): Promise<ContactIdentity[]> {
  const { data } = await db
    .from('contact_identities')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id as string);
  const identities: ContactIdentity[] = ((data as Row[] | null) ?? []).map(
    (r) => ({
      kind: r.kind as string,
      externalId: r.external_id as string,
      handle: (r.handle as string | null) ?? null,
    })
  );
  // Accounts not yet dual-populated: fall back to the legacy columns.
  if (channelType === 'whatsapp_cloud') {
    const phone = contact.phone as string | undefined;
    const bsuid = contact.wa_user_id as string | undefined;
    if (phone && !identities.some((i) => i.kind === WA_PHONE)) {
      identities.push({ kind: WA_PHONE, externalId: phone });
    }
    if (bsuid && !identities.some((i) => i.kind === WA_BSUID)) {
      identities.push({ kind: WA_BSUID, externalId: bsuid });
    }
  }
  return identities;
}

function validate(message: OutboundMessage, caps: Capabilities): void {
  switch (message.type) {
    case 'text':
      if (!message.text) {
        throw new ChannelError('invalid', 'content_text is required');
      }
      return;
    case 'media':
      if (!message.url) {
        throw new ChannelError(
          'invalid',
          `media_url is required for ${message.kind} messages`
        );
      }
      if (!caps.mediaKinds.includes(message.kind)) {
        throw new ChannelError(
          'unsupported',
          `This channel does not support ${message.kind} messages`
        );
      }
      // Audio carries no caption.
      if (
        message.kind !== 'audio' &&
        typeof message.caption === 'string' &&
        message.caption.length > caps.captionMaxLength
      ) {
        throw new ChannelError(
          'invalid',
          `Caption exceeds the ${caps.captionMaxLength}-character limit`
        );
      }
      return;
    case 'template':
      if (!caps.templates) {
        throw new ChannelError('unsupported', UNSUPPORTED_TEMPLATES);
      }
      if (!message.template.name) {
        throw new ChannelError('invalid', 'template_name is required');
      }
      return;
    case 'interactive': {
      const kind = message.interactive.kind;
      if (kind === 'buttons' && !caps.interactiveButtons) {
        throw new ChannelError('unsupported', UNSUPPORTED_BUTTONS);
      }
      if (kind === 'list' && !caps.interactiveList) {
        throw new ChannelError('unsupported', UNSUPPORTED_LIST);
      }
      const result = validateInteractivePayload(
        toLegacyInteractive(message.interactive)
      );
      if (!result.ok) throw new ChannelError('invalid', result.error);
      return;
    }
    default:
      // Reactions go through provider.react.
      throw new ChannelError(
        'unsupported',
        `Message type "${message.type}" is not implemented in sendOutbound yet`
      );
  }
}

/**
 * Best-effort "typing..." for the inbound message being answered (US-029).
 * Resolves the conversation's connection and provider like `sendOutbound`;
 * no-op when the provider does not declare `typingIndicator`. Errors
 * propagate: the caller decides whether they matter (the AI reply swallows
 * them).
 */
export async function showTyping(input: {
  conversationId: string;
  accountId: string;
  inboundExternalId: string;
  db?: SupabaseClient;
}): Promise<void> {
  const { conversationId, accountId, inboundExternalId } = input;
  const db = input.db ?? supabaseAdmin();

  const { data: conversation, error } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();
  if (error || !conversation) throw new ConversationNotFoundError();
  const contact = (conversation as Row).contact as Row;

  const connection = await loadConnection(
    db,
    accountId,
    ((conversation as Row).connection_id as string | null) ?? null
  );
  if (!connection) throw new ConnectionNotConfiguredError();
  if (connection.disabled_at) throw new ConnectionDisabledError();

  registerBuiltinProviders();
  const provider = getProvider(connection.channel_type);
  if (!provider.capabilities.typingIndicator || !provider.typing) return;

  const identities = await loadIdentities(
    db,
    accountId,
    contact,
    connection.channel_type
  );
  const target = provider.resolveTarget(identities);
  if (!target) {
    throw new ChannelError('recipient_unreachable', 'No reachable address');
  }
  await provider.typing(connection, target, { inboundExternalId });
}

export async function sendOutbound(
  input: SendOutboundInput
): Promise<SendOutboundResult> {
  const { conversationId, accountId, message, actor, replyToMessageId } = input;
  const db = input.db ?? supabaseAdmin();

  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();
  if (convError || !conversation) throw new ConversationNotFoundError();
  const contact = (conversation as Row).contact as Row;

  const connection = await loadConnection(
    db,
    accountId,
    ((conversation as Row).connection_id as string | null) ?? null
  );
  if (!connection) throw new ConnectionNotConfiguredError();
  // US-078: an existing conversation sends through ITS connection; when that
  // one is disabled the send fails (no provider call, nothing persisted).
  if (connection.disabled_at) throw new ConnectionDisabledError();

  registerBuiltinProviders();
  const provider = getProvider(connection.channel_type);

  const identities = await loadIdentities(
    db,
    accountId,
    contact,
    connection.channel_type
  );
  const target = provider.resolveTarget(identities);
  if (!target) {
    throw new ChannelError(
      'recipient_unreachable',
      contact?.phone
        ? 'Invalid phone number format'
        : connection.channel_type === 'whatsapp_cloud'
          ? 'Contact has no phone number or WhatsApp user ID'
          : 'Contact has no reachable address on this channel'
    );
  }

  validate(message, provider.capabilities);

  // Template: resolve the local row (header/button components + body to persist).
  let templateRow: Awaited<ReturnType<typeof resolveTemplateRow>>['row'] = null;
  let outboundBase: OutboundMessage = message;
  if (message.type === 'template') {
    const sendData = (message.template.provider ?? {}) as TemplateSendData;
    const resolved = await resolveTemplateRow(
      db,
      accountId,
      message.template.name,
      message.template.language
    );
    if (resolved.malformed) throw new TemplateMalformedError();
    templateRow = resolved.row;
    outboundBase = {
      ...message,
      template: {
        ...message.template,
        language: resolved.language,
        provider: {
          row: templateRow ?? undefined,
          messageParams: sendData.messageParams ?? undefined,
          params: sendData.params ?? [],
        },
      },
    };
  }

  // The quoted message must belong to this same conversation.
  let outbound: OutboundMessage = outboundBase;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (parentError || !parent) {
      throw new ChannelError(
        'invalid',
        'reply_to_message_id not found in this conversation'
      );
    }
    const parentExternal = (parent as Row).message_id as string | null;
    if (!parentExternal) {
      console.warn(
        '[send] reply target has no provider message id; sending without context'
      );
    } else {
      outbound = { ...outboundBase, replyTo: { externalId: parentExternal } };
    }
  }

  // Provider errors (ChannelError) propagate: nothing is persisted.
  let sent: SendResult;
  try {
    sent = await provider.send(connection, target, outbound);
  } catch (err) {
    if (typeof err === 'object' && err !== null) providerFailures.add(err);
    throw err;
  }

  if (sent.resolvedAddress && target.kind === WA_PHONE) {
    console.log(
      `[send] Auto-corrected contact phone: ${target.address} → ${sent.resolvedAddress}`
    );
    await db
      .from('contacts')
      .update({ phone: sent.resolvedAddress })
      .eq('id', contact.id as string);
  }

  const isMedia = message.type === 'media';
  let contentText: string | null = null;
  let contentType: string = 'text';
  let previewText: string | null = null;
  let templateName: string | null = null;
  let interactivePayload: InteractiveMessagePayload | null = null;
  switch (message.type) {
    case 'media':
      contentText = message.caption ?? null;
      contentType = message.kind;
      break;
    case 'text':
      contentText = message.text;
      break;
    case 'template': {
      const sendData = (message.template.provider ?? {}) as TemplateSendData;
      contentType = 'template';
      templateName = message.template.name;
      contentText = templateContentText(
        templateRow,
        templateBodyParams(sendData.params, sendData.messageParams),
        input.contentText
      );
      break;
    }
    case 'interactive':
      contentType = 'interactive';
      interactivePayload = toLegacyInteractive(message.interactive);
      contentText = interactivePayload.body;
      previewText = interactivePayloadPreviewText(interactivePayload);
      break;
  }

  const { data: record, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: actor.type === 'agent' ? 'agent' : 'bot',
      ...(actor.type === 'agent' && actor.userId
        ? { sender_id: actor.userId }
        : {}),
      ...(actor.type === 'ai' ? { ai_generated: true } : {}),
      content_type: contentType,
      content_text: contentText,
      media_url: isMedia ? message.url || null : null,
      template_name: templateName,
      interactive_payload: interactivePayload,
      message_id: sent.externalId,
      status: 'sent',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();
  if (msgError || !record) {
    console.error('[send] error inserting sent message:', msgError);
    throw new OutboundPersistError(msgError?.message ?? 'no row returned');
  }

  const now = new Date().toISOString();
  await db
    .from('conversations')
    .update({
      last_message_text:
        previewText ??
        (contentText || (input.fallbackPreview ?? `[${contentType}]`)),
      last_message_at: now,
      updated_at: now,
    })
    .eq('id', conversationId);

  // A human stepping in is the strongest "yield" signal for a running flow.
  if (actor.type === 'agent') {
    try {
      const { error: pauseErr } = await flowsAdmin()
        .from('flow_runs')
        .update({
          status: 'paused_by_agent',
          ended_at: new Date().toISOString(),
          end_reason: 'agent_replied',
        })
        .eq('account_id', accountId)
        .eq('conversation_id', conversationId)
        .eq('status', 'active');
      if (pauseErr) {
        console.error('[flows] pause-on-agent-send failed:', pauseErr.message);
      }
    } catch (err) {
      console.error(
        '[flows] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    messageId: (record as Row).id as string,
    externalMessageId: sent.externalId,
    connectionId: connection.id,
    ...(sent.resolvedAddress && { resolvedAddress: sent.resolvedAddress }),
  };
}

/**
 * Maps a sendOutbound failure to the old `SendMessageError` so the routes keep
 * their HTTP responses (US-025/026). Unknown errors are returned as-is.
 */
export function toSendMessageError(err: unknown): unknown {
  if (err instanceof SendMessageError) return err;
  if (err instanceof ConversationNotFoundError) {
    return new SendMessageError('not_found', err.message, 404);
  }
  if (err instanceof TemplateMalformedError) {
    return new SendMessageError('template_malformed', err.message, 500);
  }
  if (err instanceof ConnectionNotConfiguredError) {
    return new SendMessageError('whatsapp_not_configured', err.message, 400);
  }
  if (err instanceof OutboundPersistError) {
    return new SendMessageError('db_error', err.message, 500);
  }
  if (err instanceof ConnectionDisabledError) {
    return new SendMessageError(err.reason, err.message, 409);
  }
  if (err instanceof ChannelError) {
    if (
      !providerFailures.has(err) &&
      (err.code === 'recipient_unreachable' ||
        err.code === 'unsupported' ||
        err.code === 'invalid')
    ) {
      // Failed before the provider was called: the old core answered 400.
      return new SendMessageError('bad_request', err.message, 400);
    }
    return new SendMessageError(
      'meta_error',
      `Meta API error: ${err.message}`,
      502
    );
  }
  return err;
}

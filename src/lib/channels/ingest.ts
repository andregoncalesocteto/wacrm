import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { resolveOrCreateContact, type ContactRow } from './identity';
import { isValidStatusTransition } from './status-ladder';
import type { Connection, InboundContent, InboundEvent } from './types';

/**
 * Channel-agnostic inbound ingestion (US-019): what happens to a `message`
 * event once a provider has parsed it. Persistence only:
 *
 *   contact (identity.ts) -> conversation by (contact, connection)
 *   -> idempotent message insert -> conversation summary / unread / reopen.
 *
 * It depends ONLY on its arguments: no route, no `after()`, no request. `db`
 * must be a service-role client (there is no user session on this path).
 *
 * Extension points (`IngestHooks`) are where the wiring plugs in without
 * changing this file's contract:
 *   - `resolveMedia`  -> `createMediaResolver` (media.ts, US-021)
 *   - `onConversationCreated` / `onMessageStored` -> fanout.ts (US-020 / US-074)
 *
 * US-021 adds the other two event kinds, reproducing the WhatsApp webhook:
 *   - `status`   -> `messages` mirror (NO order guard, any status is written),
 *     `broadcast_recipients` mirror (forward-only ladder, `failed` only from
 *     pending/sent), then the `message.status_updated` outbound webhook.
 *   - `reaction` -> insert/replace/remove on `message_reactions`; resolves (and
 *     may create) the contact + conversation like a message does, never
 *     touches `messages`, unread or the preview.
 * `connection` events are still reported as `skipped`.
 */

export interface IngestOptions {
  /** NOT NULL audit user for new contacts / conversations (the account owner). */
  auditUserId: string;
  hooks?: IngestHooks;
}

export interface IngestHooks {
  /**
   * Returns the durable URL (and MIME type) to store for inbound media.
   * Absent, or returning null, stores no `media_url` (the MIME type from the
   * provider is still kept). Must not throw: a failure is logged and treated
   * as "no media URL".
   */
  resolveMedia?: (
    content: Extract<InboundContent, { type: 'media' }>,
    ctx: { connection: Connection; event: MessageEvent }
  ) => Promise<{ url: string | null; mimeType?: string | null } | null>;
  /** Fired once, right after a NEW conversation is opened, before its first message. */
  onConversationCreated?: (ctx: IngestContext) => Promise<void> | void;
  /**
   * Fired only for a genuinely new message (never for a replayed one), after
   * the conversation was updated. Errors are logged and never undo the
   * stored message.
   */
  onMessageStored?: (result: IngestedMessage) => Promise<void> | void;
}

type MessageEvent = Extract<InboundEvent, { kind: 'message' }>;
type StatusEvent = Extract<InboundEvent, { kind: 'status' }>;
type ReactionEvent = Extract<InboundEvent, { kind: 'reaction' }>;

export interface IngestContext {
  connection: Connection;
  contact: ContactRow;
  conversation: ConversationRow;
  contactCreated: boolean;
  conversationCreated: boolean;
}

export type ConversationRow = Record<string, unknown> & {
  id: string;
  status?: string | null;
  connection_id?: string | null;
};

export interface IngestedMessage extends IngestContext {
  event: MessageEvent;
  /** `messages.id` of the row just inserted. */
  messageId: string;
  contentType: string;
  contentText: string | null;
  mediaUrl: string | null;
  interactiveReplyId: string | null;
  /** True when no customer message existed in the conversation before this one. */
  isFirstInbound: boolean;
}

export type IngestOutcome =
  | ({ status: 'stored' } & IngestedMessage)
  | {
      /** Same (conversation, external id) already stored: nothing was touched. */
      status: 'duplicate';
      event: MessageEvent;
      conversation: ConversationRow;
      contact: ContactRow;
    }
  | {
      /** A `status` event was applied (see `StatusUpdateOutcome`). */
      status: 'status_updated';
      event: StatusEvent;
      /** A `broadcast_recipients` row moved (the ladder allowed it). */
      recipientUpdated: boolean;
      /** The `message.status_updated` webhook was dispatched (message row found). */
      webhookDispatched: boolean;
    }
  | {
      /** A `reaction` event was stored (`set`, insert or replace) or removed. */
      status: 'reaction_set' | 'reaction_removed';
      event: ReactionEvent;
      conversation: ConversationRow;
      contact: ContactRow;
      /** `messages.id` the reaction targets. */
      targetMessageId: string;
    }
  | {
      /** Not persisted: a non-message event, no usable identity, or a DB failure. */
      status: 'skipped';
      event: InboundEvent;
      reason: string;
    };

interface StoredShape {
  contentType: string;
  contentText: string | null;
  mediaType: string | null;
  interactiveReplyId: string | null;
  /** Text for `last_message_text` (with the "[type]" placeholder applied). */
  preview: string;
}

/**
 * What the row stores for each content kind. Reproduces the current webhook
 * (`parseMessageContent` + content-type mapping); media URL comes separately.
 */
function shapeOf(event: MessageEvent): StoredShape {
  const c = event.content;
  let contentType = 'text';
  let contentText: string | null = null;
  let mediaType: string | null = null;
  let interactiveReplyId: string | null = null;
  let fallback: string | null = null;

  switch (c.type) {
    case 'text':
      contentText = c.text || null;
      break;
    case 'media':
      contentType = c.kind;
      contentText = c.caption || null;
      mediaType = c.media.mimeType ?? null;
      break;
    case 'interactive_reply':
      // Interactive taps and template quick-reply buttons: title displays,
      // id routes; each may be empty.
      contentType = 'interactive';
      contentText = c.title || null;
      interactiveReplyId = c.id || null;
      break;
    case 'location':
      contentType = 'location';
      contentText = c.text;
      break;
    case 'unsupported':
      fallback = c.description ?? null;
      if (c.stored) {
        contentType = c.stored.contentType;
        contentText = c.stored.text;
      } else {
        contentText = c.description ?? null;
      }
      break;
  }

  const preview =
    contentText || event.emptyPreview || fallback || `[${contentType}]`;
  return { contentType, contentText, mediaType, interactiveReplyId, preview };
}

/**
 * The contact's conversation for this connection.
 *
 * TRANSITION RULE (until US-032): the DB unique index is still
 * (account_id, contact_id), one conversation per contact. So the lookup takes
 * the contact's OLDEST conversation that is on this connection OR has
 * `connection_id` NULL (created before connections existed) and ADOPTS a NULL
 * one by stamping this connection on it; creating a second conversation for
 * such a contact would violate the old index. A conversation on a DIFFERENT
 * connection is not reused (it belongs to another channel/number); the insert
 * then hits the old index and the message is skipped with a log, which only
 * happens for a contact talking on two connections, unreachable before US-032.
 * When US-032 moves the index to (contact_id, connection_id) the NULL branch
 * becomes dead and can go.
 */
async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
  connectionId: string
): Promise<{ conversation: ConversationRow; created: boolean } | null> {
  // Oldest-first, never `.single()`: duplicates (issue #363) must converge on
  // the canonical survivor instead of snowballing.
  const find = async () => {
    const { data, error } = await db
      .from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('[ingest] error finding conversation:', error);
      return null;
    }
    const rows = (data ?? []) as ConversationRow[];
    return (
      rows.find((r) => r.connection_id === connectionId) ??
      rows.find((r) => r.connection_id == null) ??
      undefined
    );
  };

  const adopt = async (row: ConversationRow) => {
    if (row.connection_id === connectionId) return row;
    const { error } = await db
      .from('conversations')
      .update({ connection_id: connectionId })
      .eq('id', row.id)
      .is('connection_id', null);
    if (error) {
      console.error('[ingest] error adopting conversation:', error);
      return row;
    }
    return { ...row, connection_id: connectionId };
  };

  const existing = await find();
  if (existing === null) return null;
  if (existing) return { conversation: await adopt(existing), created: false };

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      contact_id: contactId,
      connection_id: connectionId,
    })
    .select()
    .single();

  if (error || !created) {
    // Lost a race to a concurrent delivery: re-resolve the winner.
    if (isUniqueViolation(error)) {
      const raced = await find();
      if (raced) return { conversation: await adopt(raced), created: false };
    }
    console.error('[ingest] error creating conversation:', error);
    return null;
  }
  return { conversation: created as ConversationRow, created: true };
}

async function lookupInternalIdByExternalId(
  db: SupabaseClient,
  externalId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('message_id', externalId)
    .eq('conversation_id', conversationId)
    .maybeSingle();
  if (error) {
    console.error('[ingest] reply lookup failed:', error.message);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

async function runHook<A>(
  name: string,
  fn: ((arg: A) => Promise<void> | void) | undefined,
  arg: A
) {
  if (!fn) return;
  try {
    await fn(arg);
  } catch (err) {
    console.error(`[ingest] hook ${name} failed:`, err);
  }
}

/**
 * Contact + conversation for an inbound event, firing `onConversationCreated`
 * for a new thread (before the message / reaction, like the route).
 */
async function resolveThread(
  db: SupabaseClient,
  connection: Connection,
  opts: IngestOptions,
  input: {
    sender: MessageEvent['sender'];
    senderName?: string;
    parentExternalId?: string;
  }
): Promise<
  | { skip: string }
  | { ctx: IngestContext; conversation: ConversationRow; contact: ContactRow }
> {
  const accountId = connection.account_id;
  const outcome = await resolveOrCreateContact(db, {
    accountId,
    candidates: input.sender,
    senderName: input.senderName,
    auditUserId: opts.auditUserId,
    parentExternalId: input.parentExternalId,
  });
  if (!outcome) return { skip: 'no contact' };
  const contact = outcome.contact;

  const conv = await findOrCreateConversation(
    db,
    accountId,
    opts.auditUserId,
    contact.id,
    connection.id
  );
  if (!conv) return { skip: 'no conversation' };
  const conversation = conv.conversation;

  const ctx: IngestContext = {
    connection,
    contact,
    conversation,
    contactCreated: outcome.wasCreated,
    conversationCreated: conv.created,
  };
  if (conv.created) {
    await runHook(
      'onConversationCreated',
      opts.hooks?.onConversationCreated,
      ctx
    );
  }
  return { ctx, conversation, contact };
}

async function ingestMessage(
  db: SupabaseClient,
  connection: Connection,
  event: MessageEvent,
  opts: IngestOptions
): Promise<IngestOutcome> {
  const skip = (reason: string): IngestOutcome => ({
    status: 'skipped',
    event,
    reason,
  });

  const resolved = await resolveThread(db, connection, opts, {
    sender: event.sender,
    senderName: event.senderName,
    parentExternalId: event.parentExternalId,
  });
  if ('skip' in resolved) return skip(resolved.skip);
  const { ctx, conversation, contact } = resolved;

  const shape = shapeOf(event);

  let mediaUrl: string | null = null;
  let mediaType = shape.mediaType;
  if (event.content.type === 'media' && opts.hooks?.resolveMedia) {
    try {
      const media = await opts.hooks.resolveMedia(event.content, {
        connection,
        event,
      });
      if (media) {
        mediaUrl = media.url;
        mediaType = media.mimeType ?? mediaType;
      }
    } catch (err) {
      console.error('[ingest] resolveMedia failed:', err);
    }
  }

  // Missing parent is fine: store NULL and the UI renders no quote.
  let replyTo: string | null = null;
  if (event.replyToExternalId) {
    replyTo = await lookupInternalIdByExternalId(
      db,
      event.replyToExternalId,
      conversation.id
    );
    if (!replyTo) {
      console.warn(
        '[ingest] reply context parent not found:',
        event.replyToExternalId
      );
    }
  }

  // Counted BEFORE the insert so it is accurate; covers a contact that
  // existed (manual add / import) but never wrote before.
  const { count: priorCustomerMessages } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer');
  const isFirstInbound = (priorCustomerMessages ?? 0) === 0;

  // The single idempotency boundary: UNIQUE (conversation_id, message_id).
  // A replay conflicts, `ignoreDuplicates` makes it ON CONFLICT DO NOTHING and
  // `.select()` returns the row only for a genuine first insert. It sits
  // BEFORE the unread bump and any fan-out (issue #367).
  const { data: inserted, error: msgError } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: shape.contentType,
        content_text: shape.contentText,
        media_url: mediaUrl,
        media_type: mediaType,
        message_id: event.externalId,
        status: 'delivered',
        created_at: event.at.toISOString(),
        reply_to_message_id: replyTo,
        interactive_reply_id: shape.interactiveReplyId,
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true }
    )
    .select('id');

  if (msgError) {
    console.error('[ingest] error inserting message:', msgError);
    return skip('insert failed');
  }
  if (!inserted || inserted.length === 0) {
    console.info(
      '[ingest] duplicate inbound message ignored (idempotent replay):',
      event.externalId
    );
    return { status: 'duplicate', event, conversation, contact };
  }

  // Unread bump DB-side (one UPDATE, safe under concurrent deliveries,
  // issue #369); it also refreshes last_message_text/at and updated_at.
  const { error: convError } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: shape.preview,
  });
  if (convError)
    console.error('[ingest] error updating conversation:', convError);

  // A customer writing again re-opens the thread (issue #409).
  await reopenClosedConversation(db, conversation);

  const stored: IngestedMessage = {
    ...ctx,
    event,
    messageId: (inserted[0] as { id: string }).id,
    contentType: shape.contentType,
    contentText: shape.contentText,
    mediaUrl,
    interactiveReplyId: shape.interactiveReplyId,
    isFirstInbound,
  };
  await runHook('onMessageStored', opts.hooks?.onMessageStored, stored);
  return { status: 'stored', ...stored };
}

/**
 * Port of the route's `handleStatusUpdate`, step for step:
 *  1. `messages` mirror by external id: writes ANY status (no order guard; a
 *     message can go read -> delivered) and, on `failed` with a reason, the
 *     error_code/title/details columns. Later non-failed statuses leave them.
 *     No `.select()`: message_id is not unique, so 0..N rows are updated.
 *  2. `broadcast_recipients` by whatsapp_message_id, moved only when the
 *     ladder allows it; `error_message` folds the reason.
 *  3. `message.status_updated` outbound webhook (last, so a slow subscriber
 *     cannot delay the mirrors); account resolved through the embedded
 *     `conversations(account_id)` join of one message row.
 */
async function ingestStatus(
  db: SupabaseClient,
  event: StatusEvent
): Promise<IngestOutcome> {
  const failure = event.status === 'failed' ? event.error : undefined;
  if (failure) {
    console.warn(
      `[ingest] message ${event.externalId} failed: ${failure.message}`
    );
  }

  const messageUpdate: Record<string, unknown> = { status: event.status };
  if (failure) {
    messageUpdate.error_code = failure.providerCode ?? null;
    messageUpdate.error_title = failure.title ?? failure.message;
    messageUpdate.error_details = failure.details ?? null;
  }
  const { error: msgErr } = await db
    .from('messages')
    .update(messageUpdate)
    .eq('message_id', event.externalId);
  if (msgErr) console.error('[ingest] error updating message status:', msgErr);

  const tsIso = (event.at ?? new Date()).toISOString();
  let recipientUpdated = false;
  const { data: recipient, error: recFetchErr } = await db
    .from('broadcast_recipients')
    .select('id, status')
    .eq('whatsapp_message_id', event.externalId)
    .maybeSingle();
  if (recFetchErr) {
    console.error('[ingest] error fetching broadcast recipient:', recFetchErr);
  } else if (
    recipient &&
    isValidStatusTransition(
      (recipient as { status: string }).status,
      event.status
    )
  ) {
    const update: Record<string, unknown> = { status: event.status };
    if (event.status === 'sent') update.sent_at = tsIso;
    if (event.status === 'delivered') update.delivered_at = tsIso;
    if (event.status === 'read') update.read_at = tsIso;
    if (failure) update.error_message = failure.message;
    const { error: recUpdateErr } = await db
      .from('broadcast_recipients')
      .update(update)
      .eq('id', (recipient as { id: string }).id);
    if (recUpdateErr) {
      console.error(
        '[ingest] error updating broadcast recipient status:',
        recUpdateErr
      );
    } else {
      recipientUpdated = true;
    }
  }

  let webhookDispatched = false;
  const { data: msgRow } = await db
    .from('messages')
    .select('conversation_id, conversations(account_id)')
    .eq('message_id', event.externalId)
    .limit(1)
    .maybeSingle();
  if (msgRow) {
    const row = msgRow as unknown as {
      conversation_id: string;
      conversations: { account_id: string } | null;
    };
    const accountId = row.conversations?.account_id;
    if (accountId) {
      await dispatchWebhookEvent(db, accountId, 'message.status_updated', {
        whatsapp_message_id: event.externalId,
        conversation_id: row.conversation_id,
        status: event.status,
      });
      webhookDispatched = true;
    }
  }

  return {
    status: 'status_updated',
    event,
    recipientUpdated,
    webhookDispatched,
  };
}

/**
 * Port of the route's reaction path: the sender's contact and conversation are
 * resolved first (a reaction can open a thread and fire `conversation.created`),
 * then the target message is found by external id inside that conversation. An
 * unknown target is skipped (logged). Null emoji removes the customer's
 * reaction; otherwise it is upserted (one per target and actor).
 */
async function ingestReaction(
  db: SupabaseClient,
  connection: Connection,
  event: ReactionEvent,
  opts: IngestOptions
): Promise<IngestOutcome> {
  const skip = (reason: string): IngestOutcome => ({
    status: 'skipped',
    event,
    reason,
  });
  const resolved = await resolveThread(db, connection, opts, {
    sender: event.sender,
  });
  if ('skip' in resolved) return skip(resolved.skip);
  const { conversation, contact } = resolved;

  const targetMessageId = await lookupInternalIdByExternalId(
    db,
    event.externalId,
    conversation.id
  );
  if (!targetMessageId) {
    console.warn(
      '[ingest] reaction target message not found; skipping',
      event.externalId
    );
    return skip('reaction target not found');
  }

  if (!event.emoji) {
    const { error } = await db
      .from('message_reactions')
      .delete()
      .eq('message_id', targetMessageId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contact.id);
    if (error) {
      console.error('[ingest] reaction delete failed:', error.message);
      return skip('reaction delete failed');
    }
    return {
      status: 'reaction_removed',
      event,
      conversation,
      contact,
      targetMessageId,
    };
  }

  const { error } = await db.from('message_reactions').upsert(
    {
      message_id: targetMessageId,
      conversation_id: conversation.id,
      actor_type: 'customer',
      actor_id: contact.id,
      emoji: event.emoji,
    },
    { onConflict: 'message_id,actor_type,actor_id' }
  );
  if (error) {
    console.error('[ingest] reaction upsert failed:', error.message);
    return skip('reaction upsert failed');
  }
  return {
    status: 'reaction_set',
    event,
    conversation,
    contact,
    targetMessageId,
  };
}

/**
 * Ingest the events a provider parsed for one connection, in order. Returns
 * one outcome per event. Never throws for a single bad event: it is reported
 * as `skipped` and the rest still run.
 */
export async function ingestInbound(
  db: SupabaseClient,
  connection: Connection,
  events: InboundEvent[],
  opts: IngestOptions
): Promise<IngestOutcome[]> {
  const out: IngestOutcome[] = [];
  for (const event of events) {
    try {
      switch (event.kind) {
        case 'message':
          out.push(await ingestMessage(db, connection, event, opts));
          break;
        case 'status':
          out.push(await ingestStatus(db, event));
          break;
        case 'reaction':
          out.push(await ingestReaction(db, connection, event, opts));
          break;
        default:
          out.push({
            status: 'skipped',
            event,
            reason: `${event.kind} events are not handled yet`,
          });
      }
    } catch (err) {
      console.error('[ingest] unexpected error:', err);
      out.push({ status: 'skipped', event, reason: 'unexpected error' });
    }
  }
  return out;
}

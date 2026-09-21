import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { resolveOrCreateContact, type ContactRow } from './identity';
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
 * Extension points (`IngestHooks`) are where later stories plug in without
 * changing this file's contract:
 *   - `resolveMedia`  -> US-021 (mirror media through `provider.downloadMedia`)
 *   - `onConversationCreated` / `onMessageStored` -> US-020 / US-074 (fan-out
 *     to automations, flows, AI and outbound webhooks)
 * `status` and `reaction` events are US-021; here they are reported as
 * `skipped` so a caller can hand over a whole parse result.
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

/** Keep `contacts.wa_parent_user_id` filled (US-070 removes the column). */
async function backfillParent(
  db: SupabaseClient,
  contact: ContactRow,
  parent: string | undefined
): Promise<ContactRow> {
  if (!parent || parent === contact.wa_parent_user_id) return contact;
  const { data, error } = await db
    .from('contacts')
    .update({ wa_parent_user_id: parent, updated_at: new Date().toISOString() })
    .eq('id', contact.id)
    .select()
    .maybeSingle();
  if (error) {
    console.error('[ingest] parent BSUID backfill failed:', error.message);
    return contact;
  }
  return (data as ContactRow | null) ?? contact;
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
  const accountId = connection.account_id;

  const outcome = await resolveOrCreateContact(db, {
    accountId,
    candidates: event.sender,
    senderName: event.senderName,
    auditUserId: opts.auditUserId,
  });
  if (!outcome) return skip('no contact');
  const contact = await backfillParent(
    db,
    outcome.contact,
    event.parentExternalId
  );

  const conv = await findOrCreateConversation(
    db,
    accountId,
    opts.auditUserId,
    contact.id,
    connection.id
  );
  if (!conv) return skip('no conversation');
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
    if (event.kind !== 'message') {
      out.push({
        status: 'skipped',
        event,
        reason: `${event.kind} events are not handled yet`,
      });
      continue;
    }
    try {
      out.push(await ingestMessage(db, connection, event, opts));
    } catch (err) {
      console.error('[ingest] unexpected error:', err);
      out.push({ status: 'skipped', event, reason: 'unexpected error' });
    }
  }
  return out;
}

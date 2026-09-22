import { channelLog, connCtx } from './log';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { buildWebhookOrigin } from '@/lib/webhooks/origin';
import { supabaseAdmin } from './admin-client';
import type { IngestContext, IngestedMessage } from './ingest';

/**
 * Inbound fan-out (US-020): what runs after a NEW inbound message was stored.
 * Reproduces, in the same order and with the same arguments, what the
 * WhatsApp webhook does today after persisting a message:
 *
 *   1. flows        dispatchInboundToFlows   (yields `consumed`)
 *   2. automations  runAutomationsForTrigger, one call per trigger, in order:
 *                   first_inbound_message, new_contact_created (when they
 *                   apply), then new_message_received, keyword_match and
 *                   interactive_reply (only when NO flow consumed the message)
 *   3. AI reply     dispatchInboundToAiReply (plain text only, not consumed)
 *
 * Everything is awaited, never fire-and-forget: the caller runs inside
 * `after()`, which only keeps the function alive for promises it can see.
 * Each engine is isolated: one that throws is logged (`[channel:fanout]`) and
 * the others still run; the stored message is never affected.
 *
 * US-074 adds, around that sequence (same as the webhook route):
 *   0. flagBroadcastReplyIfAny  (before flows; every new inbound, first or not)
 *   4. outbound `message.received` webhook (after the AI reply, awaited)
 * `conversation.created` is NOT emitted here: it fires from the ingestion's
 * `onConversationCreated` hook (see `conversationCreatedHook`), before the
 * message, as the route does. The route creates no server-side notifications
 * on inbound (lib/notifications is browser-only), so there is nothing to add.
 */

export interface FanoutOptions {
  /** Account owner: the flow runner and AI reply act on their behalf. */
  configOwnerUserId: string;
}

async function isolated<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    channelLog('error', {}, `fanout ${name} failed`, { error: err });
    return null;
  }
}

export async function fanOutInbound(
  stored: IngestedMessage,
  opts: FanoutOptions
): Promise<void> {
  const accountId = stored.connection.account_id;
  const contactId = stored.contact.id;
  const conversationId = stored.conversation.id;
  const externalId = stored.event.externalId;
  const interactiveReplyId = stored.interactiveReplyId;
  const text = stored.contentText;

  // 0. If this contact was a recent broadcast recipient, flag the reply.
  await isolated('broadcast reply flag', () =>
    flagBroadcastReplyIfAny(accountId, contactId)
  );

  // 1. Flows. A failure counts as "not consumed" so automations still run.
  const flowResult = await isolated('flows', () =>
    dispatchInboundToFlows({
      accountId,
      userId: opts.configOwnerUserId,
      contactId,
      conversationId,
      message: interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: interactiveReplyId,
            reply_title: text ?? '',
            meta_message_id: externalId,
          }
        : {
            kind: 'text',
            text: text ?? '',
            meta_message_id: externalId,
          },
      isFirstInboundMessage: stored.isFirstInbound,
    })
  );
  const flowConsumed = flowResult?.consumed === true;

  // 2. Automations.
  const triggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];
  if (!flowConsumed) {
    triggers.push('new_message_received', 'keyword_match');
    if (interactiveReplyId) triggers.push('interactive_reply');
  }
  if (stored.contactCreated) triggers.unshift('new_contact_created');
  if (stored.isFirstInbound) triggers.unshift('first_inbound_message');

  const inboundText = text ?? '';
  for (const triggerType of triggers) {
    await isolated(`automation ${triggerType}`, () =>
      runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId,
        context: {
          message_text: inboundText,
          conversation_id: conversationId,
          interactive_reply_id: interactiveReplyId ?? undefined,
        },
      })
    );
  }

  // 3. AI auto-reply: plain text a flow did not consume.
  if (!flowConsumed && !interactiveReplyId && inboundText.trim()) {
    await isolated('ai reply', () =>
      dispatchInboundToAiReply({
        accountId,
        conversationId,
        contactId,
        configOwnerUserId: opts.configOwnerUserId,
        inboundMessageId: externalId,
      })
    );
  }

  // 4. Outbound `message.received` webhook (public API). Awaited; the payload
  // keeps today's fields and adds the origin (connection, store, channel, contact).
  await isolated('message.received webhook', async () => {
    const admin = supabaseAdmin();
    await dispatchWebhookEvent(admin, accountId, 'message.received', {
      conversation_id: conversationId,
      contact_id: contactId,
      whatsapp_message_id: externalId,
      external_message_id: externalId,
      content_type: stored.contentType,
      text: text,
      ...(await buildWebhookOrigin(admin, stored.connection, contactId)),
    });
  });
}

/**
 * Marks the contact's most recent sent/delivered/read broadcast recipient as
 * `replied` (advances the broadcast's `replied_count` via the aggregate
 * trigger). Best-effort: errors are logged, never thrown.
 */
export async function flagBroadcastReplyIfAny(
  accountId: string,
  contactId: string
): Promise<void> {
  try {
    const { data: recs, error } = await supabaseAdmin()
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return;

    const { error: updErr } = await supabaseAdmin()
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', recs[0].id);

    if (updErr) {
      channelLog('error', {}, 'fanout marking recipient replied failed', {
        error: updErr,
      });
    }
  } catch (err) {
    channelLog('error', {}, 'fanout flagBroadcastReplyIfAny failed', {
      error: err,
    });
  }
}

/** Ready-made `IngestHooks.onConversationCreated`: emits `conversation.created`. */
export async function conversationCreatedHook(
  ctx: IngestContext
): Promise<void> {
  try {
    const admin = supabaseAdmin();
    await dispatchWebhookEvent(
      admin,
      ctx.connection.account_id,
      'conversation.created',
      {
        conversation_id: ctx.conversation.id,
        contact_id: ctx.contact.id,
        ...(await buildWebhookOrigin(admin, ctx.connection, ctx.contact.id)),
      }
    );
  } catch (err) {
    channelLog(
      'error',
      connCtx(ctx.connection),
      'conversation.created webhook failed',
      { error: err }
    );
  }
}

/** Ready-made `IngestHooks.onMessageStored`. */
export function fanoutHook(opts: FanoutOptions) {
  return (stored: IngestedMessage) => fanOutInbound(stored, opts);
}

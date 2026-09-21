import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import type { IngestedMessage } from './ingest';

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
 * SEAM (US-074): `flagBroadcastReplyIfAny` (before flows) and the outbound
 * `message.received` webhook / notifications (after the AI reply) belong to
 * this same sequence but are NOT done here yet. Add them at the marked spots.
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
    console.error(`[channel:fanout] ${name} failed:`, err);
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

  // SEAM (US-074): flagBroadcastReplyIfAny(accountId, contactId) goes here.

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

  // SEAM (US-074): outbound `message.received` webhook and notifications.
}

/** Ready-made `IngestHooks.onMessageStored`. */
export function fanoutHook(opts: FanoutOptions) {
  return (stored: IngestedMessage) => fanOutInbound(stored, opts);
}

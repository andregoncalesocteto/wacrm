import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONSENT_PURPOSES,
  hasConsent,
  type ConsentPurpose,
} from '@/lib/consent/consent';
import { resolveNotificationConnection } from '@/lib/stores/notification-connection';
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation';

/**
 * Gate in front of every automation step that sends to the customer.
 *
 *  1. CONSENT of the step's purpose (`hasConsent`: an explicit decision wins,
 *     otherwise writing to us once is implicit consent). No consent: the step
 *     is ignored, never failed, and nothing is sent.
 *  2. CONVERSATION: a run that carries a store (`store_id`, set by the direct
 *     events) but no conversation gets one here, on the store's notification
 *     connection, born CLOSED (no attendant work until the customer answers;
 *     `reopenClosedConversation` reopens it). Runs with a conversation, and
 *     runs without a store, are untouched.
 *
 * A step with no declared purpose is `marketing`, the strictest one.
 * Reasons never carry the phone number (they go to the automation log).
 */

export const DEFAULT_CONSENT_PURPOSE: ConsentPurpose = 'marketing';

export function isConsentPurpose(v: unknown): v is ConsentPurpose {
  return (CONSENT_PURPOSES as readonly string[]).includes(v as string);
}

/** The purpose a step declares, or the strict default. */
export function stepConsentPurpose(declared: unknown): ConsentPurpose {
  return isConsentPurpose(declared) ? declared : DEFAULT_CONSENT_PURPOSE;
}

export type SendGateResult =
  | { ok: true; conversationId: string | null; connectionId: string | null }
  | { ok: false; reason: string };

export async function gateSend(
  db: SupabaseClient,
  args: {
    accountId: string;
    userId: string;
    contactId: string;
    purpose: ConsentPurpose;
    conversationId?: string | null;
    storeId?: string | null;
  }
): Promise<SendGateResult> {
  const { accountId, contactId, purpose } = args;
  if (!args.conversationId && !args.storeId) {
    // Nothing to send on and no store to open one from: the step's own
    // conversation resolution fails visibly (legacy behaviour) and nothing is
    // sent, consent or not.
    const { data, error } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .limit(1);
    if (error) throw new Error(`conversation lookup failed: ${error.message}`);
    if (!data || data.length === 0) {
      return { ok: true, conversationId: null, connectionId: null };
    }
  }
  // The connection that will send: the step's conversation, or else the
  // store's notification connection (implicit consent is scoped to it).
  let sendConnectionId: string | null = null;
  if (args.conversationId) {
    const { data, error } = await db
      .from('conversations')
      .select('connection_id')
      .eq('account_id', accountId)
      .eq('id', args.conversationId)
      .maybeSingle();
    if (error) throw new Error(`conversation lookup failed: ${error.message}`);
    sendConnectionId =
      (data as { connection_id: string | null } | null)?.connection_id ?? null;
  } else if (args.storeId) {
    const c = await resolveNotificationConnection(db, accountId, args.storeId);
    if (c.ok) sendConnectionId = c.connectionId;
  }
  if (
    !(await hasConsent(db, accountId, contactId, purpose, {
      connectionId: sendConnectionId,
    }))
  ) {
    return { ok: false, reason: `sem consentimento: ${purpose}` };
  }
  if (args.conversationId) {
    return {
      ok: true,
      conversationId: args.conversationId,
      connectionId: null,
    };
  }
  if (!args.storeId) {
    return { ok: true, conversationId: null, connectionId: null };
  }
  const conn = await resolveNotificationConnection(db, accountId, args.storeId);
  if (!conn.ok) {
    return {
      ok: false,
      reason: `sem conexão de avisos da loja (${conn.reason})`,
    };
  }
  const conversationId = await findOrCreateConversationRow(
    db,
    accountId,
    contactId,
    args.userId,
    conn.connectionId,
    'closed'
  );
  return { ok: true, conversationId, connectionId: conn.connectionId };
}

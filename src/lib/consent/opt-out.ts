import type { SupabaseClient } from '@supabase/supabase-js';
import { CONSENT_PURPOSES, recordConsent } from './consent';

/**
 * "PARAR" in the chat: the customer asks to stop receiving messages. Channel
 * agnostic (the core never imports a channel module).
 *
 * Detection (`isOptOutText`) is deliberately strict: the WHOLE message, once
 * trimmed, lower-cased, stripped of accents and of punctuation/emoji at both
 * ends, must equal one of `OPT_OUT_WORDS`. A sentence that merely contains a
 * word ("nao quero parar de receber", "preciso parar o pedido") does not
 * trigger, because revoking consent by mistake silences order notices.
 *
 * `cancelar` alone is NOT in the list: it is how customers cancel an ORDER.
 * Only the explicit `cancelar envio` / `cancelar mensagens` forms are.
 */
export const OPT_OUT_WORDS = [
  'parar',
  'pare',
  'parar mensagens',
  'stop',
  'sair',
  'cancelar envio',
  'cancelar mensagens',
  'nao quero receber',
  'nao quero mais receber',
  'descadastrar',
  'unsubscribe',
  '수신거부',
];

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');

const OPT_OUT_SET = new Set(OPT_OUT_WORDS.map(normalize));

export function isOptOutText(text: string | null | undefined): boolean {
  if (!text) return false;
  return OPT_OUT_SET.has(normalize(text));
}

/** Source stored with the revocation: "customer, in the chat". */
export const CHAT_CONSENT_SOURCE = 'chat';

/**
 * Revoke BOTH purposes at `at` (the message instant), source `chat`. Uses
 * `recordConsent`, so only a strictly newer explicit grant reactivates it and
 * a replay of the same message changes nothing. Returns whether anything changed.
 */
export async function revokeConsentFromChat(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; at: Date }
): Promise<boolean> {
  let changed = false;
  for (const purpose of CONSENT_PURPOSES) {
    const applied = await recordConsent(db, {
      ...args,
      purpose,
      granted: false,
      source: CHAT_CONSENT_SOURCE,
    });
    changed = changed || applied;
  }
  return changed;
}

/** Confirmation text for the deployment locale (`NEXT_PUBLIC_APP_LOCALE`), English fallback. */
export async function loadOptOutConfirmation(
  locale: string | undefined = process.env.NEXT_PUBLIC_APP_LOCALE
): Promise<string> {
  type Catalog = { Contacts: { consents: { optOutConfirmation: string } } };
  let messages: Catalog;
  try {
    messages = (await import(`../../../messages/${locale || 'en'}.json`))
      .default;
  } catch {
    messages = (await import('../../../messages/en.json')).default;
  }
  return messages.Contacts.consents.optOutConfirmation;
}

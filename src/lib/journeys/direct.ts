import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findContact,
  resolveOrCreateContact,
  WA_PHONE_KIND,
  type ContactRow,
} from '@/lib/channels/identity';

/**
 * Direct events (no `idtrack`): who the customer is and whether they can be
 * messaged. Every query is filtered by `accountId` (service-role client).
 *
 * The phone goes through the SAME contact resolution as the WhatsApp webhook
 * and the public contacts API (`whatsapp:phone` identity, then the fuzzy phone
 * match, unique phone index as the race backstop). Nothing here invents a
 * second deduplication.
 */

/** `contacts.source` of a contact created by a direct event. */
export const MENU_CONTACT_SOURCE = 'menu';

/** `customer.phone` (E.164 with `+`) as the `whatsapp:phone` identity value. */
const phoneCandidate = (phone: string) => ({
  kind: WA_PHONE_KIND,
  externalId: phone.replace(/\D/g, ''),
});

/** Log-safe phone: only the last 4 digits (personal data never in clear). */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `***${digits.slice(-4)}`;
}

/** The account's contact behind this phone, or null. Never creates one. */
export async function findContactByPhone(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<ContactRow | null> {
  return findContact(db, accountId, [phoneCandidate(phone)]);
}

/**
 * The contact behind this phone, created when there is none: origin
 * "cardápio" (`source = 'menu'`) and the name the menu sent, if any. An
 * existing contact is returned untouched: its name is NEVER overwritten (no
 * name is handed to the shared resolver, which would backfill it).
 * Two simultaneous events for the same unknown phone end up on one contact
 * (the loser of the unique index re-reads the winner).
 */
export async function resolveDirectContact(
  db: SupabaseClient,
  args: {
    accountId: string;
    auditUserId: string;
    phone: string;
    name: string | null;
  }
): Promise<ContactRow> {
  const outcome = await resolveOrCreateContact(db, {
    accountId: args.accountId,
    auditUserId: args.auditUserId,
    candidates: [phoneCandidate(args.phone)],
  });
  if (!outcome) throw new Error('contact could not be resolved');
  if (!outcome.wasCreated) return outcome.contact;

  const { data, error } = await db
    .from('contacts')
    .update({
      source: MENU_CONTACT_SOURCE,
      ...(args.name ? { name: args.name } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', outcome.contact.id)
    .eq('account_id', args.accountId)
    .select()
    .maybeSingle();
  if (error) throw new Error(`contact source update failed: ${error.message}`);
  return (data as ContactRow | null) ?? outcome.contact;
}

/** The contact's conversation on a connection, or null (none yet). */
export async function findConversationId(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; connectionId: string | null }
): Promise<string | null> {
  if (!args.connectionId) return null;
  const { data, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('connection_id', args.connectionId)
    .maybeSingle();
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  return (data as { id: string } | null)?.id ?? null;
}

/** `messaging` of the events response. */
export type MessagingEligibility = 'eligible' | 'no_consent' | 'no_connection';

/** Whether the customer ever wrote to the CRM (any conversation of the account). */
async function hasWrittenToUs(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<boolean> {
  const { data: convs, error } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  if (error) throw new Error(`conversation lookup failed: ${error.message}`);
  const ids = ((convs ?? []) as { id: string }[]).map((c) => c.id);
  if (ids.length === 0) return false;
  const { data, error: msgErr } = await db
    .from('messages')
    .select('id')
    .in('conversation_id', ids)
    .eq('sender_type', 'customer')
    .limit(1);
  if (msgErr) throw new Error(`message lookup failed: ${msgErr.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * THE single place that decides `messaging`. Without the stored consent
 * (ticket #20 extends this function): no connection -> `no_connection`;
 * otherwise `eligible` when the customer already wrote to the CRM (implicit
 * consent, as today), else `no_consent`.
 */
export async function resolveMessagingEligibility(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; connectionId: string | null }
): Promise<MessagingEligibility> {
  if (!args.connectionId) return 'no_connection';
  return (await hasWrittenToUs(db, args.accountId, args.contactId))
    ? 'eligible'
    : 'no_consent';
}

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONTACT_IDENTITIES_EMBED,
  contactDisplayName,
  identitiesFromRows,
  isWhatsAppReachable,
  type RawContactIdentity,
} from '@/lib/contacts/display-name';

/**
 * Broadcasts go out as WhatsApp templates, so only contacts reachable on
 * WhatsApp are eligible (US-053). Client-safe; pure except for the fetcher.
 */

type EligibilityRow = {
  id: string;
  name?: string | null;
  phone?: string | null;
  wa_username?: string | null;
  wa_user_id?: string | null;
  contact_identities?: RawContactIdentity[] | null;
};

export function isBroadcastEligible(row: EligibilityRow): boolean {
  return isWhatsAppReachable(row, identitiesFromRows(row.contact_identities));
}

/** Splits contact rows (with the identities embed) into eligible / not. */
export function partitionBroadcastAudience<T extends EligibilityRow>(
  rows: T[]
): { eligible: T[]; ineligible: T[] } {
  const eligible: T[] = [];
  const ineligible: T[] = [];
  for (const row of rows) {
    (isBroadcastEligible(row) ? eligible : ineligible).push(row);
  }
  return { eligible, ineligible };
}

export type IneligibleContact = { id: string; label: string };

/** Display label for a contact row carrying the identities embed. */
export function eligibilityLabel(row: EligibilityRow): string {
  return contactDisplayName(row, identitiesFromRows(row.contact_identities));
}

/**
 * Contacts of the account that cannot receive a broadcast. Only contacts with
 * an empty phone can be ineligible (`phone` is NOT NULL, '' = none), so the
 * query stays small: those rows plus their identities, then the predicate.
 */
export async function fetchIneligibleContacts(
  supabase: SupabaseClient
): Promise<IneligibleContact[]> {
  const { data, error } = await supabase
    .from('contacts')
    .select(
      `id, name, phone, wa_username, wa_user_id, ${CONTACT_IDENTITIES_EMBED}`
    )
    .eq('phone', '');
  if (error || !data) return [];
  return partitionBroadcastAudience(data as EligibilityRow[]).ineligible.map(
    (row) => ({ id: row.id, label: eligibilityLabel(row) })
  );
}

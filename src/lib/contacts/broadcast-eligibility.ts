import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelType, Capabilities } from '@/lib/channels/types';
import {
  CONTACT_IDENTITIES_EMBED,
  contactDisplayName,
  identitiesFromRows,
  identityChannelType,
  isWhatsAppReachable,
  type RawContactIdentity,
} from '@/lib/contacts/display-name';

/**
 * Eligibility depends on the connection a broadcast goes out on, not just on
 * WhatsApp (US-006): `capabilities.initiate === 'template'` channels keep the
 * old "has an identity of that channel" rule (US-053); other channels
 * (Telegram, `after_inbound`/`free`) need an existing `conversations` row for
 * that SPECIFIC `connection_id` — a contact who only talked to one bot is not
 * reachable by another bot of the same channel_type. Client-safe; pure except
 * for the fetcher.
 */
export interface BroadcastConnectionContext {
  connectionId: string;
  channelType: ChannelType;
  initiate: Capabilities['initiate'];
}

type EligibilityRow = {
  id: string;
  name?: string | null;
  phone?: string | null;
  contact_identities?: RawContactIdentity[] | null;
  /**
   * Non-template channels only: whether a `conversations` row exists for this
   * contact and the connection being evaluated. Populated by the fetcher
   * before partitioning — `isBroadcastEligible` itself stays sync/pure.
   */
  hasConversationWithConnection?: boolean;
};

/** `capabilities.initiate === 'template'` eligibility: has an identity of that channel (any connection). */
function isTemplateEligible(row: EligibilityRow, channelType: ChannelType): boolean {
  if (channelType === 'whatsapp_cloud') {
    return isWhatsAppReachable(row, identitiesFromRows(row.contact_identities));
  }
  return identitiesFromRows(row.contact_identities).some(
    (i) => identityChannelType(i.kind) === channelType
  );
}

export function isBroadcastEligible(
  row: EligibilityRow,
  connection: BroadcastConnectionContext
): boolean {
  if (connection.initiate === 'template') {
    return isTemplateEligible(row, connection.channelType);
  }
  return !!row.hasConversationWithConnection;
}

/** Splits contact rows (with the identities embed) into eligible / not. */
export function partitionBroadcastAudience<T extends EligibilityRow>(
  rows: T[],
  connection: BroadcastConnectionContext
): { eligible: T[]; ineligible: T[] } {
  const eligible: T[] = [];
  const ineligible: T[] = [];
  for (const row of rows) {
    (isBroadcastEligible(row, connection) ? eligible : ineligible).push(row);
  }
  return { eligible, ineligible };
}

export type IneligibleContact = { id: string; label: string };

/** Display label for a contact row carrying the identities embed. */
export function eligibilityLabel(row: EligibilityRow): string {
  return contactDisplayName(row, identitiesFromRows(row.contact_identities));
}

/** PostgREST caps `.in(...)` around 1000 values — page through, like fetchCustomValueIndex. */
const CONTACT_ID_PAGE = 500;

/** Contact ids (of `contactIds`) that have a `conversations` row for `connectionId`. */
async function fetchConversationContactIds(
  supabase: SupabaseClient,
  connectionId: string,
  contactIds: string[]
): Promise<Set<string>> {
  const reachable = new Set<string>();
  for (let i = 0; i < contactIds.length; i += CONTACT_ID_PAGE) {
    const slice = contactIds.slice(i, i + CONTACT_ID_PAGE);
    const { data } = await supabase
      .from('conversations')
      .select('contact_id')
      .eq('connection_id', connectionId)
      .in('contact_id', slice);
    for (const row of data ?? []) reachable.add(row.contact_id);
  }
  return reachable;
}

/**
 * Contacts of the account that cannot receive a broadcast on `connection`.
 *
 * `capabilities.initiate === 'template'`: only contacts with an empty phone
 * can be ineligible (`phone` is NOT NULL, '' = none, US-053), so the query
 * stays small. Other channels: phone is irrelevant — eligibility depends only
 * on an existing conversation with THIS connection, so every contact has to
 * be checked.
 */
export async function fetchIneligibleContacts(
  supabase: SupabaseClient,
  connection: BroadcastConnectionContext
): Promise<IneligibleContact[]> {
  if (connection.initiate === 'template') {
    const { data, error } = await supabase
      .from('contacts')
      .select(`id, name, phone, ${CONTACT_IDENTITIES_EMBED}`)
      .eq('phone', '');
    if (error || !data) return [];
    return partitionBroadcastAudience(
      data as EligibilityRow[],
      connection
    ).ineligible.map((row) => ({ id: row.id, label: eligibilityLabel(row) }));
  }

  const { data, error } = await supabase
    .from('contacts')
    .select(`id, name, phone, ${CONTACT_IDENTITIES_EMBED}`);
  if (error || !data) return [];
  const reachable = await fetchConversationContactIds(
    supabase,
    connection.connectionId,
    data.map((row) => row.id)
  );
  const rows = (data as EligibilityRow[]).map((row) => ({
    ...row,
    hasConversationWithConnection: reachable.has(row.id),
  }));
  return partitionBroadcastAudience(rows, connection).ineligible.map(
    (row) => ({ id: row.id, label: eligibilityLabel(row) })
  );
}

import { channelLog } from './log';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { sortIdentities } from '@/lib/contacts/display-name';
import type { ContactIdentity, IdentityCandidate } from './types';

/**
 * Channel-agnostic contact resolution (US-018).
 *
 * The provider hands us identity CANDIDATES (`whatsapp:phone`,
 * `whatsapp:bsuid`, `whatsapp:username`, `telegram:chat_id`, ...); this
 * module finds the contact behind ANY of them, or creates one carrying all of
 * them. `contact_identities` (UNIQUE (account_id, kind, external_id)) is the
 * source of truth. During the strangler transition it is only partially
 * populated by old code, so a miss falls back to the legacy columns
 * (`contacts.wa_user_id`, the fuzzy phone match) and the legacy columns are
 * still backfilled so the old code paths keep working.
 *
 * `db` must be a service-role client (webhook / engines have no user session).
 */

// Pure display helpers live in a client-safe module; re-exported for old imports.
export { contactDisplayName } from '@/lib/contacts/display-name';

export const WA_PHONE_KIND = 'whatsapp:phone';
export const WA_BSUID_KIND = 'whatsapp:bsuid';
export const WA_USERNAME_KIND = 'whatsapp:username';

export type ContactRow = Record<string, unknown> & {
  id: string;
  phone?: string | null;
  name?: string | null;
  wa_user_id?: string | null;
  wa_username?: string | null;
};

export interface ResolveContactInput {
  accountId: string;
  candidates: IdentityCandidate[];
  /** Profile name the channel supplied, if any (never a fallback label). */
  senderName?: string | null;
  /** NOT NULL audit column `contacts.user_id`. */
  auditUserId: string;
  /**
   * Portfolio-level BSUID, kept in `contacts.wa_parent_user_id` (no identity
   * kind; US-070 removes the column). Written with the same INSERT / backfill
   * UPDATE as the other legacy columns.
   */
  parentExternalId?: string;
}

export interface ResolveContactOutcome {
  contact: ContactRow;
  wasCreated: boolean;
}

function clean(candidates: IdentityCandidate[]): IdentityCandidate[] {
  const seen = new Set<string>();
  const out: IdentityCandidate[] = [];
  for (const c of candidates) {
    const externalId = c.externalId?.trim();
    if (!c.kind || !externalId) continue;
    const key = `${c.kind}\u0000${externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, externalId });
  }
  return out;
}

function byKind(candidates: IdentityCandidate[], kind: string) {
  return candidates.find((c) => c.kind === kind);
}

function usernameOf(c: IdentityCandidate | undefined): string | null {
  if (!c) return null;
  const v = (c.handle ?? c.externalId).trim().replace(/^@/, '');
  return v || null;
}

/** Name for a brand-new contact row: profile name, else username, phone, BSUID, id. */
function newContactName(
  candidates: IdentityCandidate[],
  senderName?: string | null
): string {
  if (senderName?.trim()) return senderName.trim();
  const first = sortIdentities(candidates)[0];
  if (!first) return '';
  if (first.kind.endsWith(':username')) return usernameOf(first) ?? '';
  return first.externalId;
}

/** Contact lookups by identity, then by the legacy columns. */
async function findContact(
  db: SupabaseClient,
  accountId: string,
  candidates: IdentityCandidate[]
): Promise<ContactRow | null> {
  if (candidates.length === 0) return null;

  const { data: rows, error } = await db
    .from('contact_identities')
    .select('*')
    .eq('account_id', accountId)
    .in(
      'external_id',
      candidates.map((c) => c.externalId)
    );
  if (error) {
    channelLog('error', {}, 'identity lookup failed', { error });
  } else if (rows) {
    for (const c of candidates) {
      const hit = (rows as Record<string, unknown>[]).find(
        (r) => r.kind === c.kind && r.external_id === c.externalId
      );
      if (!hit) continue;
      const { data: contact } = await db
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .eq('id', hit.contact_id as string)
        .maybeSingle();
      if (contact) return contact as ContactRow;
    }
  }

  // Legacy fallback: BSUID column first (stable key), then the fuzzy phone.
  const bsuid = byKind(candidates, WA_BSUID_KIND);
  if (bsuid) {
    const { data, error: e } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .eq('wa_user_id', bsuid.externalId)
      .maybeSingle();
    if (e) channelLog('error', {}, 'BSUID lookup failed', { error: e });
    if (data) return data as ContactRow;
  }
  const phone = byKind(candidates, WA_PHONE_KIND);
  if (phone) {
    const found = await findExistingContact(db, accountId, phone.externalId);
    if (found) return found as ContactRow;
  }
  return null;
}

/** Insert the identities, leaving any that already exist (any contact) alone. */
async function addIdentities(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  candidates: IdentityCandidate[]
): Promise<void> {
  if (candidates.length === 0) return;
  const { error } = await db.from('contact_identities').upsert(
    candidates.map((c) => ({
      account_id: accountId,
      contact_id: contactId,
      kind: c.kind,
      external_id: c.externalId,
      handle: c.handle ?? null,
    })),
    { onConflict: 'account_id,kind,external_id', ignoreDuplicates: true }
  );
  if (error) channelLog('error', {}, 'adding identities failed', { error });
}

/**
 * Legacy-column backfill, same rules as the webhook's `contactIdentityPatch`:
 * only a name the channel supplied (never clobber a hand-edited one with a
 * fallback label), BSUID / username when changed, phone only to fill a blank.
 */
function legacyPatch(
  existing: ContactRow,
  candidates: IdentityCandidate[],
  senderName?: string | null,
  parentExternalId?: string
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const username = usernameOf(byKind(candidates, WA_USERNAME_KIND));
  const bsuid = byKind(candidates, WA_BSUID_KIND)?.externalId;
  const phone = byKind(candidates, WA_PHONE_KIND)?.externalId;

  const name = senderName?.trim() || username;
  if (name && name !== existing.name) patch.name = name;
  if (bsuid && bsuid !== existing.wa_user_id) patch.wa_user_id = bsuid;
  if (username && username !== existing.wa_username) {
    patch.wa_username = username;
  }
  if (phone && !normalizePhone(existing.phone ?? '')) patch.phone = phone;
  if (parentExternalId && parentExternalId !== existing.wa_parent_user_id) {
    patch.wa_parent_user_id = parentExternalId;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Find the contact behind ANY candidate, or create one with all of them.
 * A contact matched by one candidate gains the candidates it did not have.
 * Returns null only when there is nothing to key on or the DB failed.
 */
export async function resolveOrCreateContact(
  db: SupabaseClient,
  input: ResolveContactInput
): Promise<ResolveContactOutcome | null> {
  const { accountId, senderName, auditUserId, parentExternalId } = input;
  const candidates = clean(input.candidates);
  if (candidates.length === 0) return null;

  const existing = await findContact(db, accountId, candidates);
  if (existing)
    return {
      contact: await enrich(
        db,
        accountId,
        existing,
        candidates,
        senderName,
        parentExternalId
      ),
      wasCreated: false,
    };

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      // NOT NULL DEFAULT '': blank for senders with no phone.
      phone: byKind(candidates, WA_PHONE_KIND)?.externalId ?? '',
      name: newContactName(candidates, senderName),
      wa_user_id: byKind(candidates, WA_BSUID_KIND)?.externalId ?? null,
      wa_username: usernameOf(byKind(candidates, WA_USERNAME_KIND)),
      ...(parentExternalId && { wa_parent_user_id: parentExternalId }),
    })
    .select()
    .single();

  if (error || !created) {
    // Lost a race (unique phone / BSUID index): re-read the winner.
    if (isUniqueViolation(error)) {
      const raced = await findContact(db, accountId, candidates);
      if (raced) {
        return {
          contact: await enrich(
            db,
            accountId,
            raced,
            candidates,
            senderName,
            parentExternalId
          ),
          wasCreated: false,
        };
      }
    }
    channelLog('error', {}, 'error creating contact', { error });
    return null;
  }

  await addIdentities(db, accountId, (created as ContactRow).id, candidates);
  return { contact: created as ContactRow, wasCreated: true };
}

/** Attach new identities to a matched contact and backfill legacy columns. */
async function enrich(
  db: SupabaseClient,
  accountId: string,
  contact: ContactRow,
  candidates: IdentityCandidate[],
  senderName?: string | null,
  parentExternalId?: string
): Promise<ContactRow> {
  await addIdentities(db, accountId, contact.id, candidates);

  const patch = legacyPatch(contact, candidates, senderName, parentExternalId);
  if (!patch) return contact;
  const { data: updated, error } = await db
    .from('contacts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', contact.id)
    .select()
    .maybeSingle();
  if (error) {
    // e.g. a BSUID already claimed by another row: not fatal.
    channelLog('error', {}, 'contact backfill failed', { error });
    return contact;
  }
  return (updated as ContactRow | null) ?? contact;
}

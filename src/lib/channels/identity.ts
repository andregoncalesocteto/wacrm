import { channelLog } from './log';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { sortIdentities } from '@/lib/contacts/display-name';
import type { IdentityCandidate } from './types';

/**
 * Channel-agnostic contact resolution (US-018).
 *
 * The provider hands us identity CANDIDATES (`whatsapp:phone`,
 * `whatsapp:bsuid`, `whatsapp:username`, `telegram:chat_id`, ...); this
 * module finds the contact behind ANY of them, or creates one carrying all of
 * them. `contact_identities` (UNIQUE (account_id, kind, external_id)) is the
 * source of truth; a miss falls back to the fuzzy phone match.
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
};

export interface ResolveContactInput {
  accountId: string;
  candidates: IdentityCandidate[];
  /** Profile name the channel supplied, if any (never a fallback label). */
  senderName?: string | null;
  /** NOT NULL audit column `contacts.user_id`. */
  auditUserId: string;
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

/** Contact lookups by identity, then by the fuzzy phone match. */
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

  // Fallback: the fuzzy phone match (contacts created without identities).
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
 * Contact backfill: only a name the channel supplied (never clobber a
 * hand-edited one with a fallback label), phone only to fill a blank.
 */
function legacyPatch(
  existing: ContactRow,
  candidates: IdentityCandidate[],
  senderName?: string | null
): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const username = usernameOf(byKind(candidates, WA_USERNAME_KIND));
  const phone = byKind(candidates, WA_PHONE_KIND)?.externalId;

  const name = senderName?.trim() || username;
  if (name && name !== existing.name) patch.name = name;
  if (phone && !normalizePhone(existing.phone ?? '')) patch.phone = phone;

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
  const { accountId, senderName, auditUserId } = input;
  const candidates = clean(input.candidates);
  if (candidates.length === 0) return null;

  const existing = await findContact(db, accountId, candidates);
  if (existing)
    return {
      contact: await enrich(db, accountId, existing, candidates, senderName),
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
    })
    .select()
    .single();

  if (error || !created) {
    // Lost a race (unique phone index): re-read the winner.
    if (isUniqueViolation(error)) {
      const raced = await findContact(db, accountId, candidates);
      if (raced) {
        return {
          contact: await enrich(db, accountId, raced, candidates, senderName),
          wasCreated: false,
        };
      }
    }
    channelLog('error', {}, 'error creating contact', { error });
    return null;
  }

  const createdId = (created as ContactRow).id;
  await addIdentities(db, accountId, createdId, candidates);

  // Only the phone is unique on `contacts`: two concurrent first messages from
  // a sender with no phone (BSUID / Telegram) can both get here. The identity
  // unique index picked one winner; ours is the duplicate, so drop it and
  // continue with the winner.
  const { data: owned } = await db
    .from('contact_identities')
    .select('contact_id, kind, external_id')
    .eq('account_id', accountId)
    .in(
      'external_id',
      candidates.map((c) => c.externalId)
    );
  const rival = ((owned as Record<string, unknown>[] | null) ?? []).find(
    (r) =>
      r.contact_id !== createdId &&
      candidates.some((c) => c.kind === r.kind && c.externalId === r.external_id)
  );
  if (rival) {
    await db.from('contacts').delete().eq('id', createdId);
    const winner = await findContact(db, accountId, candidates);
    if (winner) {
      return {
        contact: await enrich(db, accountId, winner, candidates, senderName),
        wasCreated: false,
      };
    }
  }
  return { contact: created as ContactRow, wasCreated: true };
}

/** Attach new identities to a matched contact and backfill name / phone. */
async function enrich(
  db: SupabaseClient,
  accountId: string,
  contact: ContactRow,
  candidates: IdentityCandidate[],
  senderName?: string | null
): Promise<ContactRow> {
  await addIdentities(db, accountId, contact.id, candidates);

  const patch = legacyPatch(contact, candidates, senderName);
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

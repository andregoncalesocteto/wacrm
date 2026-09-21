import type { SupabaseClient } from '@supabase/supabase-js';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { contactHandle } from '@/lib/whatsapp/wa-identity';
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

/** Lower rank = more recognisable to a human. */
function rank(kind: string, handle?: string | null): number {
  if (kind.endsWith(':username') || handle?.startsWith('@')) return 0;
  if (kind.endsWith(':phone')) return 1;
  if (kind.endsWith(':bsuid')) return 2;
  return 3;
}

function sorted<T extends { kind: string; handle?: string | null }>(
  list: T[]
): T[] {
  return [...list].sort(
    (a, b) => rank(a.kind, a.handle) - rank(b.kind, b.handle)
  );
}

/** How an identity reads to a person: `@username`, phone, BSUID, chat id. */
function identityLabel(i: ContactIdentity): string {
  if (i.kind.endsWith(':username')) {
    const u = (i.handle ?? i.externalId).trim().replace(/^@/, '');
    return u ? `@${u}` : '';
  }
  return (i.handle?.trim() || i.externalId).trim();
}

/**
 * Name to show for a contact: its own name, else the primary identity
 * (`@username`, phone, BSUID, Telegram handle / chat id), else the legacy
 * `wa_*` columns. Empty only when the contact carries no identity at all.
 * Generalises `contactHandle` (wa-identity.ts), which stays for old callers.
 */
export function contactDisplayName(
  contact: {
    name?: string | null;
    phone?: string | null;
    wa_username?: string | null;
    wa_user_id?: string | null;
  },
  identities: ContactIdentity[] = []
): string {
  if (contact.name?.trim()) return contact.name.trim();
  for (const i of sorted(identities)) {
    const label = identityLabel(i);
    if (label) return label;
  }
  return contactHandle(contact);
}

/** Name for a brand-new contact row: profile name, else username, phone, BSUID, id. */
function newContactName(
  candidates: IdentityCandidate[],
  senderName?: string | null
): string {
  if (senderName?.trim()) return senderName.trim();
  const first = sorted(candidates)[0];
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
    console.error('[identity] identity lookup failed:', error.message);
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
    if (e) console.error('[identity] BSUID lookup failed:', e.message);
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
  if (error)
    console.error('[identity] adding identities failed:', error.message);
}

/**
 * Legacy-column backfill, same rules as the webhook's `contactIdentityPatch`:
 * only a name the channel supplied (never clobber a hand-edited one with a
 * fallback label), BSUID / username when changed, phone only to fill a blank.
 */
function legacyPatch(
  existing: ContactRow,
  candidates: IdentityCandidate[],
  senderName?: string | null
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
      wa_user_id: byKind(candidates, WA_BSUID_KIND)?.externalId ?? null,
      wa_username: usernameOf(byKind(candidates, WA_USERNAME_KIND)),
    })
    .select()
    .single();

  if (error || !created) {
    // Lost a race (unique phone / BSUID index): re-read the winner.
    if (isUniqueViolation(error)) {
      const raced = await findContact(db, accountId, candidates);
      if (raced) {
        return {
          contact: await enrich(db, accountId, raced, candidates, senderName),
          wasCreated: false,
        };
      }
    }
    console.error('[identity] error creating contact:', error);
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
    console.error('[identity] contact backfill failed:', error.message);
    return contact;
  }
  return (updated as ContactRow | null) ?? contact;
}

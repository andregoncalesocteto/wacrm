import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizePhone, phonesMatch } from '@/lib/whatsapp/phone-utils';

/**
 * Contact de-duplication helpers, shared by the WhatsApp webhook, the
 * manual contact form, and CSV import so all paths agree on what
 * "same number" means (issue #212).
 *
 * The canonical key is `normalizePhone` (digits-only) — the same form
 * the DB stores in the generated `contacts.phone_normalized` column
 * and enforces unique per account. `phonesMatch` adds trunk-prefix
 * tolerance (last-8-digit match) for the softer "possible duplicate"
 * surfaces.
 */

/** Canonical de-dup key for a phone string (digits only). */
export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

/** Minimal shape we need back from a contacts lookup. */
export interface ExistingContact {
  id: string;
  phone: string;
  name?: string | null;
  /**
   * Set when the contact was found through a `whatsapp:phone` IDENTITY
   * (its `phone` column may be blank): the number that identity holds.
   */
  matchedPhone?: string;
  [key: string]: unknown;
}

/** Identity kind holding a WhatsApp phone number (see channels/identity.ts). */
const PHONE_IDENTITY_KIND = 'whatsapp:phone';

/**
 * Find an existing contact in `accountId` whose phone matches `phone`,
 * or null. Pre-filters in SQL by the last-8-digit suffix (so we don't
 * pull every contact), then applies the strict `phonesMatch` in JS on
 * the small candidate set — the exact approach the webhook has used.
 */
export async function findExistingContact(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const { data, error } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .like('phone', `%${suffix}`);

  if (error || !data) return null;

  return (
    (data as ExistingContact[]).find((c) => phonesMatch(c.phone, phone)) ?? null
  );
}

/**
 * Like `findExistingContact`, but looks at the `whatsapp:phone` IDENTITIES
 * (the source of truth): a contact whose `phone` column is blank but whose
 * identity holds this number is a duplicate too. Same last-8-digit
 * pre-filter + strict `phonesMatch`. The result carries `matchedPhone`.
 */
export async function findExistingContactByPhoneIdentity(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const { data, error } = await db
    .from('contact_identities')
    .select('contact_id, external_id')
    .eq('account_id', accountId)
    .eq('kind', PHONE_IDENTITY_KIND)
    .like('external_id', `%${suffix}`);
  if (error || !data) return null;

  const hit = (data as { contact_id: string; external_id: string }[]).find(
    (r) => phonesMatch(r.external_id, phone)
  );
  if (!hit) return null;

  const { data: contact } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('id', hit.contact_id)
    .maybeSingle();
  if (!contact) return null;
  return { ...(contact as ExistingContact), matchedPhone: hit.external_id };
}

/** Duplicate lookup for a phone: the contacts column first, then identities. */
export async function findDuplicateContact(
  db: SupabaseClient,
  accountId: string,
  phone: string
): Promise<ExistingContact | null> {
  return (
    (await findExistingContact(db, accountId, phone)) ??
    (await findExistingContactByPhoneIdentity(db, accountId, phone))
  );
}

/**
 * Record the `whatsapp:phone` identity of a manually created contact
 * (digits only, like the ingest), leaving an existing identity alone.
 */
export async function ensurePhoneIdentity(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  phone: string
): Promise<void> {
  const externalId = normalizePhone(phone);
  if (!externalId) return;
  const { error } = await db.from('contact_identities').upsert(
    {
      account_id: accountId,
      contact_id: contactId,
      kind: PHONE_IDENTITY_KIND,
      external_id: externalId,
    },
    { onConflict: 'account_id,kind,external_id', ignoreDuplicates: true }
  );
  if (error) {
    console.error('[dedupe] adding phone identity failed:', error.message);
  }
}

/** Rows per `in (...)` lookup / per identity upsert in the bulk helpers. */
const IDENTITY_BATCH = 100;

/**
 * Bulk form of the identity duplicate check, for CSV import: of the given
 * normalized (digits-only) phones, returns the ones some contact of the
 * account already holds as a `whatsapp:phone` identity. Chunked `in`
 * queries, so a large file costs a handful of reads instead of one per row.
 * Throws on a DB error (a silent miss would import duplicates).
 */
export async function findExistingPhoneIdentityKeys(
  db: SupabaseClient,
  accountId: string,
  keys: string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  const unique = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < unique.length; i += IDENTITY_BATCH) {
    const { data, error } = await db
      .from('contact_identities')
      .select('external_id')
      .eq('account_id', accountId)
      .eq('kind', PHONE_IDENTITY_KIND)
      .in('external_id', unique.slice(i, i + IDENTITY_BATCH));
    if (error) throw error;
    for (const r of (data ?? []) as { external_id: string }[]) {
      found.add(r.external_id);
    }
  }
  return found;
}

/**
 * Bulk `ensurePhoneIdentity` for freshly imported contacts: one chunked
 * upsert (ON CONFLICT DO NOTHING). Never throws — the contacts are already
 * saved; a failure is logged, like the single-row helper.
 */
export async function ensurePhoneIdentities(
  db: SupabaseClient,
  accountId: string,
  items: { contactId: string; phone: string }[]
): Promise<void> {
  const rows = items
    .map((it) => ({
      account_id: accountId,
      contact_id: it.contactId,
      kind: PHONE_IDENTITY_KIND,
      external_id: normalizePhone(it.phone),
    }))
    .filter((r) => r.external_id);
  for (let i = 0; i < rows.length; i += IDENTITY_BATCH) {
    const { error } = await db
      .from('contact_identities')
      .upsert(rows.slice(i, i + IDENTITY_BATCH), {
        onConflict: 'account_id,kind,external_id',
        ignoreDuplicates: true,
      });
    if (error) {
      console.error('[dedupe] adding phone identities failed:', error.message);
    }
  }
}

export type SyncPhoneIdentityResult =
  { ok: true } | { ok: false; conflictContactId: string };

/**
 * Keep the `whatsapp:phone` identity in step with an edited phone: ensure
 * the new number's identity and drop this contact's identity for the OLD
 * number, so the old number stops resolving to it. Cleared phone → identity
 * removed. Never steals: if another contact already holds the new number
 * as an identity, nothing is changed and `{ ok: false, conflictContactId }`
 * is returned. Call it BEFORE saving the contacts row so a conflict can
 * abort the edit. Throws on a DB error.
 */
export async function syncPhoneIdentity(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    oldPhone: string | null | undefined;
    newPhone: string | null | undefined;
  }
): Promise<SyncPhoneIdentityResult> {
  const { accountId, contactId } = args;
  const oldPhone = args.oldPhone ?? '';
  const newKey = normalizePhone(args.newPhone ?? '');
  const oldKey = normalizePhone(oldPhone);

  if (newKey) {
    const { data, error } = await db
      .from('contact_identities')
      .select('contact_id')
      .eq('account_id', accountId)
      .eq('kind', PHONE_IDENTITY_KIND)
      .eq('external_id', newKey)
      .maybeSingle();
    if (error) throw error;
    const owner = (data as { contact_id: string } | null)?.contact_id;
    if (owner && owner !== contactId) {
      return { ok: false, conflictContactId: owner };
    }
  }

  if (oldKey && oldKey !== newKey) {
    const { data, error } = await db
      .from('contact_identities')
      .select('external_id')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('kind', PHONE_IDENTITY_KIND);
    if (error) throw error;
    const stale = ((data ?? []) as { external_id: string }[])
      .map((r) => r.external_id)
      .filter((id) => id !== newKey && phonesMatch(id, oldPhone));
    for (const externalId of stale) {
      const { error: delError } = await db
        .from('contact_identities')
        .delete()
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('kind', PHONE_IDENTITY_KIND)
        .eq('external_id', externalId);
      if (delError) throw delError;
    }
  }

  if (newKey) await ensurePhoneIdentity(db, accountId, contactId, newKey);
  return { ok: true };
}

/**
 * True when an existing contact is an *exact* normalized match for
 * `phone` (vs only a fuzzy trunk-variant match). The form hard-blocks
 * exact matches but only warns on fuzzy ones.
 */
export function isExactMatch(
  existing: ExistingContact,
  phone: string
): boolean {
  return (
    normalizeKey(existing.matchedPhone ?? existing.phone) ===
    normalizeKey(phone)
  );
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used as the backstop when the DB unique index rejects a racing or
 * format-equal insert that slipped past the in-app check.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { code?: string }).code === '23505';
}

/**
 * De-duplicate parsed CSV rows by normalized phone, keeping the first
 * occurrence of each. Rows with an empty normalized phone can't be a
 * valid contact and are dropped too, but counted separately as
 * `invalid` rather than folded into `duplicates` — they never
 * duplicated anything, and the import result should say so instead of
 * telling the user a contact with a real, unique number was skipped
 * as a dupe.
 */
export function dedupeByPhone<T extends { phone: string }>(
  rows: T[]
): { unique: T[]; duplicates: number; invalid: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  let invalid = 0;

  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (!key) {
      invalid++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates, invalid };
}

// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Kept out of the route files so `GET/POST /api/v1/contacts` and
// `GET/PATCH /api/v1/contacts/{id}` share one serializer, one
// find-or-create (built on the same `findExistingContact` dedupe the
// webhook and send path use), and one tag-sync routine.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  ensurePhoneIdentity,
  findDuplicateContact,
  isUniqueViolation,
} from '@/lib/contacts/dedupe';
import { registerBuiltinProviders } from '@/lib/channels/providers';
import { listProviders } from '@/lib/channels/registry';
import { resolveOrCreateContact, WA_PHONE_KIND } from '@/lib/channels/identity';
import type { IdentityCandidate } from '@/lib/channels/types';
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

/** Row select that embeds the contact's tags for serialization. */
export const CONTACT_SELECT =
  '*, contact_tags(tags(*)), contact_identities(kind, external_id, handle)';

/** A contact identity on the public wire (snake_case). */
export interface ApiIdentity {
  kind: string;
  external_id: string;
  handle: string | null;
}

export interface ApiContact {
  id: string;
  /** `null` when the contact has no phone (e.g. a Telegram-only contact). */
  phone: string | null;
  identities: ApiIdentity[];
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

/** Thrown by the helpers below; routes map `.status`/`.message`. */
export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

type RawIdentity = {
  kind: string;
  external_id: string;
  handle?: string | null;
};

/** Public projection of embedded `contact_identities` rows. */
export function serializeIdentities(raw: unknown): ApiIdentity[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawIdentity[]).map((i) => ({
    kind: i.kind,
    external_id: i.external_id,
    handle: i.handle ?? null,
  }));
}

type RawTagJoin = { tags: { id: string; name: string; color: string } | null };

/** Flatten a `CONTACT_SELECT` row into the public contact shape. */
export function serializeContact(row: Record<string, unknown>): ApiContact {
  const joins = (row.contact_tags as RawTagJoin[] | undefined) ?? [];
  return {
    id: row.id as string,
    // The DB keeps '' for "no phone"; the API says null.
    phone: (row.phone as string | null) || null,
    identities: serializeIdentities(row.contact_identities),
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    tags: joins
      .map((j) => j.tags)
      .filter((t): t is NonNullable<RawTagJoin['tags']> => t != null)
      .map((t) => ({ id: t.id, name: t.name, color: t.color })),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Resolve the audit `user_id` for API-created rows — the SINGLE source
 * of truth used by every public-API write (contacts, messages,
 * broadcasts, resolve-conversation), so the same key's writes are
 * always attributed to the same human. API callers have no logged-in
 * user, so — like the inbound webhook — we attribute writes to the
 * **account owner** (channel connections carry no user).
 */
export async function resolveAuditUserId(
  db: SupabaseClient,
  accountId: string
): Promise<string> {
  const { data: account } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  const owner = account?.owner_user_id as string | undefined;
  if (!owner) {
    throw new ContactError('Account owner could not be resolved', 500);
  }
  return owner;
}

export interface ContactInput {
  /** WhatsApp shortcut: same as a `whatsapp:phone` identity. */
  phone?: string;
  identities?: IdentityCandidate[];
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

/**
 * Validate the `identities` of a request body into candidates. Kinds must be
 * produced by a registered provider; `whatsapp:phone` values must be phones.
 */
export function parseIdentities(raw: unknown): IdentityCandidate[] {
  if (!Array.isArray(raw)) {
    throw new ContactError("'identities' must be an array", 400);
  }
  registerBuiltinProviders();
  const known = new Set(listProviders().flatMap((p) => p.identityKinds));
  const out: IdentityCandidate[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const kind = typeof o.kind === 'string' ? o.kind.trim() : '';
    let externalId =
      typeof o.external_id === 'string' ? o.external_id.trim() : '';
    if (!kind || !externalId) {
      throw new ContactError(
        "Each identity needs a string 'kind' and 'external_id'",
        400
      );
    }
    if (!known.has(kind)) {
      throw new ContactError(
        `Unknown identity kind '${kind}'. Accepted: ${[...known].sort().join(', ')}`,
        400
      );
    }
    if (o.handle != null && typeof o.handle !== 'string') {
      throw new ContactError("'handle' must be a string or null", 400);
    }
    if (kind === WA_PHONE_KIND) {
      externalId = sanitizePhoneForMeta(externalId);
      if (!isValidE164(externalId)) {
        throw new ContactError(
          `'${kind}' must be a valid phone number in E.164 format`,
          400
        );
      }
    }
    out.push({ kind, externalId, handle: (o.handle as string | null) ?? null });
  }
  return out;
}

/**
 * Find (by fuzzy phone match, on the column or a whatsapp:phone identity)
 * or create a contact in `accountId`.
 * Returns the contact id and whether it was created. Reuses the shared
 * `findExistingContact` dedupe + unique-violation race backstop so an
 * API-created contact is indistinguishable from a webhook-created one.
 *
 * With `identities`, the contact is found by ANY identity (phone included)
 * and created carrying all of them; without, only `phone` is used.
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  if (input.identities && input.identities.length > 0) {
    return findOrCreateByIdentities(db, accountId, auditUserId, input);
  }

  const sanitized = sanitizePhoneForMeta(input.phone ?? '');
  if (!isValidE164(sanitized)) {
    throw new ContactError(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  const existing = await findDuplicateContact(db, accountId, sanitized);
  if (existing) return { id: existing.id, created: false };

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      phone: sanitized,
      name: input.name ?? sanitized,
      email: input.email ?? null,
      company: input.company ?? null,
    })
    .select('id')
    .single();

  if (error || !created) {
    // Lost a race against a concurrent create — the unique index
    // rejected the duplicate. Re-resolve to the winner.
    if (isUniqueViolation(error)) {
      const raced = await findDuplicateContact(db, accountId, sanitized);
      if (raced) return { id: raced.id, created: false };
    }
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }

  await ensurePhoneIdentity(db, accountId, created.id, sanitized);
  return { id: created.id, created: true };
}

async function findOrCreateByIdentities(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  const candidates = [...(input.identities ?? [])];
  if (input.phone) {
    const sanitized = sanitizePhoneForMeta(input.phone);
    if (!isValidE164(sanitized)) {
      throw new ContactError(
        "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
        400
      );
    }
    candidates.push({ kind: WA_PHONE_KIND, externalId: sanitized });
  }

  // No senderName: an API caller must not rename an existing contact.
  const outcome = await resolveOrCreateContact(db, {
    accountId,
    auditUserId,
    candidates,
  });
  if (!outcome) {
    throw new ContactError('Failed to create contact', 500);
  }

  const { contact, wasCreated } = outcome;
  if (wasCreated) {
    const patch: Record<string, unknown> = {};
    if (input.name) patch.name = input.name;
    if (input.email) patch.email = input.email;
    if (input.company) patch.company = input.company;
    if (Object.keys(patch).length > 0) {
      const { error } = await db
        .from('contacts')
        .update(patch)
        .eq('id', contact.id)
        .eq('account_id', accountId);
      if (error) {
        console.error('[api/v1/contacts] create patch error:', error);
        throw new ContactError('Failed to create contact', 500);
      }
    }
  }
  return { id: contact.id, created: wasCreated };
}

/**
 * Replace a contact's tags to exactly match `tagNames` (case-
 * insensitive; missing tags are created). Pass `[]` to clear all tags.
 * Reuses `resolveImportTagIds` so API and CSV-import tag handling stay
 * consistent — but note its `tagIdByKey` map holds EVERY tag in the
 * account (it loads them all for case-insensitive matching), so the
 * desired set must be derived from the *requested* names only, never
 * from the map's values (#560).
 */
export async function setContactTags(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[]
): Promise<void> {
  const { tagIdByKey } = await resolveImportTagIds(db, {
    accountId,
    userId: auditUserId,
    tagNames,
    canCreateTags: true,
  });
  // Same normalization `resolveImportTagIds` applies to `tagNames`
  // (trim, lowercase, skip empty) so every requested name resolves.
  const desired = new Set<string>();
  for (const raw of tagNames) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const tagId = tagIdByKey.get(key);
    if (tagId) desired.add(tagId);
  }

  // Diff against the current joins rather than delete-all-then-insert:
  // a diff only touches tags that actually change, so a mid-operation
  // failure can never wipe tags that were meant to stay. Every write
  // is error-checked and surfaced as a ContactError (→ 500) instead of
  // being swallowed behind a misleading 200.
  const { data: current, error: readErr } = await db
    .from('contact_tags')
    .select('tag_id')
    .eq('contact_id', contactId);
  if (readErr) {
    throw new ContactError('Failed to read contact tags', 500);
  }
  const existing = new Set((current ?? []).map((r) => r.tag_id as string));

  const toAdd = [...desired].filter((id) => !existing.has(id));
  const toRemove = [...existing].filter((id) => !desired.has(id));

  if (toRemove.length > 0) {
    const { error } = await db
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .in('tag_id', toRemove);
    if (error) throw new ContactError('Failed to update contact tags', 500);
  }
  if (toAdd.length > 0) {
    for (const tagId of toAdd) {
      try {
        await addContactTagAndDispatch({
          db,
          accountId,
          contactId,
          tagId,
        });
      } catch (error) {
        console.error('[api/v1/contacts] tag add failed:', error);
        throw new ContactError('Failed to update contact tags', 500);
      }
    }
  }
}

/** Fetch + serialize a single contact scoped to the account, or null. */
export async function getContactById(
  db: SupabaseClient,
  accountId: string,
  contactId: string
): Promise<ApiContact | null> {
  const { data, error } = await db
    .from('contacts')
    .select(CONTACT_SELECT)
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  return serializeContact(data as Record<string, unknown>);
}

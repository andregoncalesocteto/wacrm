import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Consent per PURPOSE, kept on the contact (`contact_consents`, migration 065).
 * It is the PROOF of consent: when it was given, where from, and when revoked.
 *
 *   notifications : order notices (thanks, status)
 *   marketing     : recovery and offers (abandoned cart)
 *
 * Every query is filtered by `accountId` (service-role client). Channel-agnostic
 * on purpose: the core never imports a channel module (see `hasConsent`).
 *
 * PRECEDENCE in `hasConsent` (explicit revocation > implicit by having written):
 *   1. an explicit row exists  -> it decides (`granted`); a revocation holds
 *      even if the customer wrote to us ("PARAR" is honoured), and only a
 *      NEWER explicit grant reactivates it (see `recordConsent`);
 *   2. no explicit row         -> implicit consent when the customer ever wrote
 *      to the CRM (on the sending connection, when one is given); nothing is
 *      stored for it;
 *   3. otherwise               -> no consent.
 */

export const CONSENT_PURPOSES = ['notifications', 'marketing'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export interface ConsentRow {
  id: string;
  purpose: ConsentPurpose;
  granted: boolean;
  given_at: string | null;
  revoked_at: string | null;
  source: string;
  updated_at: string;
}

const COLUMNS =
  'id, purpose, granted, given_at, revoked_at, source, updated_at';
const CAS_TRIES = 3;

const time = (v: string | null): number =>
  v === null ? Number.NEGATIVE_INFINITY : new Date(v).getTime();

/** When the stored decision was made: the later of given / revoked. */
const decidedAt = (row: ConsentRow): number =>
  Math.max(time(row.given_at), time(row.revoked_at));

async function findConsent(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  purpose: ConsentPurpose
): Promise<ConsentRow | null> {
  const { data, error } = await db
    .from('contact_consents')
    .select(COLUMNS)
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('purpose', purpose)
    .maybeSingle();
  if (error) throw new Error(`consent lookup failed: ${error.message}`);
  return (data as ConsentRow | null) ?? null;
}

/**
 * Record an explicit decision (`granted` true = consent given, false =
 * revoked) made at `at`. It only takes effect when `at` is STRICTLY newer than
 * the stored decision: equal or older changes nothing (late or replayed
 * events). Returns whether it was applied. A grant clears `revoked_at`
 * (reactivation); a revocation keeps `given_at` (the proof of the past grant).
 */
export async function recordConsent(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    purpose: ConsentPurpose;
    granted: boolean;
    at: Date;
    source: string;
  }
): Promise<boolean> {
  const { accountId, contactId, purpose, granted, at, source } = args;
  const atIso = at.toISOString();
  for (let attempt = 0; attempt < CAS_TRIES; attempt++) {
    const current = await findConsent(db, accountId, contactId, purpose);
    if (!current) {
      const { error } = await db.from('contact_consents').insert({
        account_id: accountId,
        contact_id: contactId,
        purpose,
        granted,
        given_at: granted ? atIso : null,
        revoked_at: granted ? null : atIso,
        source,
        updated_at: new Date().toISOString(),
      });
      if (!error) return true;
      if ((error as { code?: string }).code !== '23505') {
        throw new Error(`consent insert failed: ${error.message}`);
      }
      continue; // lost the race for the first row: re-read and compare
    }
    if (at.getTime() <= decidedAt(current)) return false;
    const { data, error } = await db
      .from('contact_consents')
      .update({
        granted,
        given_at: granted ? atIso : current.given_at,
        revoked_at: granted ? null : atIso,
        source,
        updated_at: new Date().toISOString(),
      })
      .eq('id', current.id)
      .eq('account_id', accountId)
      // compare-and-swap: a concurrent write to the row makes us re-read
      .eq('updated_at', current.updated_at)
      .select('id');
    if (error) throw new Error(`consent update failed: ${error.message}`);
    if (Array.isArray(data) && data.length > 0) return true;
  }
  throw new Error('consent update kept conflicting; retry');
}

/** `consent` of an event, as validated by `parseCommonFields`. */
export interface EventConsentInput {
  notifications?: boolean;
  marketing?: boolean;
  givenAt?: Date;
}

/**
 * Apply the `consent` of an event. A purpose left out is NOT touched (only an
 * explicit `false` revokes); `givenAt` is the decision time of every purpose
 * present (the payload parser guarantees it is there). Returns the purposes
 * that changed.
 */
export async function applyEventConsent(
  db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    consent: EventConsentInput | null;
    source: string;
  }
): Promise<ConsentPurpose[]> {
  const { consent } = args;
  if (!consent?.givenAt) return [];
  const changed: ConsentPurpose[] = [];
  for (const purpose of CONSENT_PURPOSES) {
    const granted = consent[purpose];
    if (granted === undefined) continue;
    const applied = await recordConsent(db, {
      accountId: args.accountId,
      contactId: args.contactId,
      purpose,
      granted,
      at: consent.givenAt,
      source: args.source,
    });
    if (applied) changed.push(purpose);
  }
  return changed;
}

/**
 * Whether the customer ever wrote to the CRM: in any conversation of the
 * account, or, with `connectionId`, only in a conversation of THAT connection
 * (someone who wrote to brand B's number has not opted in to brand A's).
 */
export async function hasWrittenToUs(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  connectionId?: string | null
): Promise<boolean> {
  let q = db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  if (connectionId) q = q.eq('connection_id', connectionId);
  const { data: convs, error } = await q;
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
 * May this contact be messaged for `purpose`? READ-ONLY: the implicit consent
 * of someone who wrote to us is computed, never stored. See the precedence in
 * the file header: an explicit revocation beats the implicit one. With
 * `opts.connectionId` the implicit consent only counts when the customer wrote
 * on that connection; without it, on any conversation (callers with no
 * connection at hand).
 */
export async function hasConsent(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  purpose: ConsentPurpose,
  opts?: { connectionId?: string | null }
): Promise<boolean> {
  const explicit = await findConsent(db, accountId, contactId, purpose);
  if (explicit) return explicit.granted;
  return hasWrittenToUs(db, accountId, contactId, opts?.connectionId);
}

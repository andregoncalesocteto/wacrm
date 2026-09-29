import { randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { IDTRACK_KIND, TRACKING_TOKEN_TTL_DAYS } from './constants';

const DAY_MS = 86_400_000;

export interface TrackingTokenTarget {
  accountId: string;
  contactId: string;
  conversationId: string;
  connectionId: string;
}

export interface IssuedTrackingToken {
  token: string;
  expiresAt: string;
}

export type ResolvedTrackingToken =
  | ({ ok: true; expiresAt: string } & TrackingTokenTarget)
  | { ok: false; reason: 'invalid' | 'expired' };

/** 192 random bits, URL-safe. Not derived from any id, phone or timestamp. */
function mintToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Create or renew the Tracking token of a contact + conversation + connection.
 *
 * - No token yet: mint one.
 * - Live token: same value, expiry pushed to now + 30 days (links already sent
 *   keep working).
 * - Expired token: a NEW value replaces it (an expired link never revives).
 *
 * At most one token exists per target (DB unique). The token is mirrored as a
 * contact identity of kind `idtrack`. That identity is written here, by the CRM
 * only: `POST /api/v1/contacts` keeps refusing `idtrack` because no channel
 * provider declares it, so an API client cannot plant or hijack one.
 */
export async function issueTrackingToken(
  db: SupabaseClient,
  target: TrackingTokenTarget,
  now: Date = new Date()
): Promise<IssuedTrackingToken> {
  const expiresAt = new Date(
    now.getTime() + TRACKING_TOKEN_TTL_DAYS * DAY_MS
  ).toISOString();

  const find = async () => {
    const { data, error } = await db
      .from('tracking_tokens')
      .select('id, token, expires_at')
      .eq('account_id', target.accountId)
      .eq('contact_id', target.contactId)
      .eq('conversation_id', target.conversationId)
      .eq('connection_id', target.connectionId)
      .maybeSingle();
    if (error)
      throw new Error(`tracking token lookup failed: ${error.message}`);
    return data as { id: string; token: string; expires_at: string } | null;
  };

  let row = await find();
  if (!row) {
    const token = mintToken();
    const { error } = await db.from('tracking_tokens').insert({
      account_id: target.accountId,
      contact_id: target.contactId,
      conversation_id: target.conversationId,
      connection_id: target.connectionId,
      token,
      expires_at: expiresAt,
    });
    if (!error) {
      await addIdentity(db, target, token);
      return { token, expiresAt };
    }
    // A concurrent sender created it first: renew that one instead.
    if (!isUniqueViolation(error)) {
      throw new Error(`tracking token creation failed: ${error.message}`);
    }
    row = await find();
    if (!row) throw new Error('tracking token could not be created');
  }

  const expired = new Date(row.expires_at).getTime() <= now.getTime();
  const previousToken = row.token;
  const token = expired ? mintToken() : previousToken;
  const { error } = await db
    .from('tracking_tokens')
    .update({ token, expires_at: expiresAt })
    .eq('id', row.id)
    .eq('account_id', target.accountId);
  if (error) throw new Error(`tracking token renewal failed: ${error.message}`);

  if (expired) {
    await rotateIdentity(db, target, previousToken, token);
  } else {
    await addIdentity(db, target, token);
  }
  return { token, expiresAt };
}

/**
 * Resolve an `idtrack` value to contact + conversation + connection, scoped to
 * the caller's account (a token of another account is simply `invalid`).
 */
export async function resolveTrackingToken(
  db: SupabaseClient,
  args: { accountId: string; token: string },
  now: Date = new Date()
): Promise<ResolvedTrackingToken> {
  const token = args.token?.trim();
  if (!token) return { ok: false, reason: 'invalid' };
  const { data, error } = await db
    .from('tracking_tokens')
    .select(
      'account_id, contact_id, conversation_id, connection_id, expires_at'
    )
    .eq('account_id', args.accountId)
    .eq('token', token)
    .maybeSingle();
  if (error) throw new Error(`tracking token lookup failed: ${error.message}`);
  const row = data as {
    account_id: string;
    contact_id: string;
    conversation_id: string;
    connection_id: string;
    expires_at: string;
  } | null;
  if (!row) return { ok: false, reason: 'invalid' };
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    accountId: row.account_id,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    connectionId: row.connection_id,
    expiresAt: row.expires_at,
  };
}

async function addIdentity(
  db: SupabaseClient,
  target: TrackingTokenTarget,
  token: string
): Promise<void> {
  const { data } = await db
    .from('contact_identities')
    .select('id')
    .eq('account_id', target.accountId)
    .eq('kind', IDTRACK_KIND)
    .eq('external_id', token)
    .maybeSingle();
  if (data) return;
  const { error } = await db.from('contact_identities').insert({
    account_id: target.accountId,
    contact_id: target.contactId,
    kind: IDTRACK_KIND,
    external_id: token,
  });
  if (error && !isUniqueViolation(error)) {
    throw new Error(`tracking identity creation failed: ${error.message}`);
  }
}

async function rotateIdentity(
  db: SupabaseClient,
  target: TrackingTokenTarget,
  oldToken: string,
  newToken: string
): Promise<void> {
  const { data } = await db
    .from('contact_identities')
    .update({ external_id: newToken })
    .eq('account_id', target.accountId)
    .eq('contact_id', target.contactId)
    .eq('kind', IDTRACK_KIND)
    .eq('external_id', oldToken)
    .select('id');
  if (Array.isArray(data) && data.length > 0) return;
  await addIdentity(db, target, newToken);
}

import type { SupabaseClient } from '@supabase/supabase-js';

export type StoreIdResult =
  { ok: true; value: string | null | undefined } | { ok: false; error: string };

/**
 * Validates the optional `store_id` of a quick reply body. `undefined` = the
 * field was not sent (leave as is); `null`/'' = network-wide; a string must be
 * a store of `accountId` (the caller uses a service-role client, so RLS does
 * not protect this).
 */
export async function parseQuickReplyStoreId(
  db: SupabaseClient,
  accountId: string,
  body: Record<string, unknown>
): Promise<StoreIdResult> {
  if (!('store_id' in body) || body.store_id === undefined) {
    return { ok: true, value: undefined };
  }
  const raw = body.store_id;
  if (raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, error: 'store_id must be a string or null' };
  }
  const { data, error } = await db
    .from('stores')
    .select('id')
    .eq('id', raw)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return { ok: false, error: 'store not found' };
  return { ok: true, value: raw };
}

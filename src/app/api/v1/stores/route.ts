// ============================================================
// GET /api/v1/stores — list the account's stores (scope: connections:read)
//
// Read-only discovery of store ids. The roster is small and
// settings-class, so it is returned whole (cursor always null).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { buildStoreKey } from '@/lib/stores/store-key';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

const STORE_COLUMNS =
  'id, name, address, phone, manager_name, menu_url, store_code, store_acronym, business_acronym, created_at';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'connections:read');

    const { data, error } = await ctx.supabase
      .from('stores')
      .select(STORE_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[api/v1/stores] list error:', error);
      return fail('internal', 'Failed to list stores', 500);
    }

    const stores = (data ?? []).map((s) => ({
      ...s,
      store_key: buildStoreKey(s),
    }));
    return okList(stores, null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

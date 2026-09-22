// ============================================================
// GET /api/v1/stores — list the account's stores (scope: connections:read)
//
// Read-only discovery of store ids. The roster is small and
// settings-class, so it is returned whole (cursor always null).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

const STORE_COLUMNS = 'id, name, address, phone, manager_name, created_at';

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

    return okList(data ?? [], null);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

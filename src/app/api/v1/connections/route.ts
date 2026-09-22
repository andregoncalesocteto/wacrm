// ============================================================
// GET /api/v1/connections — list the account's channel connections
// (scope: connections:read). Optional filter: ?store_id=
//
// Explicit column list on purpose: `config` (holds the webhook
// verify token) and the credentials table are never exposed.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';

const CONNECTION_COLUMNS =
  'id, store_id, channel_type, display_name, external_id, status, last_inbound_at, last_outbound_at, connected_at, disabled_at, created_at';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'connections:read');

    let query = ctx.supabase
      .from('channel_connections')
      .select(CONNECTION_COLUMNS)
      .eq('account_id', ctx.accountId);

    const storeId = new URL(request.url).searchParams.get('store_id');
    if (storeId) query = query.eq('store_id', storeId);

    const { data, error } = await query.order('created_at', {
      ascending: true,
    });

    if (error) {
      console.error('[api/v1/connections] list error:', error);
      return fail('internal', 'Failed to list connections', 500);
    }

    return okList(
      (data ?? []).map((r) => {
        const { channel_type, disabled_at, ...rest } = r as unknown as Record<
          string,
          unknown
        >;
        return { ...rest, channel: channel_type, enabled: disabled_at == null };
      }),
      null
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

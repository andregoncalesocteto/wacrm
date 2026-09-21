import type { SupabaseClient } from '@supabase/supabase-js';
import type { ChannelConnection } from './connections';
import { PUBLIC_COLUMNS, publicConnection } from './connection-input';

// Shared by the lifecycle routes under /api/channels/connections/[id]/*.

/** The full row (the provider needs the whole config), scoped to the account. */
export async function loadOwnedConnection(
  supabase: SupabaseClient,
  accountId: string,
  id: string
): Promise<ChannelConnection | null> {
  const { data, error } = await supabase
    .from('channel_connections')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as ChannelConnection | null) ?? null;
}

/** Applies a patch and returns the client-safe connection. */
export async function updateConnection(
  supabase: SupabaseClient,
  accountId: string,
  id: string,
  patch: Record<string, unknown>
) {
  const { data, error } = await supabase
    .from('channel_connections')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId)
    .select(PUBLIC_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? publicConnection(data as Record<string, unknown>) : null;
}

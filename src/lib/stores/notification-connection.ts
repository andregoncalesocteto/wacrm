// Store-level domain lookups for the direct order events: which store a key
// names, and which WhatsApp connection sends that store's notices.
//
// Never imports a concrete channel: "reachable by phone" is read from the
// provider's declared capabilities (`initiate`), like the rest of the core.
// Every query is filtered by account_id.

import type { SupabaseClient } from '@supabase/supabase-js';

import { getProvider, hasProvider } from '@/lib/channels/registry';
import { registerBuiltinProviders } from '@/lib/channels/providers';
import { normalizeStoreKey } from './store-key';

/**
 * A channel whose conversations WE can open with just a phone number (WhatsApp:
 * 'template'/'free'). Telegram ('after_inbound') needs the customer to write
 * first and is not reachable by phone.
 */
export function isPhoneReachableChannel(channelType: string): boolean {
  registerBuiltinProviders();
  if (!hasProvider(channelType)) return false;
  return getProvider(channelType).capabilities.initiate !== 'after_inbound';
}

export interface StoreByKey {
  id: string;
  name: string;
}

/** The account's store named by `key` (case/edge-space insensitive), or null. */
export async function findStoreByKey(
  db: SupabaseClient,
  accountId: string,
  key: string
): Promise<StoreByKey | null> {
  const normalized = normalizeStoreKey(key);
  if (!normalized) return null;
  const { data, error } = await db
    .from('stores')
    .select('id, name')
    .eq('account_id', accountId)
    .eq('store_key_normalized', normalized)
    .maybeSingle();
  if (error) throw new Error(`findStoreByKey failed: ${error.message}`);
  return (data as StoreByKey | null) ?? null;
}

interface ConnectionRow {
  id: string;
  channel_type: string;
  status: string;
  disabled_at: string | null;
}

function isActive(c: ConnectionRow): boolean {
  return (
    !c.disabled_at &&
    (c.status === 'connected' || c.status === 'degraded') &&
    isPhoneReachableChannel(c.channel_type)
  );
}

export type NotificationConnection =
  | { ok: true; connectionId: string }
  | { ok: false; reason: 'none' | 'ambiguous' };

/**
 * The connection that sends notices for a store: its only active WhatsApp
 * connection; with several, the store's default if it is one of them; else
 * `ambiguous` (several and no usable default). No active one: `none`.
 */
export async function resolveNotificationConnection(
  db: SupabaseClient,
  accountId: string,
  storeId: string
): Promise<NotificationConnection> {
  const { data: store, error: storeErr } = await db
    .from('stores')
    .select('id, notification_connection_id')
    .eq('account_id', accountId)
    .eq('id', storeId)
    .maybeSingle();
  if (storeErr) {
    throw new Error(
      `resolveNotificationConnection failed: ${storeErr.message}`
    );
  }
  if (!store) return { ok: false, reason: 'none' };

  const { data: conns, error: connErr } = await db
    .from('channel_connections')
    .select('id, channel_type, status, disabled_at')
    .eq('account_id', accountId)
    .eq('store_id', storeId);
  if (connErr) {
    throw new Error(`resolveNotificationConnection failed: ${connErr.message}`);
  }

  const active = ((conns ?? []) as ConnectionRow[]).filter(isActive);
  if (active.length === 0) return { ok: false, reason: 'none' };
  if (active.length === 1) return { ok: true, connectionId: active[0].id };

  const preferred = (store as { notification_connection_id: string | null })
    .notification_connection_id;
  if (preferred && active.some((c) => c.id === preferred)) {
    return { ok: true, connectionId: preferred };
  }
  return { ok: false, reason: 'ambiguous' };
}

/**
 * Server-side check for `stores.notification_connection_id`: the connection
 * must exist in the SAME account, belong to the SAME store and be a
 * phone-reachable (WhatsApp) channel. Returns true when valid.
 */
export async function isValidNotificationConnection(
  db: SupabaseClient,
  accountId: string,
  storeId: string,
  connectionId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('channel_connections')
    .select('id, channel_type')
    .eq('account_id', accountId)
    .eq('store_id', storeId)
    .eq('id', connectionId)
    .maybeSingle();
  if (error) throw new Error(`notification connection check: ${error.message}`);
  const row = data as { channel_type: string } | null;
  return !!row && isPhoneReachableChannel(row.channel_type);
}

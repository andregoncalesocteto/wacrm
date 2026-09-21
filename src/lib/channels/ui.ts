// Pure helpers for the channels settings screen (no React, no i18n).

export interface ChannelConnectionRow {
  id: string;
  store_id: string;
  channel_type: string;
  display_name: string | null;
  status: string;
  disabled_at: string | null;
  last_inbound_at: string | null;
  has_conversations: boolean;
}

export interface StoreRef {
  id: string;
  name: string;
}

export interface ConnectionGroup {
  store: StoreRef;
  connections: ChannelConnectionRow[];
}

/**
 * Groups connections by store, in the stores' order; stores without
 * connections are left out. Connections pointing at an unknown store (should
 * not happen, FK) are dropped rather than shown under a blank heading.
 */
export function groupConnectionsByStore(
  stores: StoreRef[],
  connections: ChannelConnectionRow[]
): ConnectionGroup[] {
  return stores
    .map((store) => ({
      store,
      connections: connections.filter((c) => c.store_id === store.id),
    }))
    .filter((g) => g.connections.length > 0);
}

/** "Delete" is only offered for a connection that never had conversations. */
export function canDeleteConnection(c: {
  has_conversations: boolean;
}): boolean {
  return !c.has_conversations;
}

export type EmptyStateKind = 'no-stores' | 'no-connections' | 'has-connections';

export function emptyStateKind(
  storeCount: number,
  connectionCount: number
): EmptyStateKind {
  if (connectionCount > 0) return 'has-connections';
  return storeCount === 0 ? 'no-stores' : 'no-connections';
}

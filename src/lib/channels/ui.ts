// Pure helpers for the channels settings screen (no React, no i18n).

import { connectionChipState } from '@/lib/stores/ui';

export interface ChannelConnectionRow {
  id: string;
  store_id: string;
  channel_type: string;
  display_name: string | null;
  status: string;
  disabled_at: string | null;
  last_inbound_at: string | null;
  has_conversations: boolean;
  /** Non-secret fields the GET list also returns (secrets never leave the server). */
  external_id?: string | null;
  config?: Record<string, unknown> | null;
  last_error?: { message?: string } | null;
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

export interface LastError {
  code: string | null;
  message: string;
}

/** Normalizes the stored `last_error` jsonb (may be null, partial or odd). */
export function parseLastError(raw: unknown): LastError | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { code?: unknown; message?: unknown };
  const message = typeof r.message === 'string' ? r.message : '';
  const code = typeof r.code === 'string' ? r.code : null;
  if (!message && !code) return null;
  return { code, message };
}

export type ErrorSuggestion = 'auth' | 'rate_limited' | 'generic';

/**
 * Which suggested action to show for an error code: auth-like states ask for a
 * valid token, rate limiting asks to wait, everything else is generic.
 * `needs_action` is what a failed health check stores for an auth problem.
 */
export function errorSuggestion(code: string | null): ErrorSuggestion {
  if (code === 'auth' || code === 'needs_action') return 'auth';
  if (code === 'rate_limited') return 'rate_limited';
  return 'generic';
}

/** Disabled connections cannot be reconnected/tested until enabled again. */
export function canRunConnectionActions(c: {
  disabled_at: string | null;
}): boolean {
  return !c.disabled_at;
}

/** Other stores a connection can be moved to. */
export function moveTargets(
  stores: StoreRef[],
  currentStoreId: string
): StoreRef[] {
  return stores.filter((s) => s.id !== currentStoreId);
}

export type WorstState =
  'needs_action' | 'disconnected' | 'degraded' | 'connected';

/** Highest severity first. */
const SEVERITY: WorstState[] = [
  'needs_action',
  'disconnected',
  'degraded',
  'connected',
];

export interface ChannelsSummary {
  /** Enabled connections that are connected (X). */
  connected: number;
  /** Enabled connections (Y). Disabled ones are NOT counted here. */
  total: number;
  /** Disabled connections, reported apart from X of Y. */
  disabled: number;
  /** Worst state among the enabled connections; null when there are none. */
  worst: WorstState | null;
}

/**
 * Overview tile "Canais: X conectados de Y". A disabled connection is a
 * deliberate choice of the admin, not a problem, so it is excluded from Y and
 * from the worst-state pick (severity: needs_action > disconnected >
 * degraded > connected) and reported separately.
 */
export function summarizeChannels(
  connections: Array<{ status: string; disabled_at: string | null }>
): ChannelsSummary {
  let connected = 0;
  let total = 0;
  let disabled = 0;
  let worstIdx = SEVERITY.length;
  for (const c of connections) {
    const state = connectionChipState(c);
    if (state === 'disabled') {
      disabled++;
      continue;
    }
    total++;
    if (state === 'connected') connected++;
    worstIdx = Math.min(worstIdx, SEVERITY.indexOf(state));
  }
  return {
    connected,
    total,
    disabled,
    worst: total === 0 ? null : SEVERITY[worstIdx],
  };
}

/**
 * The WhatsApp connection the account's legacy (NULL connection_id) rows
 * belong to: the enabled one first, else the first (same rule as the server's
 * findAccountWhatsAppConnection).
 */
export function defaultConnectionId(
  connections: Array<{ id: string; disabled_at: string | null }>
): string | null {
  return (
    (connections.find((c) => c.disabled_at == null) ?? connections[0])?.id ??
    null
  );
}

/** Templates of one connection; NULL connection_id belongs to the default one. */
export function templatesForConnection<
  T extends { connection_id?: string | null },
>(templates: T[], selectedId: string | null, defaultId: string | null): T[] {
  return templates.filter((t) => (t.connection_id ?? defaultId) === selectedId);
}

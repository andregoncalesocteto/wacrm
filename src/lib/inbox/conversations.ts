import type {
  Conversation,
  ConversationConnection,
  Contact,
  Tag,
} from '@/types';

/**
 * Conversation select that embeds the contact plus its tags, so the Inbox
 * can filter conversations by contact tag without a second round-trip.
 * `contact_tags(tags(*))` returns the join rows; {@link normalizeConversation}
 * flattens them onto `contact.tags`. It also embeds the conversation's
 * connection with its store, for the store / connection / channel filters.
 */
export const CONVERSATION_SELECT =
  '*, contact:contacts(*, contact_tags(tags(*))), connection:channel_connections(id, channel_type, display_name, status, disabled_at, store_id, store:stores(id, name))';

/** Raw shape returned by {@link CONVERSATION_SELECT} before flattening. */
type RawContact = Contact & { contact_tags?: { tags: Tag | null }[] };
type RawConversation = Omit<Conversation, 'contact'> & {
  contact?: RawContact | null;
};

/** PostgREST returns an embedded to-one as an object, but be tolerant of an array. */
function normalizeConnection(
  raw: unknown
): ConversationConnection | null | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || typeof value !== 'object') return null;
  const conn = value as ConversationConnection & {
    store?: unknown;
  };
  const store = Array.isArray(conn.store) ? conn.store[0] : conn.store;
  return {
    ...conn,
    store: (store as ConversationConnection['store']) ?? null,
  };
}

/**
 * Flatten the embedded `contact_tags(tags(*))` join into `contact.tags`.
 * Safe to call on rows fetched with {@link CONVERSATION_SELECT}; a row with
 * no contact (e.g. a freshly-inserted conversation) passes through untouched.
 */
export function normalizeConversation(raw: RawConversation): Conversation {
  const withConnection: RawConversation =
    'connection' in raw
      ? { ...raw, connection: normalizeConnection(raw.connection) }
      : raw;
  const rawContact = raw.contact;
  if (!rawContact) return withConnection as Conversation;

  const { contact_tags, ...contact } = rawContact;
  return {
    ...withConnection,
    contact: {
      ...contact,
      tags: (contact_tags ?? [])
        .map((ct) => ct.tags)
        .filter((t): t is Tag => t != null),
    },
  };
}

export function normalizeConversations(
  rows: RawConversation[]
): Conversation[] {
  return rows.map(normalizeConversation);
}

export interface ContactFilters {
  /** Tag ids; a conversation matches if its contact has ANY of them (OR). */
  tagIds: string[];
  /** Exact company match, or null for no company filter. */
  company: string | null;
}

/**
 * Whether a conversation passes the contact-based Inbox filters (issue #272).
 * Empty `tagIds` and null `company` are no-ops, so the default (no filters)
 * always matches. Tags use OR logic, consistent with Broadcast audiences.
 */
export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters
): boolean {
  if (tagIds.length > 0) {
    const contactTagIds = conversation.contact?.tags ?? [];
    if (!contactTagIds.some((t) => tagIds.includes(t.id))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}

export interface ConversationScopeFilters {
  /** Store id, or null for no store filter. */
  storeId: string | null;
  /** Connection id, or null for no connection filter. */
  connectionId: string | null;
  /** Channel type (e.g. "whatsapp_cloud"), or null for no channel filter. */
  channelType: string | null;
}

export const NO_SCOPE_FILTERS: ConversationScopeFilters = {
  storeId: null,
  connectionId: null,
  channelType: null,
};

/**
 * Whether a conversation passes the store / connection / channel filters.
 * Null dimensions are no-ops (the default matches everything); the set
 * dimensions combine with AND. A conversation without an embedded connection
 * only matches when no dimension is set, except `connectionId`, which can
 * still be checked against the row's own `connection_id`.
 */
export function matchesConversationScope(
  conversation: Conversation,
  { storeId, connectionId, channelType }: ConversationScopeFilters
): boolean {
  if (connectionId !== null) {
    const id = conversation.connection?.id ?? conversation.connection_id;
    if (id !== connectionId) return false;
  }
  if (storeId !== null && conversation.connection?.store_id !== storeId) {
    return false;
  }
  if (
    channelType !== null &&
    conversation.connection?.channel_type !== channelType
  ) {
    return false;
  }
  return true;
}

export interface ScopeOptions {
  stores: { id: string; name: string }[];
  connections: {
    id: string;
    displayName: string;
    channelType: string;
    storeId: string;
  }[];
  channelTypes: string[];
}

/**
 * Filter options present in the loaded conversations (only what has a
 * conversation is worth offering). Sorted by name / type for a stable order.
 */
export function deriveScopeOptions(
  conversations: Conversation[]
): ScopeOptions {
  const stores = new Map<string, string>();
  const connections = new Map<string, ScopeOptions['connections'][number]>();
  const channelTypes = new Set<string>();
  for (const c of conversations) {
    const conn = c.connection;
    if (!conn) continue;
    connections.set(conn.id, {
      id: conn.id,
      displayName: conn.display_name,
      channelType: conn.channel_type,
      storeId: conn.store_id,
    });
    channelTypes.add(conn.channel_type);
    if (conn.store) stores.set(conn.store.id, conn.store.name);
  }
  return {
    stores: [...stores]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    connections: [...connections.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    ),
    channelTypes: [...channelTypes].sort(),
  };
}

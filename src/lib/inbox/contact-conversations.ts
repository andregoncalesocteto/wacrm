import type { Conversation, ConversationStatus } from '@/types';

export interface ContactConversationItem {
  id: string;
  storeName: string | null;
  channelType: string | null;
  /** Set only when the same store shows up with more than one connection. */
  connectionName: string | null;
  lastMessageText: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  status: ConversationStatus;
  disabled: boolean;
  isCurrent: boolean;
}

export interface ContactConversationsSummary {
  items: ContactConversationItem[];
  /** The section only makes sense when the contact has 2+ conversations. */
  visible: boolean;
}

type Row = Pick<
  Conversation,
  | 'id'
  | 'status'
  | 'last_message_text'
  | 'last_message_at'
  | 'unread_count'
  | 'connection'
  | 'created_at'
>;

/**
 * Maps a contact's conversations (any connection/store) into the rows of the
 * "Conversas" section: newest activity first, the current one flagged, and
 * hidden entirely with 0 or 1 conversation.
 */
export function contactConversationsSummary(
  rows: Row[],
  currentConversationId?: string | null
): ContactConversationsSummary {
  const sorted = [...rows].sort((a, b) =>
    (b.last_message_at ?? b.created_at).localeCompare(
      a.last_message_at ?? a.created_at
    )
  );

  const connectionsByStore = new Map<string, Set<string>>();
  for (const row of sorted) {
    const conn = row.connection;
    if (!conn?.store_id) continue;
    const set = connectionsByStore.get(conn.store_id) ?? new Set<string>();
    set.add(conn.id);
    connectionsByStore.set(conn.store_id, set);
  }

  const items = sorted.map((row): ContactConversationItem => {
    const conn = row.connection ?? null;
    const several =
      !!conn && (connectionsByStore.get(conn.store_id)?.size ?? 0) > 1;
    return {
      id: row.id,
      storeName: conn?.store?.name ?? null,
      channelType: conn?.channel_type ?? null,
      connectionName: several ? conn.display_name : null,
      lastMessageText: row.last_message_text ?? null,
      lastMessageAt: row.last_message_at ?? null,
      unreadCount: row.unread_count ?? 0,
      status: row.status,
      disabled: Boolean(conn?.disabled_at),
      isCurrent: row.id === currentConversationId,
    };
  });

  return { items, visible: items.length > 1 };
}

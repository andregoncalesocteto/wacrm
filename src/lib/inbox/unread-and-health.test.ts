import { describe, expect, it } from 'vitest';
import type { Conversation } from '@/types';
import {
  downConnections,
  isConversationConnectionDisabled,
  unreadByStore,
} from './conversations';

function conv(
  id: string,
  unread: number,
  storeId: string | null,
  disabledAt: string | null = null
): Conversation {
  return {
    id,
    unread_count: unread,
    connection: storeId
      ? {
          id: `conn-${storeId}`,
          channel_type: 'whatsapp_cloud',
          display_name: 'x',
          status: 'connected',
          disabled_at: disabledAt,
          store_id: storeId,
          store: { id: storeId, name: storeId },
        }
      : null,
  } as unknown as Conversation;
}

describe('unreadByStore', () => {
  it('counts conversations with unread per store', () => {
    const map = unreadByStore([
      conv('1', 3, 'a'),
      conv('2', 1, 'a'),
      conv('3', 0, 'a'),
      conv('4', 5, 'b'),
    ]);
    expect(map.get('a')).toBe(2);
    expect(map.get('b')).toBe(1);
  });

  it('skips conversations without a store and stores with nothing unread', () => {
    const map = unreadByStore([conv('1', 2, null), conv('2', 0, 'a')]);
    expect(map.size).toBe(0);
  });

  it('is empty for no conversations', () => {
    expect(unreadByStore([]).size).toBe(0);
  });
});

describe('downConnections', () => {
  it('returns disconnected and needs_action connections that are not disabled', () => {
    const list = [
      { id: '1', status: 'connected' },
      { id: '2', status: 'disconnected' },
      { id: '3', status: 'needs_action' },
      { id: '4', status: 'disconnected', disabled_at: '2026-01-01' },
      { id: '5', status: 'pending' },
    ];
    expect(downConnections(list).map((c) => c.id)).toEqual(['2', '3']);
  });

  it('tolerates null/empty input', () => {
    expect(downConnections(null)).toEqual([]);
    expect(downConnections(undefined)).toEqual([]);
    expect(downConnections([])).toEqual([]);
  });
});

describe('isConversationConnectionDisabled', () => {
  it('is true only when the embedded connection has disabled_at', () => {
    expect(
      isConversationConnectionDisabled(conv('1', 0, 'a', '2026-01-01'))
    ).toBe(true);
    expect(isConversationConnectionDisabled(conv('1', 0, 'a'))).toBe(false);
    expect(isConversationConnectionDisabled(conv('1', 0, null))).toBe(false);
    expect(isConversationConnectionDisabled(null)).toBe(false);
  });
});

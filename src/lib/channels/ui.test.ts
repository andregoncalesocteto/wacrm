import { describe, expect, it } from 'vitest';
import {
  canDeleteConnection,
  emptyStateKind,
  groupConnectionsByStore,
  type ChannelConnectionRow,
} from './ui';

const conn = (id: string, store_id: string): ChannelConnectionRow => ({
  id,
  store_id,
  channel_type: 'whatsapp_cloud',
  display_name: id,
  status: 'connected',
  disabled_at: null,
  last_inbound_at: null,
  has_conversations: false,
});

describe('groupConnectionsByStore', () => {
  const stores = [
    { id: 's1', name: 'Centro' },
    { id: 's2', name: 'Norte' },
    { id: 's3', name: 'Vazia' },
  ];

  it('groups in store order and skips stores without connections', () => {
    const groups = groupConnectionsByStore(stores, [
      conn('c1', 's2'),
      conn('c2', 's1'),
      conn('c3', 's2'),
    ]);
    expect(groups.map((g) => g.store.id)).toEqual(['s1', 's2']);
    expect(groups[1].connections.map((c) => c.id)).toEqual(['c1', 'c3']);
  });

  it('drops connections of an unknown store', () => {
    expect(groupConnectionsByStore(stores, [conn('c1', 'zz')])).toEqual([]);
  });
});

describe('canDeleteConnection', () => {
  it('only without conversations', () => {
    expect(canDeleteConnection({ has_conversations: false })).toBe(true);
    expect(canDeleteConnection({ has_conversations: true })).toBe(false);
  });
});

describe('emptyStateKind', () => {
  it('distinguishes the three states', () => {
    expect(emptyStateKind(0, 0)).toBe('no-stores');
    expect(emptyStateKind(2, 0)).toBe('no-connections');
    expect(emptyStateKind(2, 1)).toBe('has-connections');
  });
});

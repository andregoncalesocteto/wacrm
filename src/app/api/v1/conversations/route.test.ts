/**
 * Route tests for GET /api/v1/conversations (+ /{id}) with store, connection,
 * channel and contact identities (US-062).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { db, resetWorld, world } from '@/lib/channels/crm-world.fake';

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({ supabase: db, accountId: 'acct-1' }),
}));

const { GET } = await import('./route');
const { GET: getOne } = await import('./[id]/route');

beforeEach(() => {
  resetWorld();
  world.tables.stores = [{ id: 's1', account_id: 'acct-1', name: 'Centro' }];
  world.tables.channel_connections = [
    {
      id: 'conn-tg',
      store_id: 's1',
      channel_type: 'telegram',
      display_name: 'Centro Telegram',
      status: 'connected',
      disabled_at: null,
    },
  ];
  world.tables.contacts = [
    { id: 'c1', account_id: 'acct-1', phone: '', name: 'Maria' },
  ];
  world.tables.contact_identities = [
    {
      id: 'i1',
      account_id: 'acct-1',
      contact_id: 'c1',
      kind: 'telegram:chat_id',
      external_id: '123',
      handle: null,
    },
  ];
  world.tables.conversations = [
    {
      id: 'conv-1',
      account_id: 'acct-1',
      contact_id: 'c1',
      connection_id: 'conn-tg',
      status: 'open',
      unread_count: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'conv-other',
      account_id: 'acct-2',
      contact_id: 'c9',
      connection_id: 'conn-tg',
      status: 'open',
      unread_count: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ];
});

describe('GET /api/v1/conversations', () => {
  it('carries connection_id, store_id, channel and the contact identities', async () => {
    const res = await GET(
      new Request('https://crm.example.com/api/v1/conversations')
    );
    const { data } = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      id: 'conv-1',
      connection_id: 'conn-tg',
      store_id: 's1',
      channel: 'telegram',
    });
    expect(data[0].contact.phone).toBeNull();
    expect(data[0].contact.identities).toEqual([
      { kind: 'telegram:chat_id', external_id: '123', handle: null },
    ]);
  });
});

describe('GET /api/v1/conversations/{id}', () => {
  it('returns the same fields for one conversation', async () => {
    const res = await getOne(
      new Request('https://crm.example.com/api/v1/conversations/conv-1'),
      { params: Promise.resolve({ id: 'conv-1' }) }
    );
    const { data } = await res.json();
    expect(data.channel).toBe('telegram');
    expect(data.store_id).toBe('s1');
    expect(data.connection_id).toBe('conn-tg');
  });

  it('404s for a conversation of another account', async () => {
    const res = await getOne(
      new Request('https://crm.example.com/api/v1/conversations/conv-other'),
      { params: Promise.resolve({ id: 'conv-other' }) }
    );
    expect(res.status).toBe(404);
  });
});

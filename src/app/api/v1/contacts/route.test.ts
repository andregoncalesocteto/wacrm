/**
 * Route tests for /api/v1/contacts with identities (US-062). Auth is stubbed
 * (the scope gate is covered by the stores route test); the route, the shared
 * contact helpers and the identity resolver are real over the in-memory world.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { db, resetWorld, world } from '@/lib/channels/crm-world.fake';

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({ supabase: db, accountId: 'acct-1' }),
}));

const { GET, POST } = await import('./route');
const { GET: getOne } = await import('./[id]/route');

function post(body: unknown): Request {
  return new Request('https://crm.example.com/api/v1/contacts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetWorld();
  world.tables.accounts = [{ id: 'acct-1', owner_user_id: 'owner-1' }];
});

function seedTelegramContact(account = 'acct-1') {
  world.tables.contacts = [
    ...(world.tables.contacts ?? []),
    {
      id: 'c-tg',
      account_id: account,
      phone: '',
      name: 'Maria',
      email: null,
      company: null,
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ];
  world.tables.contact_identities = [
    ...(world.tables.contact_identities ?? []),
    {
      id: 'i1',
      account_id: account,
      contact_id: 'c-tg',
      kind: 'telegram:chat_id',
      external_id: '123456789',
      handle: '@maria',
    },
  ];
}

describe('GET /api/v1/contacts', () => {
  it('returns identities and phone null for a contact without phone', async () => {
    seedTelegramContact();
    const res = await GET(
      new Request('https://crm.example.com/api/v1/contacts')
    );
    const { data } = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].phone).toBeNull();
    expect(data[0].identities).toEqual([
      { kind: 'telegram:chat_id', external_id: '123456789', handle: '@maria' },
    ]);
  });

  it('does not list contacts of another account', async () => {
    seedTelegramContact('acct-2');
    const res = await GET(
      new Request('https://crm.example.com/api/v1/contacts')
    );
    expect((await res.json()).data).toEqual([]);
  });

  it('GET /contacts/{id} carries the same shape', async () => {
    seedTelegramContact();
    const res = await getOne(
      new Request('https://crm.example.com/api/v1/contacts/c-tg'),
      { params: Promise.resolve({ id: 'c-tg' }) }
    );
    const { data } = await res.json();
    expect(data.phone).toBeNull();
    expect(data.identities[0].kind).toBe('telegram:chat_id');
  });
});

describe('POST /api/v1/contacts', () => {
  it('creates a contact from identities alone (no phone)', async () => {
    const res = await POST(
      post({
        name: 'Maria',
        identities: [
          { kind: 'telegram:chat_id', external_id: '555', handle: '@maria' },
        ],
      })
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.phone).toBeNull();
    expect(data.name).toBe('Maria');
    expect(data.identities).toEqual([
      { kind: 'telegram:chat_id', external_id: '555', handle: '@maria' },
    ]);
    expect(world.tables.contacts[0].phone).toBe('');
  });

  it('keeps `phone` as the WhatsApp shortcut (creates a whatsapp:phone identity)', async () => {
    const res = await POST(post({ phone: '+14155550123', name: 'Jane' }));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.phone).toBe('14155550123');
    expect(data.identities.map((i: { kind: string }) => i.kind)).toEqual([
      'whatsapp:phone',
    ]);
  });

  it('accepts phone and identities together on one contact', async () => {
    const res = await POST(
      post({
        phone: '+14155550123',
        identities: [{ kind: 'telegram:chat_id', external_id: '555' }],
      })
    );
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.phone).toBe('14155550123');
    expect(data.identities.map((i: { kind: string }) => i.kind).sort()).toEqual(
      ['telegram:chat_id', 'whatsapp:phone']
    );
    expect(world.tables.contacts).toHaveLength(1);
  });

  it('is find-or-create by identity: 200, same contact, name not overwritten', async () => {
    seedTelegramContact();
    const res = await POST(
      post({
        name: 'Someone else',
        identities: [{ kind: 'telegram:chat_id', external_id: '123456789' }],
      })
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe('c-tg');
    expect(data.name).toBe('Maria');
    expect(world.tables.contacts).toHaveLength(1);
  });

  it('rejects a body with neither phone nor identities', async () => {
    const res = await POST(post({ name: 'x' }));
    expect(res.status).toBe(400);
  });

  it('rejects an unknown identity kind and lists the accepted ones', async () => {
    const res = await POST(
      post({ identities: [{ kind: 'sms:number', external_id: '1' }] })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain('telegram:chat_id');
  });

  it('rejects an invalid whatsapp:phone identity and a malformed entry', async () => {
    const bad = await POST(
      post({ identities: [{ kind: 'whatsapp:phone', external_id: 'abc' }] })
    );
    expect(bad.status).toBe(400);
    const malformed = await POST(
      post({ identities: [{ kind: 'telegram:chat_id' }] })
    );
    expect(malformed.status).toBe(400);
    const notArray = await POST(post({ identities: 'nope' }));
    expect(notArray.status).toBe(400);
    expect(world.tables.contacts ?? []).toHaveLength(0);
  });
});

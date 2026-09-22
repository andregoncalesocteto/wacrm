/**
 * Route tests for GET /api/v1/stores and GET /api/v1/connections (US-061).
 * requireApiKey is REAL (only the key store and the service-role client are
 * stubbed) so the 403 for a missing `connections:read` scope is the real gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { generateApiKey } from '@/lib/api-keys/keys';
import type { ApiKeyRow } from '@/lib/api-keys/store';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  key: null as unknown,
}));

vi.mock('@/lib/api-keys/store', () => ({
  findActiveKeyByHash: async () => h.key,
  touchLastUsed: () => {},
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const filters: ((r: Row) => boolean)[] = [];
      let cols: string[] | null = null;
      const q = {
        select(c: string) {
          cols = c.split(',').map((x) => x.trim());
          return q;
        },
        eq(col: string, v: unknown) {
          filters.push((r) => r[col] === v);
          return q;
        },
        order() {
          return q;
        },
        then<T>(resolve: (v: unknown) => T) {
          const rows = (h.db[table] ?? [])
            .filter((r) => filters.every((f) => f(r)))
            .map((r) =>
              cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : r
            );
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return q;
    },
  }),
}));

const { GET: listStores } = await import('./route');
const { GET: listConnections } = await import('../connections/route');

const KEY = generateApiKey().plaintext;

function req(path: string): Request {
  return new Request(`https://crm.example.com${path}`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
}

function keyRow(scopes: string[]): ApiKeyRow {
  return {
    id: 'key-1',
    account_id: 'acct-1',
    created_by: 'user-1',
    name: 'k',
    scopes,
    expires_at: null,
    revoked_at: null,
  };
}

beforeEach(() => {
  __resetRateLimitForTests();
  h.key = keyRow(['connections:read']);
  h.db = {
    stores: [
      { id: 's1', account_id: 'acct-1', name: 'Loja A', address: 'Rua 1' },
      { id: 's2', account_id: 'acct-2', name: 'Outra conta' },
    ],
    channel_connections: [
      {
        id: 'c1',
        account_id: 'acct-1',
        store_id: 's1',
        channel_type: 'whatsapp_cloud',
        display_name: 'WA',
        external_id: '123',
        status: 'connected',
        disabled_at: null,
        config: { verify_token: 'secret-verify' },
      },
      {
        id: 'c2',
        account_id: 'acct-1',
        store_id: 's3',
        channel_type: 'telegram',
        display_name: 'Bot',
        external_id: '999',
        status: 'connected',
        disabled_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'c3',
        account_id: 'acct-2',
        store_id: 's2',
        channel_type: 'telegram',
        display_name: 'Foreign',
        external_id: '1',
        status: 'connected',
        disabled_at: null,
      },
    ],
    channel_connection_credentials: [
      { connection_id: 'c1', secrets_encrypted: 'TOPSECRET' },
    ],
  };
});

describe('GET /api/v1/stores', () => {
  it('lists only the key account stores', async () => {
    const res = await listStores(req('/api/v1/stores'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((s: Row) => s.id)).toEqual(['s1']);
    expect(body.meta.next_cursor).toBeNull();
  });

  it('403s for a key without connections:read', async () => {
    h.key = keyRow(['contacts:read']);
    const res = await listStores(req('/api/v1/stores'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('401s without a key', async () => {
    h.key = null;
    const res = await listStores(req('/api/v1/stores'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/connections', () => {
  it('lists account connections with channel/enabled and no secrets', async () => {
    const res = await listConnections(req('/api/v1/connections'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((c: Row) => c.id)).toEqual(['c1', 'c2']);
    expect(body.data[0]).toMatchObject({
      channel: 'whatsapp_cloud',
      enabled: true,
      external_id: '123',
    });
    expect(body.data[1]).toMatchObject({ channel: 'telegram', enabled: false });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('secret-verify');
    expect(raw).not.toContain('TOPSECRET');
    expect(body.data[0]).not.toHaveProperty('config');
    expect(body.data[0]).not.toHaveProperty('secrets_encrypted');
  });

  it('filters by store_id', async () => {
    const res = await listConnections(req('/api/v1/connections?store_id=s1'));
    expect((await res.json()).data.map((c: Row) => c.id)).toEqual(['c1']);
  });

  it('403s for a key without connections:read', async () => {
    h.key = keyRow(['messages:send']);
    const res = await listConnections(req('/api/v1/connections'));
    expect(res.status).toBe(403);
  });
});

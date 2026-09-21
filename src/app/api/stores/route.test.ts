import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route tests for /api/stores and /api/stores/[id]. The session client is an
// in-memory fake that honours .eq filters, so account scoping is really
// exercised; the role helper is the real one over a mocked getCurrentAccount.

const h = vi.hoisted(() => ({
  role: 'admin' as string,
  db: {} as Record<string, Array<Record<string, unknown>>>,
  deleteError: null as null | { code: string; message: string },
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/auth/account')>();
  const roles = await import('@/lib/auth/roles');
  const ctx = () => ({
    supabase: makeClient(),
    userId: 'u1',
    accountId: 'acct-1',
    role: h.role,
    account: { id: 'acct-1', name: 'A' },
  });
  return {
    ...orig,
    getCurrentAccount: async () => ctx(),
    requireRole: async (min: import('@/lib/auth/roles').AccountRole) => {
      const c = ctx();
      if (!roles.hasMinRole(c.role as never, min)) {
        throw new orig.ForbiddenError(`This action requires '${min}'`);
      }
      return c;
    },
  };
});

function makeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Record<string, unknown> = {};
      let limit: number | null = null;
      let cols: string[] | null = null;
      const match = () =>
        (h.db[table] ?? []).filter((r) =>
          filters.every(([k, v]) => r[k] === v)
        );
      const run = () => {
        if (op === 'insert') {
          const row = { id: 'new-store', ...payload };
          h.inserted.push(row);
          return { data: [row], error: null };
        }
        if (op === 'update') {
          const rows = match();
          rows.forEach((r) => Object.assign(r, payload));
          return { data: rows, error: null };
        }
        if (op === 'delete') {
          if (h.deleteError) return { data: null, error: h.deleteError };
          const rows = match();
          h.db[table] = (h.db[table] ?? []).filter((r) => !rows.includes(r));
          return { data: rows, error: null };
        }
        const rows = match().map((r) =>
          cols ? Object.fromEntries(cols.map((c) => [c, r[c]])) : r
        );
        return { data: limit ? rows.slice(0, limit) : rows, error: null };
      };
      const b: Record<string, unknown> = {
        select: (c?: string) => (
          (cols = c && c !== '*' ? c.split(',').map((x) => x.trim()) : null),
          b
        ),
        insert: (p: Record<string, unknown>) => (
          (op = 'insert'),
          (payload = p),
          b
        ),
        update: (p: Record<string, unknown>) => (
          (op = 'update'),
          (payload = p),
          b
        ),
        delete: () => ((op = 'delete'), b),
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        order: () => b,
        limit: (n: number) => ((limit = n), b),
        maybeSingle: async () => {
          const r = run();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        single: async () => {
          const r = run();
          return { data: r.data?.[0] ?? null, error: r.error };
        },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(run()).then(res),
      };
      return b;
    },
  };
}

import { GET, POST } from './route';
import { DELETE, PATCH } from './[id]/route';

const json = (body: unknown) =>
  new Request('http://x/api/stores', {
    method: 'POST',
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.role = 'admin';
  h.deleteError = null;
  h.inserted = [];
  h.db = {
    stores: [
      { id: 's1', account_id: 'acct-1', name: 'Centro' },
      { id: 's2', account_id: 'acct-1', name: 'Norte' },
      { id: 'sx', account_id: 'acct-2', name: 'Outra conta' },
    ],
    channel_connections: [
      {
        id: 'c1',
        account_id: 'acct-1',
        store_id: 's1',
        channel_type: 'whatsapp_cloud',
        display_name: 'Loja',
        status: 'connected',
        disabled_at: null,
        config: { secret: 'x' },
      },
      {
        id: 'c2',
        account_id: 'acct-1',
        store_id: 's2',
        channel_type: 'telegram',
        display_name: 'Bot',
        status: 'disconnected',
        disabled_at: '2026-01-01',
      },
    ],
  };
});

describe('GET /api/stores', () => {
  it("lists only the account's stores with a connection summary", async () => {
    h.role = 'viewer';
    const res = await GET();
    expect(res.status).toBe(200);
    const { stores } = await res.json();
    expect(stores.map((s: { id: string }) => s.id)).toEqual(['s1', 's2']);
    expect(stores[0].connections).toEqual([
      {
        id: 'c1',
        channel_type: 'whatsapp_cloud',
        display_name: 'Loja',
        status: 'connected',
        disabled_at: null,
      },
    ]);
    expect(stores[1].connections[0].disabled_at).toBe('2026-01-01');
  });
});

describe('POST /api/stores', () => {
  it('creates with trimmed name and scopes to the account', async () => {
    const res = await POST(
      json({
        name: '  Sul  ',
        address: ' ',
        phone: '123',
        business_hours: { mon: '9-18' },
      })
    );
    expect(res.status).toBe(201);
    expect(h.inserted[0]).toMatchObject({
      name: 'Sul',
      address: null,
      phone: '123',
      account_id: 'acct-1',
      business_hours: { mon: '9-18' },
    });
  });

  it('rejects an empty name', async () => {
    expect((await POST(json({ name: '   ' }))).status).toBe(400);
    expect((await POST(json({}))).status).toBe(400);
  });

  it('rejects a name that is too long', async () => {
    expect((await POST(json({ name: 'a'.repeat(121) }))).status).toBe(400);
  });

  it('rejects bad business_hours / settings', async () => {
    expect((await POST(json({ name: 'a', business_hours: 'x' }))).status).toBe(
      400
    );
    expect((await POST(json({ name: 'a', settings: [] }))).status).toBe(400);
  });

  it('is admin-only: agent gets 403', async () => {
    h.role = 'agent';
    const res = await POST(json({ name: 'Sul' }));
    expect(res.status).toBe(403);
    expect(h.inserted).toHaveLength(0);
  });
});

describe('PATCH /api/stores/[id]', () => {
  const patch = (body: unknown) =>
    new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) });

  it('updates the store', async () => {
    const res = await PATCH(
      patch({ name: ' Novo ', manager_name: 'Ana' }),
      params('s1')
    );
    expect(res.status).toBe(200);
    expect((await res.json()).store).toMatchObject({
      name: 'Novo',
      manager_name: 'Ana',
    });
  });

  it('validates and rejects an empty patch', async () => {
    expect((await PATCH(patch({ name: '' }), params('s1'))).status).toBe(400);
    expect((await PATCH(patch({}), params('s1'))).status).toBe(400);
  });

  it('agent gets 403', async () => {
    h.role = 'agent';
    expect((await PATCH(patch({ name: 'x' }), params('s1'))).status).toBe(403);
  });

  it('store of another account is 404 and untouched', async () => {
    const res = await PATCH(patch({ name: 'hack' }), params('sx'));
    expect(res.status).toBe(404);
    expect(h.db.stores.find((s) => s.id === 'sx')?.name).toBe('Outra conta');
  });
});

describe('DELETE /api/stores/[id]', () => {
  const del = () => new Request('http://x', { method: 'DELETE' });

  it('409 has_connections when the store has a connection', async () => {
    const res = await DELETE(del(), params('s1'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('has_connections');
    expect(h.db.stores.some((s) => s.id === 's1')).toBe(true);
  });

  it('counts disabled connections too', async () => {
    const res = await DELETE(del(), params('s2'));
    expect(res.status).toBe(409);
  });

  it('deletes a store without connections', async () => {
    h.db.channel_connections = [];
    const res = await DELETE(del(), params('s1'));
    expect(res.status).toBe(200);
    expect(h.db.stores.some((s) => s.id === 's1')).toBe(false);
  });

  it('translates the FK violation (race) into 409 has_connections', async () => {
    h.db.channel_connections = [];
    h.deleteError = { code: '23503', message: 'fk' };
    const res = await DELETE(del(), params('s1'));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('has_connections');
  });

  it('agent gets 403; other account 404', async () => {
    h.role = 'agent';
    expect((await DELETE(del(), params('s1'))).status).toBe(403);
    h.role = 'admin';
    expect((await DELETE(del(), params('sx'))).status).toBe(404);
  });
});

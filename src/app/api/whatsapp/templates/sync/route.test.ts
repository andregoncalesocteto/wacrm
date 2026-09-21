import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route test for POST /api/whatsapp/templates/sync. Current behavior (no body
// = the account's default connection, upsert by account/name/language, tagged
// with the connection) is pinned first; then the optional `connection_id`.

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  rows: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  orFilters: [] as string[],
  loadCalls: [] as Array<string | null>,
  ownConnections: new Set<string>(),
  loaded: null as null | {
    connection: { id: string; config: Record<string, unknown> };
    accessToken: string;
  },
  metaPages: [] as Array<{ data: unknown[]; paging?: { next?: string } }>,
  fetchUrls: [] as string[],
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...orig,
    requireRole: async () => {
      if (h.role !== 'admin') throw new orig.ForbiddenError("requires 'admin'");
      return { supabase: makeClient(), accountId: 'acct-1', userId: 'u1' };
    },
  };
});
vi.mock('@/lib/channels/whatsapp-connection', () => ({
  loadWhatsAppSendConnection: async (
    _db: unknown,
    _acct: string,
    opts?: { connectionId?: string | null }
  ) => {
    h.loadCalls.push(opts?.connectionId ?? null);
    return h.loaded;
  },
  isAccountWhatsAppConnection: async (_db: unknown, _a: string, id: string) =>
    h.ownConnections.has(id),
}));

function makeClient() {
  return {
    from() {
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: () => q,
        or: (f: string) => {
          h.orFilters.push(f);
          return q;
        },
        insert: (p: Record<string, unknown>) => {
          op = 'insert';
          payload = p;
          return q;
        },
        update: (p: Record<string, unknown>) => {
          op = 'update';
          payload = p;
          return q;
        },
        maybeSingle: async () => ({ data: h.rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => {
          if (op === 'insert') h.inserted.push(payload);
          if (op === 'update') h.updated.push(payload);
          resolve({ error: null });
        },
      };
      return q;
    },
  };
}

import { POST } from './route';

const post = (body?: unknown) =>
  POST(
    new Request('http://x/api/whatsapp/templates/sync', {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

beforeEach(() => {
  h.role = 'admin';
  h.rows = [];
  h.inserted = [];
  h.updated = [];
  h.orFilters = [];
  h.loadCalls = [];
  h.fetchUrls = [];
  h.ownConnections = new Set(['conn-b']);
  h.loaded = {
    connection: { id: 'conn-a', config: { waba_id: 'waba-1' } },
    accessToken: 'tok',
  };
  h.metaPages = [
    {
      data: [
        {
          id: 'm1',
          name: 'hello',
          language: 'pt_BR',
          status: 'APPROVED',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: 'Oi {{1}}' }],
        },
      ],
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      h.fetchUrls.push(url);
      const page = h.metaPages.shift() ?? { data: [] };
      return { ok: true, json: async () => page } as Response;
    })
  );
});

describe('POST /api/whatsapp/templates/sync (current behavior)', () => {
  it('403 for a non-admin', async () => {
    h.role = 'agent';
    expect((await post()).status).toBe(403);
  });

  it('400 when the account has no usable WhatsApp connection', async () => {
    h.loaded = null;
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not configured/i);
  });

  it('400 when the connection has no waba_id', async () => {
    h.loaded = { connection: { id: 'conn-a', config: {} }, accessToken: 't' };
    expect((await post()).status).toBe(400);
  });

  it('with no body syncs the default connection and inserts tagged rows', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      total: 1,
      inserted: 1,
      updated: 0,
    });
    expect(h.loadCalls).toEqual([null]);
    expect(h.fetchUrls[0]).toContain('/waba-1/message_templates');
    expect(h.inserted[0]).toMatchObject({
      account_id: 'acct-1',
      connection_id: 'conn-a',
      name: 'hello',
      category: 'Utility',
      status: 'APPROVED',
      meta_template_id: 'm1',
      body_text: 'Oi {{1}}',
    });
  });

  it('updates the existing row instead of inserting', async () => {
    h.rows = [{ id: 'row-1' }];
    const res = await post();
    expect(await res.json()).toMatchObject({ inserted: 0, updated: 1 });
    expect(h.updated).toHaveLength(1);
  });

  it('502 with the Meta message when Meta fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'bad token' } }),
      }))
    );
    const res = await post();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('bad token');
  });
});

describe('POST /api/whatsapp/templates/sync with connection_id', () => {
  it('syncs the requested connection', async () => {
    h.loaded = {
      connection: { id: 'conn-b', config: { waba_id: 'waba-2' } },
      accessToken: 'tok-b',
    };
    const res = await post({ connection_id: 'conn-b' });
    expect(res.status).toBe(200);
    expect(h.loadCalls).toEqual(['conn-b']);
    expect(h.fetchUrls[0]).toContain('/waba-2/message_templates');
    expect(h.inserted[0]).toMatchObject({ connection_id: 'conn-b' });
    expect(h.orFilters[0]).toBe(
      'connection_id.eq.conn-b,connection_id.is.null'
    );
  });

  it("404 for a connection that is not the account's WhatsApp connection", async () => {
    const res = await post({ connection_id: 'someone-elses' });
    expect(res.status).toBe(404);
    expect(h.fetchUrls).toHaveLength(0);
  });

  it('400 when connection_id is not a string', async () => {
    expect((await post({ connection_id: 42 })).status).toBe(400);
  });

  it('an empty JSON object keeps the default behavior', async () => {
    expect((await post({})).status).toBe(200);
    expect(h.loadCalls).toEqual([null]);
  });
});

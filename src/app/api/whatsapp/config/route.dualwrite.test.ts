import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decrypt } from '@/lib/whatsapp/encryption';

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  seq: 0,
  failTable: null as string | null,
}));

function makeDb() {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from(table: string) {
      const filters: [string, string, unknown][] = [];
      let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
      let payload: Row = {};
      let opts: Row = {};
      let selectAfter = false;
      let head = false;
      let limit: number | null = null;
      const match = (r: Row) =>
        filters.every(([k, kind, v]) =>
          kind === 'eq' ? r[k] === v : r[k] !== v
        );
      const run = async () => {
        if (h.failTable === table && op !== 'select') {
          return { data: null, error: { message: 'boom' }, count: null };
        }
        const rows = (h.tables[table] ??= []);
        if (op === 'insert') {
          const row = { id: `id-${++h.seq}`, ...payload };
          rows.push(row);
          return { data: [row], error: null, count: null };
        }
        if (op === 'upsert') {
          const key = opts.onConflict as string;
          const ex = rows.find((r) => r[key] === payload[key]);
          if (ex) Object.assign(ex, payload);
          else rows.push({ ...payload });
          return { data: null, error: null, count: null };
        }
        if (op === 'update') {
          rows.filter(match).forEach((r) => Object.assign(r, payload));
          return { data: null, error: null, count: null };
        }
        if (op === 'delete') {
          h.tables[table] = rows.filter((r) => !match(r));
          return { data: null, error: null, count: null };
        }
        let out = rows.filter(match);
        const count = out.length;
        if (limit != null) out = out.slice(0, limit);
        return { data: head ? null : out, error: null, count };
      };
      const q: Record<string, unknown> = {
        select: (_c?: string, o?: Row) => {
          selectAfter = op !== 'select';
          head = !!o?.head;
          return q;
        },
        insert: (v: Row) => ((op = 'insert'), (payload = v), q),
        update: (v: Row) => ((op = 'update'), (payload = v), q),
        upsert: (v: Row, o: Row) => (
          (op = 'upsert'),
          (payload = v),
          (opts = o),
          q
        ),
        delete: () => ((op = 'delete'), q),
        eq: (k: string, v: unknown) => (filters.push([k, 'eq', v]), q),
        neq: (k: string, v: unknown) => (filters.push([k, 'neq', v]), q),
        order: () => q,
        limit: (n: number) => ((limit = n), q),
        maybeSingle: async () => {
          const r = await run();
          return {
            data: (r.data as Row[] | null)?.[0] ?? null,
            error: r.error,
          };
        },
        single: async () => {
          const r = await run();
          return {
            data: (r.data as Row[] | null)?.[0] ?? null,
            error: r.error,
          };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          void selectAfter;
          return run().then(res, rej);
        },
      };
      return q;
    },
  };
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => makeDb() }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeDb(),
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: vi.fn(async () => ({ display_phone_number: '+1 555' })),
  listWabaPhoneNumbers: vi.fn(async () => [{ id: '111' }, { id: '222' }]),
  registerPhoneNumber: vi.fn(async () => ({})),
  subscribeWabaToApp: vi.fn(async () => ({})),
  getSubscribedApps: vi.fn(async () => []),
}));

import { POST, DELETE } from './route';
import { POST as MIRROR } from './mirror-media/route';

const post = (body: Row) =>
  POST(
    new Request('http://x/api/whatsapp/config', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );

const conns = () => h.tables.channel_connections ?? [];
const creds = () => h.tables.channel_connection_credentials ?? [];

beforeEach(() => {
  h.seq = 0;
  h.failTable = null;
  h.tables = {
    profiles: [{ user_id: 'user-1', account_id: 'acc-1' }],
    accounts: [{ id: 'acc-1', name: 'Loja Acme' }],
    whatsapp_config: [],
    stores: [],
    channel_connections: [],
    channel_connection_credentials: [],
    conversations: [],
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const base = {
  phone_number_id: '111',
  waba_id: '999',
  access_token: 'tok-A',
  verify_token: 'vt',
};

describe('POST /api/whatsapp/config dual write', () => {
  it('creates store, connection and credentials next to whatsapp_config', async () => {
    const res = await post({ ...base, pin: '123456' });
    expect((await res.json()).success).toBe(true);

    expect(h.tables.whatsapp_config).toHaveLength(1);
    expect(h.tables.stores).toHaveLength(1);
    expect(h.tables.stores[0]).toMatchObject({
      account_id: 'acc-1',
      name: 'Loja Acme',
    });
    expect(conns()).toHaveLength(1);
    const c = conns()[0];
    expect(c).toMatchObject({
      account_id: 'acc-1',
      store_id: h.tables.stores[0].id,
      channel_type: 'whatsapp_cloud',
      external_id: '111',
      status: 'connected',
      disabled_at: null,
    });
    expect(c.config).toMatchObject({ waba_id: '999' });
    expect((c.config as Row).registered_at).toBeTruthy();
    expect((c.config as Row).subscribed_apps_at).toBeTruthy();
    expect(creds()).toHaveLength(1);
    expect(creds()[0].secrets_format).toBe('json_v1');
    expect(JSON.parse(decrypt(creds()[0].secrets_encrypted as string))).toEqual(
      {
        access_token: 'tok-A',
      }
    );
  });

  it('updates the same connection, and moves external_id when the number changes', async () => {
    await post({ ...base, pin: '123456' });
    const id = conns()[0].id;
    await post({
      ...base,
      phone_number_id: '222',
      access_token: 'tok-B',
      pin: '123456',
    });

    expect(h.tables.whatsapp_config).toHaveLength(1);
    expect(h.tables.stores).toHaveLength(1);
    expect(conns()).toHaveLength(1);
    expect(conns()[0].id).toBe(id);
    expect(conns()[0].external_id).toBe('222');
    expect(creds()).toHaveLength(1);
    expect(JSON.parse(decrypt(creds()[0].secrets_encrypted as string))).toEqual(
      {
        access_token: 'tok-B',
      }
    );
  });

  it('marks the connection disconnected when registration failed', async () => {
    const meta = await import('@/lib/whatsapp/meta-api');
    vi.mocked(meta.registerPhoneNumber).mockRejectedValueOnce(
      new Error('bad pin')
    );
    const res = await post({ ...base, pin: '123456' });
    expect((await res.json()).saved).toBe(true);
    expect(conns()[0].status).toBe('disconnected');
    expect((conns()[0].config as Row).last_registration_error).toBeTruthy();
  });

  it('a failing mirror does not break the legacy save or its response', async () => {
    h.failTable = 'channel_connections';
    const res = await post({ ...base, pin: '123456' });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(h.tables.whatsapp_config).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[channel:whatsapp_cloud]'),
      expect.anything()
    );
  });
});

describe('DELETE /api/whatsapp/config dual write', () => {
  it('removes the connection (and credentials) when it has no conversations', async () => {
    await post({ ...base, pin: '123456' });
    const res = await DELETE();
    expect((await res.json()).success).toBe(true);
    expect(h.tables.whatsapp_config).toHaveLength(0);
    expect(conns()).toHaveLength(0);
  });

  it('disables the connection instead when it has conversations', async () => {
    await post({ ...base, pin: '123456' });
    h.tables.conversations.push({ id: 'conv-1', connection_id: conns()[0].id });
    await DELETE();
    expect(h.tables.whatsapp_config).toHaveLength(0);
    expect(conns()).toHaveLength(1);
    expect(conns()[0].disabled_at).toBeTruthy();
    expect(conns()[0].status).toBe('disconnected');
    expect(creds()).toHaveLength(0);
  });

  it('re-saving after a disable re-enables the same connection', async () => {
    await post({ ...base, pin: '123456' });
    const id = conns()[0].id;
    h.tables.conversations.push({ id: 'conv-1', connection_id: id });
    await DELETE();
    await post({ ...base, pin: '123456' });
    expect(conns()).toHaveLength(1);
    expect(conns()[0]).toMatchObject({
      id,
      disabled_at: null,
      status: 'connected',
    });
    expect(creds()).toHaveLength(1);
  });
});

describe('POST /api/whatsapp/config/mirror-media', () => {
  it('copies mirror_inbound_media from whatsapp_config into the connection config', async () => {
    await post({ ...base, pin: '123456' });
    h.tables.whatsapp_config[0].mirror_inbound_media = false;
    const res = await MIRROR();
    expect((await res.json()).synced).toBe(true);
    expect((conns()[0].config as Row).mirror_inbound_media).toBe(false);
  });

  it('404s without a whatsapp_config row', async () => {
    const res = await MIRROR();
    expect(res.status).toBe(404);
  });
});

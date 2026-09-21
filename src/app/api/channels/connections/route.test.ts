import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';

// Route tests for /api/channels/connections and /[id]. One in-memory db backs
// both the session client and the service-role client (credentials). Deleting
// a connection cascades to its credentials, like the FK does.

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  role: 'admin' as string,
  db: {} as Record<string, Row[]>,
  seq: 0,
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
vi.mock('@/lib/channels/admin-client', () => ({
  supabaseAdmin: () => makeClient(),
}));

function makeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const inFilters: Array<[string, unknown[]]> = [];
      let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
      let payload: Row = {};
      let limit: number | null = null;
      let cols: string[] | null = null;
      const rowsOf = () => (h.db[table] ??= []);
      const match = () =>
        rowsOf().filter(
          (r) =>
            filters.every(([k, v]) => r[k] === v) &&
            inFilters.every(([k, vs]) => vs.includes(r[k]))
        );
      const run = (): { data: Row[] | null; error: unknown } => {
        if (op === 'insert') {
          if (
            table === 'channel_connections' &&
            rowsOf().some(
              (r) =>
                r.channel_type === payload.channel_type &&
                r.external_id === payload.external_id
            )
          ) {
            return { data: null, error: { code: '23505', message: 'dup' } };
          }
          const row = {
            id: `conn-${++h.seq}`,
            last_inbound_at: null,
            last_outbound_at: null,
            last_error: null,
            disabled_at: null,
            ...payload,
          };
          rowsOf().push(row);
          return { data: [row], error: null };
        }
        if (op === 'upsert') {
          const ex = rowsOf().find(
            (r) => r.connection_id === payload.connection_id
          );
          if (ex) Object.assign(ex, payload);
          else rowsOf().push({ ...payload });
          return { data: [payload], error: null };
        }
        if (op === 'update') {
          const rows = match();
          rows.forEach((r) => Object.assign(r, payload));
          return { data: rows, error: null };
        }
        if (op === 'delete') {
          const rows = match();
          h.db[table] = rowsOf().filter((r) => !rows.includes(r));
          if (table === 'channel_connections') {
            const ids = rows.map((r) => r.id);
            h.db.channel_connection_credentials = (
              h.db.channel_connection_credentials ?? []
            ).filter((c) => !ids.includes(c.connection_id));
          }
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
        insert: (p: Row) => ((op = 'insert'), (payload = p), b),
        upsert: (p: Row) => ((op = 'upsert'), (payload = p), b),
        update: (p: Row) => ((op = 'update'), (payload = p), b),
        delete: () => ((op = 'delete'), b),
        eq: (k: string, v: unknown) => (filters.push([k, v]), b),
        in: (k: string, vs: unknown[]) => (inFilters.push([k, vs]), b),
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

const req = (body: unknown, method = 'POST') =>
  new Request('http://x/api/channels/connections', {
    method,
    body: JSON.stringify(body),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const CANARY = 'CANARY_SECRET_TOKEN_123';

const valid = () => ({
  store_id: 's1',
  channel_type: 'whatsapp_cloud',
  display_name: 'Loja Centro',
  config: { waba_id: 'w1', phone_number_id: 'pn-1', verify_token: CANARY },
  credentials: { access_token: CANARY },
});

beforeEach(() => {
  h.role = 'admin';
  h.seq = 0;
  h.db = {
    stores: [
      { id: 's1', account_id: 'acct-1' },
      { id: 's2', account_id: 'acct-1' },
      { id: 'sx', account_id: 'acct-2' },
    ],
    channel_connections: [],
    channel_connection_credentials: [],
    conversations: [],
  };
});

describe('POST /api/channels/connections', () => {
  it('creates a disconnected connection and stores encrypted credentials', async () => {
    const res = await POST(req(valid()));
    expect(res.status).toBe(201);
    const { connection } = await res.json();
    expect(connection).toMatchObject({
      store_id: 's1',
      channel_type: 'whatsapp_cloud',
      display_name: 'Loja Centro',
      external_id: 'pn-1',
      status: 'disconnected',
    });
    const row = h.db.channel_connections[0];
    expect(row.account_id).toBe('acct-1');
    const cred = h.db.channel_connection_credentials[0];
    expect(cred.connection_id).toBe(connection.id);
    expect(cred.secrets_format).toBe('json_v1');
    expect(cred.secrets_encrypted).not.toContain(CANARY);
    expect(JSON.parse(decrypt(cred.secrets_encrypted as string))).toEqual({
      access_token: CANARY,
    });
  });

  it('never returns credentials or secret config (canary)', async () => {
    const res = await POST(req(valid()));
    expect(JSON.stringify(await res.json())).not.toContain(CANARY);
    const list = await GET();
    const body = await list.json();
    expect(JSON.stringify(body)).not.toContain(CANARY);
    expect(body.connections[0].config).toEqual({
      waba_id: 'w1',
      phone_number_id: 'pn-1',
    });
  });

  it('uses an explicit external_id and requires one when not derivable', async () => {
    const v = valid();
    delete (v.config as Record<string, unknown>).phone_number_id;
    expect((await POST(req(v))).status).toBe(400);
    const ok = await POST(req({ ...v, external_id: 'pn-9' }));
    expect((await ok.json()).connection.external_id).toBe('pn-9');
  });

  it('400 for unknown channel type', async () => {
    const res = await POST(req({ ...valid(), channel_type: 'fax' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('unknown_channel_type');
  });

  it('400 with details for invalid config and credentials', async () => {
    const c = await POST(req({ ...valid(), config: { verify_token: 'x' } }));
    expect(c.status).toBe(400);
    expect(await c.json()).toMatchObject({
      code: 'invalid_config',
      details: 'waba_id is required',
    });
    const k = await POST(req({ ...valid(), credentials: {} }));
    expect(k.status).toBe(400);
    expect((await k.json()).code).toBe('invalid_credentials');
    expect(h.db.channel_connections).toHaveLength(0);
  });

  it('400 for missing display_name / store_id / bad JSON', async () => {
    expect((await POST(req({ ...valid(), display_name: ' ' }))).status).toBe(
      400
    );
    expect((await POST(req({ ...valid(), store_id: undefined }))).status).toBe(
      400
    );
    const bad = new Request('http://x', { method: 'POST', body: '{' });
    expect((await POST(bad)).status).toBe(400);
  });

  it('404 for a store of another account', async () => {
    const res = await POST(req({ ...valid(), store_id: 'sx' }));
    expect(res.status).toBe(404);
    expect(h.db.channel_connections).toHaveLength(0);
  });

  it('403 for agent and viewer', async () => {
    for (const role of ['agent', 'viewer']) {
      h.role = role;
      expect((await POST(req(valid()))).status).toBe(403);
    }
    expect(h.db.channel_connections).toHaveLength(0);
  });

  it('409 duplicate_connection for a repeated external id', async () => {
    expect((await POST(req(valid()))).status).toBe(201);
    const res = await POST(req(valid()));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('duplicate_connection');
    expect(h.db.channel_connection_credentials).toHaveLength(1);
  });
});

describe('GET /api/channels/connections', () => {
  it('lists only the account connections, any role', async () => {
    h.db.channel_connections = [
      { id: 'a', account_id: 'acct-1', config: {}, external_id: '1' },
      { id: 'b', account_id: 'acct-2', config: {}, external_id: '2' },
    ];
    h.role = 'viewer';
    const body = await (await GET()).json();
    expect(body.connections.map((c: { id: string }) => c.id)).toEqual(['a']);
  });

  it('flags has_conversations per connection, scoped to the account', async () => {
    h.db.channel_connections = [
      { id: 'a', account_id: 'acct-1', config: {}, external_id: '1' },
      { id: 'b', account_id: 'acct-1', config: {}, external_id: '2' },
    ];
    h.db.conversations = [
      { id: 'c1', account_id: 'acct-1', connection_id: 'a' },
      { id: 'c2', account_id: 'acct-1', connection_id: 'a' },
      { id: 'c3', account_id: 'acct-2', connection_id: 'b' },
    ];
    const body = await (await GET()).json();
    expect(
      Object.fromEntries(
        body.connections.map(
          (c: { id: string; has_conversations: boolean }) => [
            c.id,
            c.has_conversations,
          ]
        )
      )
    ).toEqual({ a: true, b: false });
  });

  it('does not query conversations when there are no connections', async () => {
    const body = await (await GET()).json();
    expect(body.connections).toEqual([]);
  });
});

describe('PATCH /api/channels/connections/[id]', () => {
  let id: string;
  beforeEach(async () => {
    id = (await (await POST(req(valid()))).json()).connection.id;
  });
  const patch = (body: unknown, target = id) =>
    PATCH(req(body, 'PATCH'), params(target));

  it('renames', async () => {
    const res = await patch({ display_name: ' Nova ' });
    expect(res.status).toBe(200);
    expect((await res.json()).connection.display_name).toBe('Nova');
  });

  it('merges config (keeps the hidden verify_token) and validates', async () => {
    const res = await patch({ config: { mirror_inbound_media: true } });
    expect(res.status).toBe(200);
    expect(h.db.channel_connections[0].config).toMatchObject({
      waba_id: 'w1',
      verify_token: CANARY,
      mirror_inbound_media: true,
    });
    const bad = await patch({ config: { mirror_inbound_media: 'yes' } });
    expect(bad.status).toBe(400);
  });

  it('moves to another store of the account, 404 otherwise', async () => {
    expect((await patch({ store_id: 's2' })).status).toBe(200);
    expect(h.db.channel_connections[0].store_id).toBe('s2');
    expect((await patch({ store_id: 'sx' })).status).toBe(404);
    expect(h.db.channel_connections[0].store_id).toBe('s2');
  });

  it('replaces credentials, encrypted, never returned', async () => {
    const res = await patch({ credentials: { access_token: 'NEW_TOKEN_XYZ' } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('NEW_TOKEN_XYZ');
    const cred = h.db.channel_connection_credentials[0];
    expect(cred.secrets_encrypted).not.toContain('NEW_TOKEN_XYZ');
    expect(JSON.parse(decrypt(cred.secrets_encrypted as string))).toEqual({
      access_token: 'NEW_TOKEN_XYZ',
    });
    expect(h.db.channel_connection_credentials).toHaveLength(1);
    expect((await patch({ credentials: {} })).status).toBe(400);
  });

  it('400 on empty patch, 404 on other account / unknown, 403 for agent', async () => {
    expect((await patch({})).status).toBe(400);
    h.db.channel_connections.push({
      id: 'other',
      account_id: 'acct-2',
      channel_type: 'whatsapp_cloud',
      config: {},
    });
    expect((await patch({ display_name: 'x' }, 'other')).status).toBe(404);
    expect((await patch({ display_name: 'x' }, 'nope')).status).toBe(404);
    h.role = 'agent';
    expect((await patch({ display_name: 'x' })).status).toBe(403);
  });
});

describe('PATCH credentials: merge semantics', () => {
  const patch = (target: string, body: unknown) =>
    PATCH(req(body, 'PATCH'), params(target));
  const stored = (connId: string) => {
    const row = h.db.channel_connection_credentials.find(
      (c) => c.connection_id === connId
    )!;
    return JSON.parse(decrypt(row.secrets_encrypted as string));
  };

  it('whatsapp_cloud: a new access_token keeps the other stored keys', async () => {
    const id = (await (await POST(req(valid()))).json()).connection.id;
    h.db.channel_connection_credentials[0].secrets_encrypted = encrypt(
      JSON.stringify({ access_token: 'OLD', app_secret: 'APP_CANARY' })
    );
    const res = await patch(id, { credentials: { access_token: 'NEW' } });
    expect(res.status).toBe(200);
    expect(stored(id)).toEqual({
      access_token: 'NEW',
      app_secret: 'APP_CANARY',
    });
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('NEW');
    expect(text).not.toContain('APP_CANARY');
  });

  describe('telegram (getMe mocked)', () => {
    const OLD = `111:${'A'.repeat(35)}`;
    const SAME_BOT = `111:${'B'.repeat(35)}`;
    const OTHER_BOT = `222:${'C'.repeat(35)}`;
    const fetchMock = vi.fn();
    const getMe = (id: number) =>
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { id } }))
      );

    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
      h.db.channel_connections.push({
        id: 'tg1',
        account_id: 'acct-1',
        store_id: 's1',
        channel_type: 'telegram',
        display_name: 'Bot',
        external_id: '111',
        status: 'connected',
        config: {},
      });
      h.db.channel_connection_credentials.push({
        connection_id: 'tg1',
        account_id: 'acct-1',
        secrets_encrypted: encrypt(
          JSON.stringify({ bot_token: OLD, secret_token: 'WEBHOOK_SECRET' })
        ),
        secrets_format: 'json_v1',
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('only bot_token: keeps secret_token, never returns credentials', async () => {
      getMe(111);
      const res = await patch('tg1', { credentials: { bot_token: SAME_BOT } });
      expect(res.status).toBe(200);
      expect(stored('tg1')).toEqual({
        bot_token: SAME_BOT,
        secret_token: 'WEBHOOK_SECRET',
      });
      const text = JSON.stringify(await res.json());
      expect(text).not.toContain(SAME_BOT);
      expect(text).not.toContain('WEBHOOK_SECRET');
    });

    it('409 credentials_mismatch when getMe returns another bot; nothing stored', async () => {
      getMe(222);
      const res = await patch('tg1', { credentials: { bot_token: OTHER_BOT } });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('credentials_mismatch');
      expect(stored('tg1')).toEqual({
        bot_token: OLD,
        secret_token: 'WEBHOOK_SECRET',
      });
    });

    it('400 invalid_credentials when Telegram rejects the token', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 401,
            description: 'Unauthorized',
          }),
          { status: 401 }
        )
      );
      const res = await patch('tg1', { credentials: { bot_token: SAME_BOT } });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('invalid_credentials');
      expect(stored('tg1').bot_token).toBe(OLD);
    });
  });
});

describe('DELETE /api/channels/connections/[id]', () => {
  let id: string;
  beforeEach(async () => {
    id = (await (await POST(req(valid()))).json()).connection.id;
  });

  it('409 has_conversations when it has any conversation', async () => {
    h.db.conversations = [
      { id: 'cv', account_id: 'acct-1', connection_id: id },
    ];
    const res = await DELETE(req(null, 'DELETE'), params(id));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('has_conversations');
    expect(h.db.channel_connections).toHaveLength(1);
    expect(h.db.channel_connection_credentials).toHaveLength(1);
  });

  it('deletes without conversations and the credentials go too', async () => {
    const res = await DELETE(req(null, 'DELETE'), params(id));
    expect(res.status).toBe(200);
    expect(h.db.channel_connections).toHaveLength(0);
    expect(h.db.channel_connection_credentials).toHaveLength(0);
  });

  it('404 for another account, 403 for agent', async () => {
    h.db.channel_connections.push({ id: 'other', account_id: 'acct-2' });
    expect((await DELETE(req(null, 'DELETE'), params('other'))).status).toBe(
      404
    );
    h.role = 'agent';
    expect((await DELETE(req(null, 'DELETE'), params(id))).status).toBe(403);
    expect(h.db.channel_connections).toHaveLength(2);
  });
});

describe('POST /api/channels/connections (telegram)', () => {
  const TG_TOKEN = '555:TELEGRAM-SECRET_xyz';
  const tg = () => ({
    store_id: 's1',
    channel_type: 'telegram',
    display_name: 'Bot Loja',
    credentials: { bot_token: TG_TOKEN },
  });

  it('derives external_id from getMe (bot id) when it is not sent', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ok: true, result: { id: 42, is_bot: true } })
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await POST(req(tg()));
      expect(res.status).toBe(201);
      const { connection } = await res.json();
      expect(connection).toMatchObject({
        channel_type: 'telegram',
        external_id: '42',
        status: 'disconnected',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(
        `https://api.telegram.org/bot${TG_TOKEN}/getMe`
      );
      const cred = h.db.channel_connection_credentials[0];
      expect(JSON.parse(decrypt(cred.secrets_encrypted as string))).toEqual({
        bot_token: TG_TOKEN,
      });
      expect(JSON.stringify(connection)).not.toContain(TG_TOKEN);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an explicit external_id skips getMe', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await POST(req({ ...tg(), external_id: '77' }));
      expect(res.status).toBe(201);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an invalid token is a 400 and nothing is created', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 401,
            description: 'Unauthorized',
          }),
          { status: 401 }
        )
      )
    );
    try {
      const res = await POST(req(tg()));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('invalid_credentials');
      expect(JSON.stringify(body)).not.toContain(TG_TOKEN);
      expect(h.db.channel_connections).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('Telegram unreachable is a 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    try {
      expect((await POST(req(tg()))).status).toBe(502);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

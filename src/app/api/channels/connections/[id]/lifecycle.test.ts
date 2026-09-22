import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelProvider } from '@/lib/channels/types';

// Route tests for connect / test / disable / enable and GET /providers, with
// a fake provider registered under 'whatsapp_cloud' (builtin bootstrap muted).

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  role: 'admin' as string,
  db: {} as Record<string, Row[]>,
}));

vi.mock('@/lib/channels/providers', () => ({
  registerBuiltinProviders: () => {},
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
      const filters: Array<(r: Row) => boolean> = [];
      let op: 'select' | 'update' = 'select';
      let payload: Row = {};
      let head = false;
      const rowsOf = () => (h.db[table] ??= []);
      const run = () => {
        const rows = rowsOf().filter((r) => filters.every((f) => f(r)));
        if (op === 'update') rows.forEach((r) => Object.assign(r, payload));
        return { data: rows, count: rows.length, error: null };
      };
      const b: Record<string, unknown> = {
        select: (_c?: string, o?: { head?: boolean }) => (
          (head = !!o?.head),
          b
        ),
        update: (p: Row) => ((op = 'update'), (payload = p), b),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), b),
        neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
        maybeSingle: async () => {
          const r = run();
          return { data: r.data[0] ?? null, error: null };
        },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve(head ? { ...run(), data: null } : run()).then(res),
      };
      return b;
    },
  };
}

import {
  registerProvider,
  resetRegistryForTests,
} from '@/lib/channels/registry';
import { POST as connect } from './connect/route';
import { POST as testConn } from './test/route';
import { POST as disable } from './disable/route';
import { POST as enable } from './enable/route';
import { GET as providers } from '../../providers/route';

const CANARY = 'CANARY_SECRET_TOKEN_123';
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request('http://x', {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const fake = {
  type: 'whatsapp_cloud',
  descriptor: { panel: 'custom', fields: [] },
  capabilities: { templates: true },
  connect: vi.fn(),
  disconnect: vi.fn(),
  health: vi.fn(),
} as unknown as ChannelProvider;

const conn = (over: Row = {}): Row => ({
  id: 'c1',
  account_id: 'acct-1',
  store_id: 's1',
  channel_type: 'whatsapp_cloud',
  display_name: 'Loja',
  external_id: 'pn-1',
  status: 'disconnected',
  config: { waba_id: 'w1', verify_token: CANARY },
  disabled_at: null,
  connected_at: null,
  ...over,
});

beforeEach(() => {
  h.role = 'admin';
  h.db = {
    channel_connections: [conn(), conn({ id: 'cx', account_id: 'acct-2' })],
    channel_connection_credentials: [
      { connection_id: 'c1', secrets_encrypted: 'enc' },
    ],
    conversations: [],
  };
  resetRegistryForTests();
  registerProvider(fake);
  vi.mocked(fake.connect).mockReset();
  vi.mocked(fake.disconnect).mockReset();
  vi.mocked(fake.health).mockReset();
});

const row = () => h.db.channel_connections[0];

describe('POST connect', () => {
  it('persists registration state on success and never the PIN', async () => {
    vi.mocked(fake.connect).mockResolvedValue({
      ok: true,
      details: { registration: 'registered' },
    });
    const res = await connect(post({ pin: '123456' }), params('c1'));
    expect(res.status).toBe(200);
    expect(fake.connect).toHaveBeenCalledWith(expect.anything(), {
      pin: '123456',
    });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.connection.status).toBe('connected');
    expect(row().status).toBe('connected');
    expect(row().connected_at).toBeTruthy();
    const cfg = row().config as Row;
    expect(cfg.registered_at).toBeTruthy();
    expect(cfg.subscribed_apps_at).toBeTruthy();
    expect(cfg.last_registration_error).toBeNull();
    expect(JSON.stringify(h.db)).not.toContain('123456');
    expect(JSON.stringify(body)).not.toContain('123456');
    expect(JSON.stringify(body)).not.toContain(CANARY);
  });

  it('skipped registration does not set registered_at', async () => {
    vi.mocked(fake.connect).mockResolvedValue({
      ok: true,
      details: { registration: 'skipped' },
    });
    await connect(post({}), params('c1'));
    const cfg = row().config as Row;
    expect(cfg.registered_at).toBeUndefined();
    expect(cfg.subscribed_apps_at).toBeTruthy();
  });

  it('persists the failure and needs_action on an auth error', async () => {
    vi.mocked(fake.connect).mockResolvedValue({
      ok: false,
      message: 'Token expired',
      error: { code: 'auth', message: 'Token expired' },
    });
    const res = await connect(post({ pin: '654321' }), params('c1'));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, message: 'Token expired' });
    expect(row().status).toBe('needs_action');
    expect(row().last_error).toMatchObject({ code: 'auth' });
    expect((row().config as Row).last_registration_error).toBe('Token expired');
    expect(JSON.stringify(h.db)).not.toContain('654321');
  });

  it('secret_persist_failed after setWebhook: needs_action with the reason, no secret', async () => {
    const message =
      'The webhook was registered but the new secret could not be saved. Connect the channel again.';
    vi.mocked(fake.connect).mockResolvedValue({
      ok: false,
      message,
      error: { code: 'invalid', message, reason: 'secret_persist_failed' },
    });
    const res = await connect(post({}), params('c1'));
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(row().status).toBe('needs_action');
    expect(row().last_error).toMatchObject({
      code: 'invalid',
      reason: 'secret_persist_failed',
    });
    expect(JSON.stringify(h.db)).not.toContain('secret_token');
  });

  it('a transient failure leaves it disconnected; a throw is tolerated', async () => {
    vi.mocked(fake.connect).mockRejectedValue(new Error('boom'));
    const res = await connect(post(), params('c1'));
    expect((await res.json()).ok).toBe(false);
    expect(row().status).toBe('disconnected');
    expect(row().last_error).toMatchObject({ message: 'boom' });
  });

  it('refuses a disabled connection (409)', async () => {
    row().disabled_at = 'x';
    const res = await connect(post(), params('c1'));
    expect(res.status).toBe(409);
    expect(fake.connect).not.toHaveBeenCalled();
  });
});

describe('POST test', () => {
  it('updates status and last_health_check_at', async () => {
    const checkedAt = new Date('2026-01-01T00:00:00Z');
    vi.mocked(fake.health).mockResolvedValue({
      state: 'degraded',
      reason: 'slow',
      checkedAt,
    });
    const res = await testConn(post(), params('c1'));
    const body = await res.json();
    expect(body.health).toEqual({
      state: 'degraded',
      reason: 'slow',
      checked_at: checkedAt.toISOString(),
    });
    expect(row().status).toBe('degraded');
    expect(row().last_health_check_at).toBe(checkedAt.toISOString());
    expect(row().last_error).toMatchObject({ message: 'slow' });
  });

  it('connected clears last_error', async () => {
    row().last_error = { code: 'x' };
    vi.mocked(fake.health).mockResolvedValue({
      state: 'connected',
      checkedAt: new Date(),
    });
    await testConn(post(), params('c1'));
    expect(row().status).toBe('connected');
    expect(row().last_error).toBeNull();
  });
});

describe('POST disable / enable', () => {
  it('disables, keeps credentials and reports open conversations', async () => {
    h.db.conversations = [
      { id: '1', account_id: 'acct-1', connection_id: 'c1', status: 'open' },
      { id: '2', account_id: 'acct-1', connection_id: 'c1', status: 'pending' },
      { id: '3', account_id: 'acct-1', connection_id: 'c1', status: 'closed' },
      { id: '4', account_id: 'acct-1', connection_id: 'other', status: 'open' },
    ];
    const res = await disable(post(), params('c1'));
    const body = await res.json();
    expect(body.open_conversations).toBe(2);
    expect(body.already_disabled).toBe(false);
    expect(row().disabled_at).toBeTruthy();
    expect(row().status).toBe('disconnected');
    expect(h.db.channel_connection_credentials).toHaveLength(1);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it('tolerates a disconnect failure', async () => {
    vi.mocked(fake.disconnect).mockRejectedValue(new Error('meta down'));
    const res = await disable(post(), params('c1'));
    expect(res.status).toBe(200);
    expect(row().disabled_at).toBeTruthy();
  });

  it('is idempotent when already disabled', async () => {
    row().disabled_at = '2026-01-01T00:00:00Z';
    const res = await disable(post(), params('c1'));
    expect((await res.json()).already_disabled).toBe(true);
    expect(row().disabled_at).toBe('2026-01-01T00:00:00Z');
    expect(fake.disconnect).not.toHaveBeenCalled();
  });

  it('enable clears disabled_at and stays disconnected', async () => {
    row().disabled_at = 'x';
    row().status = 'disconnected';
    const res = await enable(post(), params('c1'));
    expect(res.status).toBe(200);
    expect(row().disabled_at).toBeNull();
    expect(row().status).toBe('disconnected');
  });
});

describe('access control', () => {
  it.each([
    ['connect', connect],
    ['test', testConn],
    ['disable', disable],
    ['enable', enable],
  ])('%s: agent gets 403', async (_n, fn) => {
    h.role = 'agent';
    const res = await fn(post(), params('c1'));
    expect(res.status).toBe(403);
  });

  it.each([
    ['connect', connect],
    ['test', testConn],
    ['disable', disable],
    ['enable', enable],
  ])('%s: another account connection is 404', async (_n, fn) => {
    const res = await fn(post(), params('cx'));
    expect(res.status).toBe(404);
    expect(h.db.channel_connections[1].disabled_at).toBeNull();
  });
});

describe('GET /api/channels/providers', () => {
  it('lists type, label key, capabilities and descriptor without secrets', async () => {
    const res = await providers();
    const { providers: list } = await res.json();
    expect(list).toEqual([
      {
        type: 'whatsapp_cloud',
        label: 'Channels.providers.whatsapp_cloud.name',
        capabilities: { templates: true },
        descriptor: { panel: 'custom', fields: [] },
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(CANARY);
  });

  it('any member can read it', async () => {
    h.role = 'viewer';
    expect((await providers()).status).toBe(200);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route test for POST /api/whatsapp/templates/submit. Current behavior (default
// connection, DRY_RUN, Meta failure persisted as DRAFT) is pinned first; then
// the optional `connection_id`.

const h = vi.hoisted(() => ({
  role: 'admin' as 'admin' | 'agent',
  upserts: [] as Array<Record<string, unknown>>,
  loadCalls: [] as Array<string | null>,
  ownConnections: new Set<string>(),
  defaultConn: { id: 'conn-a' } as { id: string } | null,
  loaded: null as null | {
    connection: { id: string; config: Record<string, unknown> };
    accessToken: string;
  },
  submitCalls: [] as Array<Record<string, unknown>>,
  submitError: null as string | null,
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
  findAccountWhatsAppConnection: async () => h.defaultConn,
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
vi.mock('@/lib/whatsapp/meta-api', () => ({
  submitMessageTemplate: async (args: Record<string, unknown>) => {
    h.submitCalls.push(args);
    if (h.submitError) throw new Error(h.submitError);
    return { id: 'meta-1', status: 'PENDING' };
  },
}));
vi.mock('@/lib/whatsapp/template-header-handle', () => ({
  ensureMediaHeaderHandle: async () => undefined,
}));

function makeClient() {
  return {
    from() {
      let row: Record<string, unknown> = {};
      const q = {
        upsert: (r: Record<string, unknown>) => {
          row = r;
          h.upserts.push(r);
          return q;
        },
        select: () => q,
        single: async () => ({ data: { id: 'row-1', ...row }, error: null }),
      };
      return q;
    },
  };
}

import { POST } from './route';

const payload = {
  name: 'hello',
  category: 'Utility',
  language: 'pt_BR',
  body_text: 'Oi',
};
const post = (body: unknown) =>
  POST(
    new Request('http://x/api/whatsapp/templates/submit', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

beforeEach(() => {
  h.role = 'admin';
  h.upserts = [];
  h.loadCalls = [];
  h.submitCalls = [];
  h.submitError = null;
  h.defaultConn = { id: 'conn-a' };
  h.ownConnections = new Set(['conn-b']);
  h.loaded = {
    connection: { id: 'conn-a', config: { waba_id: 'waba-1' } },
    accessToken: 'tok',
  };
  delete process.env.WHATSAPP_TEMPLATES_DRY_RUN;
});

describe('POST /api/whatsapp/templates/submit (current behavior)', () => {
  it('403 for a non-admin', async () => {
    h.role = 'agent';
    expect((await post(payload)).status).toBe(403);
  });

  it('400 on invalid JSON', async () => {
    expect((await post('{nope')).status).toBe(400);
  });

  it('400 for Authentication templates', async () => {
    const res = await post({ ...payload, category: 'Authentication' });
    expect(res.status).toBe(400);
  });

  it('400 on validation failure', async () => {
    expect((await post({ ...payload, body_text: '' })).status).toBe(400);
  });

  it('400 when WhatsApp is not configured', async () => {
    h.loaded = null;
    const res = await post(payload);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not configured/i);
  });

  it('submits through the default connection and saves the row tagged with it', async () => {
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, dry_run: false });
    expect(h.loadCalls).toEqual([null]);
    expect(h.submitCalls[0]).toMatchObject({ wabaId: 'waba-1' });
    expect(h.upserts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'u1',
      connection_id: 'conn-a',
      status: 'PENDING',
      meta_template_id: 'meta-1',
    });
  });

  it('persists a Meta failure as DRAFT and answers 502', async () => {
    h.submitError = 'Meta exploded';
    const res = await post(payload);
    expect(res.status).toBe(502);
    expect(h.upserts[0]).toMatchObject({
      status: 'DRAFT',
      submission_error: 'Meta exploded',
      connection_id: 'conn-a',
    });
  });

  it('DRY_RUN skips Meta and tags the default connection', async () => {
    process.env.WHATSAPP_TEMPLATES_DRY_RUN = 'true';
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dry_run: true });
    expect(h.submitCalls).toHaveLength(0);
    expect(h.upserts[0]).toMatchObject({ connection_id: 'conn-a' });
    expect(String(h.upserts[0].meta_template_id)).toMatch(/^dry-run-/);
  });
});

describe('POST /api/whatsapp/templates/submit with connection_id', () => {
  it('submits through the requested connection', async () => {
    h.loaded = {
      connection: { id: 'conn-b', config: { waba_id: 'waba-2' } },
      accessToken: 'tok-b',
    };
    const res = await post({ ...payload, connection_id: 'conn-b' });
    expect(res.status).toBe(200);
    expect(h.loadCalls).toEqual(['conn-b']);
    expect(h.submitCalls[0]).toMatchObject({ wabaId: 'waba-2' });
    expect(h.upserts[0]).toMatchObject({ connection_id: 'conn-b' });
  });

  it('DRY_RUN tags the requested connection', async () => {
    process.env.WHATSAPP_TEMPLATES_DRY_RUN = 'true';
    await post({ ...payload, connection_id: 'conn-b' });
    expect(h.upserts[0]).toMatchObject({ connection_id: 'conn-b' });
  });

  it("404 for a connection outside the account's WhatsApp connections", async () => {
    const res = await post({ ...payload, connection_id: 'other' });
    expect(res.status).toBe(404);
    expect(h.submitCalls).toHaveLength(0);
    expect(h.upserts).toHaveLength(0);
  });

  it('400 when connection_id is not a string', async () => {
    expect((await post({ ...payload, connection_id: 1 })).status).toBe(400);
  });
});

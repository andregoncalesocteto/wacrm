/**
 * Route-level tests for POST /api/v1/messages (US-026, channel-abstraction).
 * They pin the PUBLIC contract (request fields, envelope, status/error codes)
 * while the send goes through the channel core (sendOutbound). Only the auth
 * gate and the Meta HTTP senders are stubbed; resolve-conversation, the send
 * wrapper and the send core are real, over a stateful in-memory db.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';
import { ApiError } from '@/lib/api/v1/respond';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  authError: null as unknown,
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: h.sendTextMessage,
  sendTemplateMessage: h.sendTemplateMessage,
  sendMediaMessage: h.sendMediaMessage,
}));

vi.mock('@/lib/channels/admin-client', async () => {
  const { fakeCredentialsAdmin } =
    await import('@/lib/channels/credentials-admin.fake');
  return {
    supabaseAdmin: () =>
      fakeCredentialsAdmin(
        () =>
          (h.db.channel_connection_credentials?.[0] as {
            secrets_encrypted: string;
            secrets_format: string;
          }) ?? null
      ),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `dec:${v}`,
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    const b: Record<string, unknown> = {};
    for (const m of ['from', 'update', 'eq', 'select']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: null, error: null });
    return b;
  },
}));

function fakeDb() {
  class Query {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: Row = {};
    private filters: ((r: Row) => boolean)[] = [];
    private mode: 'many' | 'maybe' | 'single' = 'many';
    constructor(private table: string) {}
    select() {
      return this;
    }
    insert(row: Row) {
      this.op = 'insert';
      this.payload = row;
      return this;
    }
    update(patch: Row) {
      this.op = 'update';
      this.payload = patch;
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push((r) => r[col] === v);
      return this;
    }
    like(col: string, pattern: string) {
      const suffix = pattern.replace(/^%/, '');
      this.filters.push((r) => String(r[col] ?? '').endsWith(suffix));
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    maybeSingle() {
      this.mode = 'maybe';
      return this;
    }
    single() {
      this.mode = 'single';
      return this;
    }
    private run() {
      const rows = (h.db[this.table] ??= []);
      let out: Row[];
      if (this.op === 'insert') {
        const row = { id: `${this.table}-${++h.seq}`, ...this.payload };
        rows.push(row);
        out = [row];
      } else if (this.op === 'update') {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
        for (const r of out) Object.assign(r, this.payload);
      } else {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
        if (this.table === 'conversations') {
          out = out.map((c) => ({
            ...c,
            contact: (h.db.contacts ?? []).find((k) => k.id === c.contact_id),
          }));
        }
      }
      if (this.mode === 'many') return { data: out, error: null };
      if (this.mode === 'single' && !out[0]) {
        return { data: null, error: { message: 'no rows' } };
      }
      return { data: out[0] ?? null, error: null };
    }
    then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }
  return { from: (t: string) => new Query(t) };
}

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => {
    if (h.authError) throw h.authError;
    return {
      authType: 'api_key',
      supabase: fakeDb(),
      accountId: 'acct-1',
      keyId: 'key-1',
      scopes: ['messages:send'],
      createdBy: 'user-1',
    };
  }),
}));

import { requireApiKey } from '@/lib/auth/api-context';
import { POST } from './route';

const PHONE = '+15551234567';

function seed(opts: { connection?: boolean; contact?: boolean } = {}) {
  const { connection = true, contact = false } = opts;
  h.db = {
    accounts: [{ id: 'acct-1', owner_user_id: 'owner-1' }],
    contacts: contact
      ? [{ id: 'ct-1', account_id: 'acct-1', phone: PHONE, name: 'Known' }]
      : [],
    conversations: [],
    messages: [],
    message_templates: [],
    channel_connections: connection
      ? [whatsappConnectionRow('acct-1', 'pn-1')]
      : [],
    channel_connection_credentials: [
      { secrets_encrypted: 'cipher', secrets_format: 'wa_token_v0' },
    ],
  };
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  h.seq = 0;
  h.authError = null;
  h.sendTextMessage.mockReset().mockResolvedValue({ messageId: 'wamid-text' });
  h.sendTemplateMessage
    .mockReset()
    .mockResolvedValue({ messageId: 'wamid-tpl' });
  h.sendMediaMessage
    .mockReset()
    .mockResolvedValue({ messageId: 'wamid-media' });
  seed();
});

describe('POST /api/v1/messages', () => {
  it('sends text to an unknown number: creates contact + conversation with connection_id (201)', async () => {
    const res = await post({ to: PHONE, text: 'Hello!', name: 'Jane' });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json).toEqual({
      data: {
        message_id: expect.any(String),
        whatsapp_message_id: 'wamid-text',
        conversation_id: expect.any(String),
        contact_id: expect.any(String),
        contact_created: true,
      },
    });
    expect(h.db.contacts).toHaveLength(1);
    expect(h.db.contacts[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'owner-1',
      name: 'Jane',
    });
    expect(h.db.conversations).toHaveLength(1);
    expect(h.db.conversations[0]).toMatchObject({
      id: json.data.conversation_id,
      contact_id: json.data.contact_id,
      connection_id: 'conn-acct-1',
    });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.db.messages).toHaveLength(1);
    expect(h.db.messages[0]).toMatchObject({
      id: json.data.message_id,
      conversation_id: json.data.conversation_id,
      content_type: 'text',
      content_text: 'Hello!',
      message_id: 'wamid-text',
      sender_type: 'agent',
    });
  });

  it('reuses the existing contact and conversation (contact_created false)', async () => {
    seed({ contact: true });
    const first = await (await post({ to: PHONE, text: 'one' })).json();
    const second = await post({ to: PHONE, text: 'two' });
    const json = await second.json();

    expect(second.status).toBe(201);
    expect(first.data.contact_created).toBe(false);
    expect(json.data.contact_created).toBe(false);
    expect(json.data.contact_id).toBe('ct-1');
    expect(json.data.conversation_id).toBe(first.data.conversation_id);
    expect(h.db.contacts).toHaveLength(1);
    expect(h.db.conversations).toHaveLength(1);
    expect(h.db.messages).toHaveLength(2);
  });

  it('sends a template with positional params', async () => {
    const res = await post({
      to: PHONE,
      type: 'template',
      template: { name: 'order_update', language: 'en_US', params: ['A123'] },
    });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.whatsapp_message_id).toBe('wamid-tpl');
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    const args = (h.sendTemplateMessage.mock.calls[0] as unknown[])[0] as Row;
    expect(args.templateName).toBe('order_update');
    expect(args.to).toBe('15551234567');
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'template',
      template_name: 'order_update',
    });
  });

  it('sends media with caption', async () => {
    const res = await post({
      to: PHONE,
      type: 'document',
      media_url: 'https://example.com/invoice.pdf',
      filename: 'invoice.pdf',
      text: 'Your invoice',
    });
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.data.whatsapp_message_id).toBe('wamid-media');
    expect(h.sendMediaMessage).toHaveBeenCalledTimes(1);
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'document',
      content_text: 'Your invoice',
      media_url: 'https://example.com/invoice.pdf',
    });
  });

  it('400 whatsapp_not_configured when the account has no connection; nothing created', async () => {
    seed({ connection: false });
    const res = await post({ to: PHONE, text: 'Hi' });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('whatsapp_not_configured');
    expect(h.db.contacts).toHaveLength(0);
    expect(h.db.conversations).toHaveLength(0);
    expect(h.db.messages).toHaveLength(0);
  });

  it('502 meta_error when Meta rejects: no message persisted, conversation not updated', async () => {
    h.sendTextMessage.mockRejectedValue(new Error('(#100) boom'));
    const res = await post({ to: PHONE, text: 'Hi' });
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.error.code).toBe('meta_error');
    expect(json.error.message).toContain('boom');
    expect(h.db.messages).toHaveLength(0);
    expect(h.db.conversations[0]?.last_message_text).toBeUndefined();
  });

  it('400 bad_request on invalid input, before any contact is created', async () => {
    for (const body of [
      '[]',
      {},
      { to: '123', text: 'x' },
      { to: PHONE, type: 'text' },
      { to: PHONE, type: 'image' },
      { to: PHONE, type: 'template' },
    ]) {
      const res = await post(body);
      const json = await res.json();
      expect(res.status).toBe(400);
      expect(json.error.code).toBe('bad_request');
    }
    expect(h.db.contacts).toHaveLength(0);
    expect(h.db.conversations).toHaveLength(0);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('passes through auth/scope/rate-limit errors from requireApiKey', async () => {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [429, 'rate_limited'],
    ] as const) {
      h.authError = new ApiError(code, 'nope', status);
      const res = await post({ to: PHONE, text: 'Hi' });
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
    expect(vi.mocked(requireApiKey)).toHaveBeenCalledWith(
      expect.any(Request),
      'messages:send'
    );
    expect(h.db.messages).toHaveLength(0);
  });
});

describe('POST /api/v1/messages disabled connection (US-078)', () => {
  it('answers 409 connection_disabled, never calls Meta and stores no message', async () => {
    h.db.channel_connections = [
      whatsappConnectionRow('acct-1', 'pn-1', {
        disabled_at: '2026-09-01T00:00:00Z',
      }),
    ];
    const res = await post({ to: PHONE, text: 'Hello!' });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe('connection_disabled');
    expect(json.error.message).toEqual(expect.any(String));
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    expect(h.db.messages).toHaveLength(0);
  });
});

/**
 * Characterization tests for the WhatsApp inbound webhook (US-002,
 * channel-abstraction). They pin the CURRENT observable behaviour of
 * `route.ts` so the later refactor to a provider contract cannot change it.
 *
 * Unlike `route.test.ts` (which mocks each query chain), this file drives
 * the route through a small stateful in-memory fake of the Supabase client,
 * with the REAL signature check, encryption, identity resolution and
 * contact de-duplication, so a scenario spans several deliveries
 * (replay, second message from the same person, status ladder...).
 * Only the fan-out engines and the Meta HTTP client are stubbed.
 */
import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  afterCallbacks: [] as (() => Promise<void> | void)[],
  db: {} as Record<string, Row[]>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  seq: 0,
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
}));

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.afterCallbacks.push(cb);
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}));

// ---- Stateful fake of the supabase-js query builder ---------------------

vi.mock('@supabase/supabase-js', () => {
  type Filter = (r: Row) => boolean;

  class Query {
    private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    private payload: Row | Row[] = {};
    private filters: Filter[] = [];
    private opts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    private head = false;
    private lim: number | null = null;
    private mode: 'many' | 'maybe' | 'single' = 'many';

    constructor(private table: string) {}

    private rows() {
      return (h.db[this.table] ??= []);
    }
    select(_cols?: string, o?: { head?: boolean }) {
      if (o?.head) this.head = true;
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
    upsert(
      row: Row | Row[],
      o: { onConflict?: string; ignoreDuplicates?: boolean }
    ) {
      this.op = 'upsert';
      this.payload = row;
      this.opts = o;
      return this;
    }
    delete() {
      this.op = 'delete';
      return this;
    }
    eq(col: string, v: unknown) {
      // Embedded-resource filters (`broadcasts.account_id`) are joins the
      // fake does not model; they are not what these tests characterize.
      if (!col.includes('.')) this.filters.push((r) => r[col] === v);
      return this;
    }
    is(col: string, v: unknown) {
      // `.is(col, null)`: the ingestion core adopts NULL-connection threads.
      this.filters.push((r) => (v === null ? r[col] == null : r[col] === v));
      return this;
    }
    in(col: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[col]));
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
    limit(n: number) {
      this.lim = n;
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

    private matches() {
      return this.rows().filter((r) => this.filters.every((f) => f(r)));
    }

    private run(): { data: unknown; error: unknown; count?: number } {
      const rows = this.rows();
      let out: Row[] = [];
      if (this.op === 'insert') {
        const row = { id: `${this.table}-${++h.seq}`, ...(this.payload as Row) };
        rows.push(row);
        out = [row];
      } else if (this.op === 'upsert') {
        const keys = (this.opts.onConflict ?? 'id').split(',');
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const payload of list) {
          const hit = rows.find((r) => keys.every((k) => r[k] === payload[k]));
          if (hit) {
            if (!this.opts.ignoreDuplicates) {
              Object.assign(hit, payload);
              out.push(hit);
            }
          } else {
            const row = { id: `${this.table}-${++h.seq}`, ...payload };
            rows.push(row);
            out.push(row);
          }
        }
      } else if (this.op === 'update') {
        out = this.matches();
        for (const r of out) Object.assign(r, this.payload);
      } else if (this.op === 'delete') {
        const gone = new Set(this.matches());
        h.db[this.table] = rows.filter((r) => !gone.has(r));
        out = [...gone];
      } else {
        out = this.matches();
        if (this.head) return { data: null, error: null, count: out.length };
        if (this.lim !== null) out = out.slice(0, this.lim);
      }
      if (this.mode === 'many') return { data: out, error: null };
      const first = out[0] ?? null;
      return { data: first, error: null };
    }

    then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
      try {
        return Promise.resolve(this.run()).then(resolve, reject);
      } catch (e) {
        return Promise.reject(e).then(resolve, reject);
      }
    }
  }

  return {
    createClient: () => ({
      from(table: string) {
        return new Query(table);
      },
      rpc(name: string, args: Record<string, unknown>) {
        h.rpcCalls.push({ name, args });
        return Promise.resolve({ data: null, error: null });
      },
      storage: {},
    }),
  };
});

vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(async () => ({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })),
  downloadMedia: vi.fn(),
}));
vi.mock('@/lib/whatsapp/template-webhook', () => ({
  isTemplateWebhookField: (f: string) => f.startsWith('message_template_'),
  handleTemplateWebhookChange: vi.fn(),
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}));
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}));

import { GET, POST } from './route';
import { encrypt } from '@/lib/whatsapp/encryption';

const ACCOUNT = 'acc-1';

function sign(raw: string): string {
  return (
    'sha256=' +
    crypto
      .createHmac('sha256', process.env.META_APP_SECRET as string)
      .update(raw)
      .digest('hex')
  );
}

function post(body: unknown, signature?: string | null) {
  const raw = JSON.stringify(body);
  const sig = signature === undefined ? sign(raw) : signature;
  return POST({
    text: async () => raw,
    headers: { get: (n: string) => (n === 'x-hub-signature-256' ? sig : null) },
  } as unknown as Request);
}

async function deliver(value: Record<string, unknown>) {
  const res = await post({
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: { metadata: { phone_number_id: 'pn-1' }, ...value },
          },
        ],
      },
    ],
  });
  // Drain after() exactly as the runtime would.
  const cbs = h.afterCallbacks.splice(0);
  for (const cb of cbs) await cb();
  return res;
}

const inbound = (
  message: Record<string, unknown>,
  contacts: Record<string, unknown>[]
) => deliver({ messages: [message], contacts });

const status = (s: Record<string, unknown>) =>
  deliver({
    statuses: [{ timestamp: '1700000100', recipient_id: '15551230000', ...s }],
  });

const TEXT = {
  id: 'wamid.T1',
  from: '15551230000',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hello' },
};
const ADA = [{ wa_id: '15551230000', profile: { name: 'Ada' } }];

const table = (name: string) => (h.db[name] ??= []);

beforeEach(() => {
  vi.clearAllMocks();
  h.db = {};
  h.rpcCalls = [];
  h.seq = 0;
  h.afterCallbacks = [];
  h.db.accounts = [{ id: ACCOUNT, owner_user_id: 'user-1' }];
  h.db.channel_connections = [
    {
      id: 'conn-1',
      account_id: ACCOUNT,
      channel_type: 'whatsapp_cloud',
      external_id: 'pn-1',
      status: 'connected',
      disabled_at: null,
      config: {
        verify_token: encrypt('my-verify-token'),
        // Off: keeps the media mirror out of the way (proxy URL is stored).
        mirror_inbound_media: false,
      },
    },
  ];
  h.db.channel_connection_credentials = [
    {
      connection_id: 'conn-1',
      secrets_encrypted: encrypt('plain-token'),
      secrets_format: 'wa_token_v0',
    },
  ];
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false });
  h.dispatchInboundToAiReply.mockResolvedValue(undefined);
  h.dispatchWebhookEvent.mockResolvedValue(undefined);
  h.runAutomationsForTrigger.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('webhook GET: Meta verification handshake', () => {
  const get = (qs: string) =>
    GET({ url: `https://crm.test/api/whatsapp/webhook?${qs}` } as Request);

  it('echoes the challenge as plain text when the verify token matches a stored config', async () => {
    const res = (await get(
      'hub.mode=subscribe&hub.challenge=12345&hub.verify_token=my-verify-token'
    )) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    expect(await res.text()).toBe('12345');
  });

  it('403 on a token that matches no config', async () => {
    const res = (await get(
      'hub.mode=subscribe&hub.challenge=1&hub.verify_token=nope'
    )) as unknown as { init: { status: number } };
    expect(res.init.status).toBe(403);
  });

  it('400 when mode/challenge/token are missing or mode is not subscribe', async () => {
    for (const qs of [
      'hub.mode=subscribe&hub.challenge=1',
      'hub.mode=subscribe&hub.verify_token=my-verify-token',
      'hub.mode=unsubscribe&hub.challenge=1&hub.verify_token=my-verify-token',
    ]) {
      const res = (await get(qs)) as unknown as { init: { status: number } };
      expect(res.init.status).toBe(400);
    }
  });
});

describe('webhook POST: signature and payload guards', () => {
  it('401 on an invalid or missing signature and processes nothing', async () => {
    for (const sig of ['sha256=deadbeef', null]) {
      const res = (await post({ entry: [] }, sig)) as unknown as {
        init: { status: number };
      };
      expect(res.init.status).toBe(401);
    }
    expect(h.afterCallbacks).toHaveLength(0);
  });

  it('400 on a correctly signed body that is not JSON', async () => {
    const raw = 'not json';
    const res = (await POST({
      text: async () => raw,
      headers: { get: () => sign(raw) },
    } as unknown as Request)) as unknown as { init: { status: number } };
    expect(res.init.status).toBe(400);
  });

  it('acks 200 immediately and defers processing to after()', async () => {
    const res = (await post({
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                messages: [TEXT],
                contacts: ADA,
              },
            },
          ],
        },
      ],
    })) as unknown as { init: { status: number }; body: unknown };
    expect(res.init.status).toBe(200);
    expect(res.body).toEqual({ status: 'received' });
    expect(table('messages')).toHaveLength(0); // nothing written before after()
    for (const cb of h.afterCallbacks.splice(0)) await cb();
    expect(table('messages')).toHaveLength(1);
  });

  it('stamps a new conversation with the connection that received the message', async () => {
    await inbound(TEXT, ADA);
    expect(table('conversations')[0].connection_id).toBe('conn-1');
  });

  it('drops a delivery whose phone_number_id has no config', async () => {
    h.db.channel_connections = [];
    await inbound(TEXT, ADA);
    expect(table('contacts')).toHaveLength(0);
    expect(table('messages')).toHaveLength(0);
  });
});

describe('inbound: contact and conversation resolution', () => {
  it('a new number creates a contact (phone + profile name) and a conversation, stamped with the account', async () => {
    await inbound(TEXT, ADA);

    expect(table('contacts')).toHaveLength(1);
    expect(table('contacts')[0]).toMatchObject({
      account_id: ACCOUNT,
      user_id: 'user-1',
      phone: '15551230000',
      name: 'Ada',
    });
    expect(table('conversations')).toHaveLength(1);
    expect(table('conversations')[0]).toMatchObject({
      account_id: ACCOUNT,
      contact_id: table('contacts')[0].id,
    });
    expect(table('messages')[0]).toMatchObject({
      conversation_id: table('conversations')[0].id,
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.T1',
      status: 'delivered',
    });
    // Just-created contact/conversation are announced; a first message
    // fires both relationship triggers.
    expect(h.dispatchWebhookEvent.mock.calls.map((c) => c[2])).toEqual([
      'conversation.created',
      'message.received',
    ]);
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (c) => c[0].triggerType
    );
    expect(triggers).toEqual(
      expect.arrayContaining(['new_contact_created', 'first_inbound_message'])
    );
  });

  it('a known number (any formatting of the same digits) reuses contact and conversation', async () => {
    await inbound(TEXT, ADA);
    await inbound({ ...TEXT, id: 'wamid.T2', from: '+1 (555) 123-0000' }, [
      { wa_id: '+1 (555) 123-0000', profile: { name: 'Ada' } },
    ]);

    expect(table('contacts')).toHaveLength(1);
    expect(table('conversations')).toHaveLength(1);
    expect(table('messages')).toHaveLength(2);
    // Second delivery is not "new contact" nor "first inbound".
    const triggers = h.runAutomationsForTrigger.mock.calls
      .slice(-3)
      .map((c) => c[0].triggerType);
    expect(triggers).not.toContain('new_contact_created');
    expect(triggers).not.toContain('first_inbound_message');
  });

  it('an existing contact without a conversation gets one created', async () => {
    table('contacts').push({
      id: 'c-manual',
      account_id: ACCOUNT,
      phone: '15551230000',
      name: 'Ada',
    });
    await inbound(TEXT, ADA);
    expect(table('contacts')).toHaveLength(1);
    expect(table('conversations')).toHaveLength(1);
    expect(table('conversations')[0].contact_id).toBe('c-manual');
  });

  it('a contact from another account with the same number is not reused', async () => {
    table('contacts').push({
      id: 'c-other',
      account_id: 'acc-2',
      phone: '15551230000',
      name: 'Other',
    });
    await inbound(TEXT, ADA);
    expect(table('contacts')).toHaveLength(2);
    expect(table('conversations')[0].contact_id).not.toBe('c-other');
  });

  it('a closed conversation is reopened by a new inbound message', async () => {
    table('contacts').push({
      id: 'c-1',
      account_id: ACCOUNT,
      phone: '15551230000',
      name: 'Ada',
    });
    table('conversations').push({
      id: 'conv-closed',
      account_id: ACCOUNT,
      contact_id: 'c-1',
      status: 'closed',
    });
    await inbound(TEXT, ADA);
    expect(table('conversations')).toHaveLength(1);
    expect(table('conversations')[0].status).toBe('open');
    expect(table('messages')[0].conversation_id).toBe('conv-closed');
  });

  it('bumps unread/last-message once per genuine message through the RPC', async () => {
    await inbound(TEXT, ADA);
    expect(h.rpcCalls).toEqual([
      {
        name: 'bump_conversation_on_inbound',
        args: {
          p_conversation_id: table('conversations')[0].id,
          p_last_message_text: 'hello',
        },
      },
    ]);
  });
});

describe('inbound: replay of the same message is idempotent', () => {
  it('resending the same wamid stores one row and fires no second bump or fan-out', async () => {
    await inbound(TEXT, ADA);
    const rpcAfterFirst = h.rpcCalls.length;
    const automationsAfterFirst = h.runAutomationsForTrigger.mock.calls.length;
    const eventsAfterFirst = h.dispatchWebhookEvent.mock.calls.length;
    const flowsAfterFirst = h.dispatchInboundToFlows.mock.calls.length;
    const aiAfterFirst = h.dispatchInboundToAiReply.mock.calls.length;

    await inbound(TEXT, ADA);

    expect(table('messages')).toHaveLength(1);
    expect(table('contacts')).toHaveLength(1);
    expect(table('conversations')).toHaveLength(1);
    expect(h.rpcCalls).toHaveLength(rpcAfterFirst);
    expect(h.runAutomationsForTrigger.mock.calls).toHaveLength(
      automationsAfterFirst
    );
    expect(h.dispatchWebhookEvent.mock.calls).toHaveLength(eventsAfterFirst);
    expect(h.dispatchInboundToFlows.mock.calls).toHaveLength(flowsAfterFirst);
    expect(h.dispatchInboundToAiReply.mock.calls).toHaveLength(aiAfterFirst);
  });

  it('the idempotency key is (conversation, external id): a different id is a new message', async () => {
    await inbound(TEXT, ADA);
    await inbound({ ...TEXT, id: 'wamid.T2' }, ADA);
    expect(table('messages').map((m) => m.message_id)).toEqual([
      'wamid.T1',
      'wamid.T2',
    ]);
  });

  it('the same external id in ANOTHER conversation is not a duplicate', async () => {
    // Meta ids can repeat across numbers (migration 009): only the pair is unique.
    await inbound(TEXT, ADA);
    const other = [{ wa_id: '15559990000', profile: { name: 'Bob' } }];
    await inbound({ ...TEXT, from: '15559990000' }, other);
    expect(table('conversations')).toHaveLength(2);
    expect(table('messages')).toHaveLength(2);
  });
});

describe('inbound: sender identified only by BSUID / username', () => {
  const MSG = {
    id: 'wamid.B1',
    from_user_id: 'US.1111111',
    timestamp: '1700000000',
    type: 'text',
    text: { body: 'oi' },
  };
  const CONTACTS = [
    {
      profile: { name: 'Sheena', username: 'sheena_n' },
      user_id: 'US.1111111',
    },
  ];

  it('creates a phone-less contact keyed on the BSUID, and finds it again on the next message', async () => {
    await inbound(MSG, CONTACTS);
    expect(table('contacts')).toHaveLength(1);
    expect(table('contacts')[0]).toMatchObject({
      phone: '', // contacts.phone stays NOT NULL: '' for "no phone"
      name: 'Sheena',
    });
    expect(
      table('contact_identities')
        .filter((i) => i.contact_id === table('contacts')[0].id)
        .map((i) => i.kind)
        .sort()
    ).toEqual(['whatsapp:bsuid', 'whatsapp:username']);

    await inbound({ ...MSG, id: 'wamid.B2' }, CONTACTS);
    expect(table('contacts')).toHaveLength(1);
    expect(table('conversations')).toHaveLength(1);
    expect(table('messages')).toHaveLength(2);
  });

  it('a message with neither phone nor BSUID is dropped without creating anything', async () => {
    await inbound(
      {
        id: 'wamid.X',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'x' },
      },
      [{ profile: { name: 'Ghost' } }]
    );
    expect(table('contacts')).toHaveLength(0);
    expect(table('messages')).toHaveLength(0);
  });

  it('backfills the BSUID onto a contact first known by phone, so a later phone-less message matches it', async () => {
    await inbound(TEXT, ADA);
    await inbound({ ...TEXT, id: 'wamid.T2' }, [
      {
        wa_id: '15551230000',
        profile: { name: 'Ada', username: 'ada' },
        user_id: 'US.2222222',
      },
    ]);
    expect(table('contacts')).toHaveLength(1);
    expect(
      table('contact_identities')
        .filter((i) => i.contact_id === table('contacts')[0].id)
        .map((i) => i.kind)
        .sort()
    ).toEqual(['whatsapp:bsuid', 'whatsapp:phone', 'whatsapp:username']);

    await inbound(
      {
        id: 'wamid.T3',
        from_user_id: 'US.2222222',
        timestamp: '1700000000',
        type: 'text',
        text: { body: 'again' },
      },
      [{ profile: { name: 'Ada' }, user_id: 'US.2222222' }]
    );
    expect(table('contacts')).toHaveLength(1);
    expect(table('messages')).toHaveLength(3);
  });
});

describe('inbound: content types', () => {
  it('image with media stores the proxy URL and MIME type when mirroring is off', async () => {
    await inbound(
      {
        id: 'wamid.I1',
        from: '15551230000',
        timestamp: '1700000000',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'look' },
      },
      ADA
    );
    expect(table('messages')[0]).toMatchObject({
      content_type: 'image',
      content_text: 'look',
      media_url: '/api/whatsapp/media/media-1',
      media_type: 'image/jpeg',
    });
  });

  it('document media keeps its content type and the media reference', async () => {
    await inbound(
      {
        id: 'wamid.D1',
        from: '15551230000',
        timestamp: '1700000000',
        type: 'document',
        document: {
          id: 'media-2',
          mime_type: 'application/pdf',
          filename: 'a.pdf',
        },
      },
      ADA
    );
    expect(table('messages')[0]).toMatchObject({
      content_type: 'document',
      media_url: '/api/whatsapp/media/media-2',
      media_type: 'application/pdf',
    });
  });

  it('sticker is stored as an image', async () => {
    await inbound(
      {
        id: 'wamid.S1',
        from: '15551230000',
        timestamp: '1700000000',
        type: 'sticker',
        sticker: { id: 'media-3', mime_type: 'image/webp' },
      },
      ADA
    );
    expect(table('messages')[0]).toMatchObject({
      content_type: 'image',
      media_url: '/api/whatsapp/media/media-3',
      media_type: 'image/webp',
    });
  });

  it('a type outside the allowed set falls back to text', async () => {
    await inbound(
      {
        id: 'wamid.U1',
        from: '15551230000',
        timestamp: '1700000000',
        type: 'unsupported',
      },
      ADA
    );
    expect(table('messages')[0].content_type).toBe('text');
  });
});

describe('inbound: reactions', () => {
  async function withTarget() {
    await inbound(TEXT, ADA);
  }
  const reaction = (emoji: string, target = 'wamid.T1', id = 'wamid.R1') => ({
    id,
    from: '15551230000',
    timestamp: '1700000005',
    type: 'reaction',
    reaction: { message_id: target, emoji },
  });

  it('records a reaction on the target message and does not create a message', async () => {
    await withTarget();
    const rpcBefore = h.rpcCalls.length;
    await inbound(reaction('👍'), ADA);

    expect(table('message_reactions')).toHaveLength(1);
    expect(table('message_reactions')[0]).toMatchObject({
      message_id: table('messages')[0].id,
      conversation_id: table('conversations')[0].id,
      actor_type: 'customer',
      actor_id: table('contacts')[0].id,
      emoji: '👍',
    });
    expect(table('messages')).toHaveLength(1);
    expect(h.rpcCalls).toHaveLength(rpcBefore); // no unread bump
  });

  it('a second reaction from the same contact replaces the first', async () => {
    await withTarget();
    await inbound(reaction('👍'), ADA);
    await inbound(reaction('❤️', 'wamid.T1', 'wamid.R2'), ADA);
    expect(table('message_reactions')).toHaveLength(1);
    expect(table('message_reactions')[0].emoji).toBe('❤️');
  });

  it('an empty emoji removes the reaction', async () => {
    await withTarget();
    await inbound(reaction('👍'), ADA);
    await inbound(reaction('', 'wamid.T1', 'wamid.R2'), ADA);
    expect(table('message_reactions')).toHaveLength(0);
  });

  it('a reaction to an unknown message is skipped without error', async () => {
    await withTarget();
    await inbound(reaction('👍', 'wamid.NOPE'), ADA);
    expect(table('message_reactions')).toHaveLength(0);
    expect(table('messages')).toHaveLength(1);
  });
});

describe('status webhooks: message mirror and failure reason', () => {
  beforeEach(() => {
    table('messages').push({
      id: 'm-1',
      conversation_id: 'conv-x',
      message_id: 'wamid.OUT1',
      status: 'sent',
    });
  });

  it.each(['sent', 'delivered', 'read'])(
    'mirrors %s onto the message without error columns',
    async (s) => {
      await status({ id: 'wamid.OUT1', status: s });
      expect(table('messages')[0].status).toBe(s);
      expect(table('messages')[0]).not.toHaveProperty('error_code');
    }
  );

  it('failed records Meta code, title and details on the message', async () => {
    await status({
      id: 'wamid.OUT1',
      status: 'failed',
      errors: [
        {
          code: 131026,
          title: 'Undeliverable',
          error_data: { details: 'not on WhatsApp' },
        },
      ],
    });
    expect(table('messages')[0]).toMatchObject({
      status: 'failed',
      error_code: 131026,
      error_title: 'Undeliverable',
      error_details: 'not on WhatsApp',
    });
  });

  it('a later delivered keeps the recorded failure reason (columns are not cleared)', async () => {
    await status({
      id: 'wamid.OUT1',
      status: 'failed',
      errors: [{ code: 131026, title: 'Undeliverable' }],
    });
    await status({ id: 'wamid.OUT1', status: 'delivered' });
    expect(table('messages')[0]).toMatchObject({
      status: 'delivered',
      error_code: 131026,
    });
  });
});

describe('status webhooks: broadcast recipient ladder only moves forward', () => {
  const recipient = (st: string) =>
    table('broadcast_recipients').push({
      id: 'r-1',
      whatsapp_message_id: 'wamid.BC1',
      status: st,
    });
  const current = () => table('broadcast_recipients')[0];

  it('walks pending -> sent -> delivered -> read, stamping each timestamp', async () => {
    recipient('pending');
    const iso = new Date(1700000100 * 1000).toISOString();

    await status({ id: 'wamid.BC1', status: 'sent' });
    expect(current()).toMatchObject({ status: 'sent', sent_at: iso });
    await status({ id: 'wamid.BC1', status: 'delivered' });
    expect(current()).toMatchObject({ status: 'delivered', delivered_at: iso });
    await status({ id: 'wamid.BC1', status: 'read' });
    expect(current()).toMatchObject({ status: 'read', read_at: iso });
  });

  it.each([
    ['read', 'delivered'],
    ['read', 'sent'],
    ['delivered', 'sent'],
    ['delivered', 'delivered'],
    ['replied', 'read'],
  ])('%s never regresses to %s', async (from, to) => {
    recipient(from);
    await status({ id: 'wamid.BC1', status: to });
    expect(current().status).toBe(from);
  });

  it('can skip a step forward (sent -> read)', async () => {
    recipient('sent');
    await status({ id: 'wamid.BC1', status: 'read' });
    expect(current().status).toBe('read');
  });

  it.each(['pending', 'sent'])(
    'failed is accepted from %s and the reason is folded into error_message',
    async (from) => {
      recipient(from);
      await status({
        id: 'wamid.BC1',
        status: 'failed',
        errors: [
          {
            code: 131049,
            title: 'Ecosystem limit',
            error_data: { details: 'try later' },
          },
        ],
      });
      expect(current()).toMatchObject({
        status: 'failed',
        error_message: '[131049] Ecosystem limit: try later',
      });
    }
  );

  it.each(['delivered', 'read', 'replied'])(
    'failed is refused once the recipient is %s',
    async (from) => {
      recipient(from);
      await status({
        id: 'wamid.BC1',
        status: 'failed',
        errors: [{ code: 1, title: 'x' }],
      });
      expect(current().status).toBe(from);
      expect(current()).not.toHaveProperty('error_message');
    }
  );

  it('failed is terminal: nothing moves a failed recipient', async () => {
    recipient('failed');
    await status({ id: 'wamid.BC1', status: 'delivered' });
    expect(current().status).toBe('failed');
  });

  it('an unknown incoming status is ignored', async () => {
    recipient('sent');
    await status({ id: 'wamid.BC1', status: 'deleted' });
    expect(current().status).toBe('sent');
  });

  it('a status for a wamid with no message or recipient is a harmless no-op', async () => {
    await status({ id: 'wamid.GHOST', status: 'read' });
    expect(table('messages')).toHaveLength(0);
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled();
  });
});

describe('inbound: a reply flips the latest broadcast recipient to replied', () => {
  it('sent/delivered/read recipient of this contact becomes replied', async () => {
    table('contacts').push({
      id: 'c-1',
      account_id: ACCOUNT,
      phone: '15551230000',
      name: 'Ada',
    });
    table('broadcast_recipients').push({
      id: 'r-1',
      contact_id: 'c-1',
      status: 'delivered',
    });
    await inbound(TEXT, ADA);
    expect(table('broadcast_recipients')[0].status).toBe('replied');
    expect(table('broadcast_recipients')[0].replied_at).toBeTruthy();
  });

  it('does not touch a failed or pending recipient', async () => {
    table('contacts').push({
      id: 'c-1',
      account_id: ACCOUNT,
      phone: '15551230000',
      name: 'Ada',
    });
    table('broadcast_recipients').push(
      { id: 'r-1', contact_id: 'c-1', status: 'failed' },
      { id: 'r-2', contact_id: 'c-1', status: 'pending' }
    );
    await inbound(TEXT, ADA);
    expect(table('broadcast_recipients').map((r) => r.status)).toEqual([
      'failed',
      'pending',
    ]);
  });
});

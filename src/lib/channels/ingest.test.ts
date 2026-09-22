import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ingestInbound, type IngestHooks } from './ingest';
import type { Connection, InboundEvent } from './types';

type Row = Record<string, unknown>;

const state = {
  tables: {} as Record<string, Row[]>,
  seq: 0,
  rpcCalls: [] as { name: string; args: Row }[],
};

// Stateful fake of the supabase-js builder with the unique indexes that matter
// here: conversations (contact, connection) [migration 047], messages
// (conversation, message_id), contacts (account, phone) and
// contact_identities (account, kind, external_id).
class Query {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private payload: Row | Row[] = {};
  private filters: ((r: Row) => boolean)[] = [];
  private ignoreDup = false;
  private onConflict = '';
  private head = false;
  private mode: 'many' | 'maybe' | 'single' = 'many';
  constructor(private table: string) {}
  private rows() {
    return (state.tables[this.table] ??= []);
  }
  select(_c?: string, o?: { head?: boolean }) {
    if (o?.head) this.head = true;
    return this;
  }
  insert(p: Row) {
    this.op = 'insert';
    this.payload = p;
    return this;
  }
  update(p: Row) {
    this.op = 'update';
    this.payload = p;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  upsert(
    p: Row | Row[],
    o: { onConflict?: string; ignoreDuplicates?: boolean }
  ) {
    this.op = 'upsert';
    this.payload = p;
    this.ignoreDup = !!o.ignoreDuplicates;
    this.onConflict = o.onConflict ?? '';
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push((r) => r[c] === v);
    return this;
  }
  is(c: string, v: unknown) {
    this.filters.push((r) => (r[c] ?? null) === v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[c]));
    return this;
  }
  like(c: string, pattern: string) {
    const suffix = pattern.replace(/^%/, '');
    this.filters.push((r) => String(r[c] ?? '').endsWith(suffix));
    return this;
  }
  order() {
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
  private conflict(row: Row): boolean {
    const rows = this.rows();
    switch (this.table) {
      case 'contact_identities':
        return rows.some(
          (r) =>
            r.account_id === row.account_id &&
            r.kind === row.kind &&
            r.external_id === row.external_id
        );
      case 'conversations':
        return rows.some(
          (r) =>
            r.contact_id === row.contact_id &&
            r.connection_id === row.connection_id
        );
      case 'messages':
        return rows.some(
          (r) =>
            r.conversation_id === row.conversation_id &&
            r.message_id === row.message_id
        );
      default:
        return rows.some(
          (r) =>
            r.account_id === row.account_id &&
            row.phone &&
            r.phone === row.phone
        );
    }
  }
  private run(): { data: unknown; error: unknown; count?: number } {
    const rows = this.rows();
    let out: Row[] = [];
    const insertRow = (row: Row) => {
      const withId = {
        id: `${this.table}-${++state.seq}`,
        status: this.table === 'conversations' ? 'open' : undefined,
        unread_count: this.table === 'conversations' ? 0 : undefined,
        ...row,
      };
      rows.push(withId);
      return withId;
    };
    if (this.op === 'insert') {
      const row = this.payload as Row;
      if (this.conflict(row)) {
        return { data: null, error: { code: '23505', message: 'duplicate' } };
      }
      out = [insertRow(row)];
    } else if (this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const row of list) {
        if (this.conflict(row)) {
          if (!this.ignoreDup) throw new Error('fake: non-ignore upsert');
          continue;
        }
        out.push(insertRow(row));
      }
    } else if (this.op === 'update') {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of out) Object.assign(r, this.payload);
    } else if (this.op === 'delete') {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
      state.tables[this.table] = rows.filter(
        (r) => !this.filters.every((f) => f(r))
      );
    } else {
      out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.head) return { data: null, error: null, count: out.length };
    }
    if (this.mode === 'many') return { data: out, error: null };
    return { data: out[0] ?? null, error: null };
  }
  then<T>(res: (v: unknown) => T, rej?: (e: unknown) => T) {
    return Promise.resolve(this.run()).then(res, rej);
  }
}

const db = {
  from: (t: string) => new Query(t),
  // Mirrors bump_conversation_on_inbound (migration 037).
  rpc: (name: string, args: Row) => {
    state.rpcCalls.push({ name, args });
    const conv = (state.tables.conversations ?? []).find(
      (c) => c.id === args.p_conversation_id
    );
    if (conv) {
      conv.unread_count = ((conv.unread_count as number) ?? 0) + 1;
      conv.last_message_text = args.p_last_message_text;
      conv.last_message_at = 'now';
      conv.updated_at = 'now';
    }
    return Promise.resolve({ data: null, error: null });
  },
} as unknown as SupabaseClient;

const CONN = {
  id: 'conn-1',
  account_id: 'acct-1',
  channel_type: 'whatsapp_cloud',
} as Connection;
const OPTS = { auditUserId: 'owner-1' };

type MsgEvent = Extract<InboundEvent, { kind: 'message' }>;
const PHONE = { kind: 'whatsapp:phone', externalId: '15551230000' };
function msg(over: Partial<MsgEvent> = {}): MsgEvent {
  return {
    kind: 'message',
    externalId: 'wamid.1',
    sender: [PHONE],
    at: new Date(1700000000 * 1000),
    content: { type: 'text', text: 'hello' },
    senderName: 'Ada',
    ...over,
  };
}
const t = (name: string) => state.tables[name] ?? [];

beforeEach(() => {
  state.tables = {};
  state.seq = 0;
  state.rpcCalls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('ingestInbound: contact and conversation', () => {
  it('a new number creates contact + conversation on the connection and stores the message', async () => {
    const [r] = await ingestInbound(db, CONN, [msg()], OPTS);
    expect(r).toMatchObject({
      status: 'stored',
      contactCreated: true,
      conversationCreated: true,
      isFirstInbound: true,
    });
    expect(t('contacts')).toHaveLength(1);
    expect(t('conversations')).toHaveLength(1);
    expect(t('conversations')[0]).toMatchObject({
      account_id: 'acct-1',
      user_id: 'owner-1',
      connection_id: 'conn-1',
    });
    expect(t('messages')[0]).toMatchObject({
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'hello',
      message_id: 'wamid.1',
      status: 'delivered',
      created_at: '2023-11-14T22:13:20.000Z',
      media_url: null,
      reply_to_message_id: null,
      interactive_reply_id: null,
    });
    expect(t('conversations')[0]).toMatchObject({
      unread_count: 1,
      last_message_text: 'hello',
    });
  });

  it('a known number reuses contact and conversation and bumps unread', async () => {
    await ingestInbound(db, CONN, [msg()], OPTS);
    const [r] = await ingestInbound(
      db,
      CONN,
      [
        msg({
          externalId: 'wamid.2',
          content: { type: 'text', text: 'again' },
        }),
      ],
      OPTS
    );
    expect(r).toMatchObject({
      status: 'stored',
      contactCreated: false,
      conversationCreated: false,
      isFirstInbound: false,
    });
    expect(t('contacts')).toHaveLength(1);
    expect(t('conversations')).toHaveLength(1);
    expect(t('messages')).toHaveLength(2);
    expect(t('conversations')[0]).toMatchObject({
      unread_count: 2,
      last_message_text: 'again',
    });
  });

  it('reopens a closed conversation', async () => {
    await ingestInbound(db, CONN, [msg()], OPTS);
    t('conversations')[0].status = 'closed';
    await ingestInbound(db, CONN, [msg({ externalId: 'wamid.2' })], OPTS);
    expect(t('conversations')[0].status).toBe('open');
  });

  it('a replay is ignored: one row, no second bump, no hook fired', async () => {
    const onMessageStored = vi.fn();
    await ingestInbound(db, CONN, [msg()], {
      ...OPTS,
      hooks: { onMessageStored },
    });
    const [r] = await ingestInbound(db, CONN, [msg()], {
      ...OPTS,
      hooks: { onMessageStored },
    });
    expect(r.status).toBe('duplicate');
    expect(t('messages')).toHaveLength(1);
    expect(t('conversations')[0].unread_count).toBe(1);
    expect(state.rpcCalls).toHaveLength(1);
    expect(onMessageStored).toHaveBeenCalledTimes(1);
  });

  it('the same wamid in a different conversation is not a duplicate', async () => {
    await ingestInbound(db, CONN, [msg()], OPTS);
    const other = { kind: 'whatsapp:phone', externalId: '15559990000' };
    const [r] = await ingestInbound(db, CONN, [msg({ sender: [other] })], OPTS);
    expect(r.status).toBe('stored');
    expect(t('messages')).toHaveLength(2);
    expect(t('conversations')).toHaveLength(2);
  });

  it('a BSUID-only sender creates a phone-less contact and is found again', async () => {
    const sender = [
      { kind: 'whatsapp:bsuid', externalId: 'US.1111111' },
      {
        kind: 'whatsapp:username',
        externalId: 'sheena_n',
        handle: '@sheena_n',
      },
    ];
    await ingestInbound(
      db,
      CONN,
      [msg({ sender, senderName: 'Sheena' })],
      OPTS
    );
    expect(t('contacts')[0]).toMatchObject({
      phone: '',
      name: 'Sheena',
    });
    expect(
      (t('contact_identities') as Row[])
        .filter((i) => i.contact_id === t('contacts')[0].id)
        .map((i) => i.kind)
        .sort()
    ).toEqual(['whatsapp:bsuid', 'whatsapp:username']);
    await ingestInbound(
      db,
      CONN,
      [msg({ sender, externalId: 'wamid.2' })],
      OPTS
    );
    expect(t('contacts')).toHaveLength(1);
    expect(t('conversations')).toHaveLength(1);
    expect(t('messages')).toHaveLength(2);
  });

  it('another account never reuses the contact', async () => {
    await ingestInbound(db, CONN, [msg()], OPTS);
    const other = { ...CONN, id: 'conn-2', account_id: 'acct-2' } as Connection;
    await ingestInbound(db, other, [msg()], OPTS);
    expect(t('contacts')).toHaveLength(2);
    expect(t('conversations')).toHaveLength(2);
    expect(t('messages')).toHaveLength(2);
  });

  it('a contact on a second connection gets a second conversation (one per contact and connection)', async () => {
    await ingestInbound(db, CONN, [msg()], OPTS);
    const second = { ...CONN, id: 'conn-2' } as Connection;
    const [r] = await ingestInbound(
      db,
      second,
      [msg({ externalId: 'wamid.2' })],
      OPTS
    );
    expect(r).toMatchObject({ status: 'stored', conversationCreated: true });
    expect(t('conversations')).toHaveLength(2);
    expect(t('conversations').map((c) => c.connection_id)).toEqual([
      'conn-1',
      'conn-2',
    ]);
    expect(t('contacts')).toHaveLength(1);
  });

  it('a second message on the same connection reuses that connection conversation', async () => {
    await ingestInbound(db, CONN, [msg()], OPTS);
    const second = { ...CONN, id: 'conn-2' } as Connection;
    await ingestInbound(db, second, [msg({ externalId: 'wamid.2' })], OPTS);
    const [r] = await ingestInbound(
      db,
      CONN,
      [msg({ externalId: 'wamid.3' })],
      OPTS
    );
    expect(r).toMatchObject({ status: 'stored', conversationCreated: false });
    expect(t('conversations')).toHaveLength(2);
  });

  it('a reply resolves its parent by external id inside the conversation, NULL when unknown', async () => {
    await ingestInbound(db, CONN, [msg()], OPTS);
    const parentId = t('messages')[0].id;
    await ingestInbound(
      db,
      CONN,
      [msg({ externalId: 'wamid.2', replyToExternalId: 'wamid.1' })],
      OPTS
    );
    await ingestInbound(
      db,
      CONN,
      [msg({ externalId: 'wamid.3', replyToExternalId: 'wamid.gone' })],
      OPTS
    );
    expect(t('messages')[1].reply_to_message_id).toBe(parentId);
    expect(t('messages')[2].reply_to_message_id).toBeNull();
  });

  it('non-message events are skipped, the rest still run', async () => {
    const out = await ingestInbound(
      db,
      CONN,
      [{ kind: 'status', externalId: 'wamid.1', status: 'read' }, msg()],
      OPTS
    );
    expect(out.map((o) => o.status)).toEqual(['skipped', 'stored']);
  });
});

describe('ingestInbound: what is stored per content type', () => {
  async function store(over: Partial<MsgEvent>) {
    const [r] = await ingestInbound(db, CONN, [msg(over)], OPTS);
    return { r, row: t('messages')[0], conv: t('conversations')[0] };
  }

  it('image with caption keeps the MIME type; media_url comes from the hook', async () => {
    const resolveMedia: IngestHooks['resolveMedia'] = vi.fn(async () => ({
      url: 'https://cdn/x.jpg',
    }));
    const [r] = await ingestInbound(
      db,
      CONN,
      [
        msg({
          content: {
            type: 'media',
            kind: 'image',
            media: { kind: 'image', id: 'm1', mimeType: 'image/jpeg' },
            caption: 'look',
          },
        }),
      ],
      { ...OPTS, hooks: { resolveMedia } }
    );
    expect(r.status).toBe('stored');
    expect(resolveMedia).toHaveBeenCalledTimes(1);
    expect(t('messages')[0]).toMatchObject({
      content_type: 'image',
      content_text: 'look',
      media_type: 'image/jpeg',
      media_url: 'https://cdn/x.jpg',
    });
  });

  it('media without a hook stores no url; a failing hook is swallowed', async () => {
    const content = {
      type: 'media' as const,
      kind: 'audio' as const,
      media: { kind: 'audio' as const, id: 'a', mimeType: 'audio/ogg' },
    };
    const a = await store({ content });
    expect(a.row).toMatchObject({
      content_type: 'audio',
      content_text: null,
      media_url: null,
      media_type: 'audio/ogg',
    });
    expect(a.conv.last_message_text).toBe('[audio]');

    state.tables = {};
    await ingestInbound(db, CONN, [msg({ content })], {
      ...OPTS,
      hooks: {
        resolveMedia: async () => {
          throw new Error('boom');
        },
      },
    });
    expect(t('messages')[0].media_url).toBeNull();
  });

  it('sticker without a caption previews as [sticker] and is stored as image', async () => {
    const { row, conv } = await store({
      emptyPreview: '[sticker]',
      content: {
        type: 'media',
        kind: 'image',
        media: { kind: 'image', id: 's', mimeType: 'image/webp' },
      },
    });
    expect(row.content_type).toBe('image');
    expect(conv.last_message_text).toBe('[sticker]');
  });

  it('location stores its ready-made text', async () => {
    const { row, conv } = await store({
      content: {
        type: 'location',
        latitude: 1,
        longitude: 2,
        name: 'HQ',
        text: 'HQ - 1,2',
      },
    });
    expect(row).toMatchObject({
      content_type: 'location',
      content_text: 'HQ - 1,2',
    });
    expect(conv.last_message_text).toBe('HQ - 1,2');
  });

  it('interactive tap stores title as text and id as interactive_reply_id', async () => {
    const { row } = await store({
      content: { type: 'interactive_reply', id: 'opt_1', title: 'Yes' },
    });
    expect(row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes',
      interactive_reply_id: 'opt_1',
    });
  });

  it('unknown type is text with the placeholder', async () => {
    const { row, conv } = await store({
      content: {
        type: 'unsupported',
        description: '[Unsupported message type: order]',
      },
    });
    expect(row).toMatchObject({
      content_type: 'text',
      content_text: '[Unsupported message type: order]',
    });
    expect(conv.last_message_text).toBe('[Unsupported message type: order]');
  });

  // The three parse edge cases US-073 recorded (route behaviour to reproduce).
  it('edge 1: interactive without an option stays interactive with "[Interactive reply]"', async () => {
    const { row, conv } = await store({
      content: {
        type: 'unsupported',
        description: '[Interactive reply]',
        stored: { contentType: 'interactive', text: '[Interactive reply]' },
      },
    });
    expect(row).toMatchObject({
      content_type: 'interactive',
      content_text: '[Interactive reply]',
      interactive_reply_id: null,
    });
    expect(conv.last_message_text).toBe('[Interactive reply]');
  });

  it('edge 2: media without an id keeps the media type with no media and a null text', async () => {
    const { row, conv } = await store({
      content: {
        type: 'unsupported',
        description: '[image]',
        stored: { contentType: 'image', text: null },
      },
    });
    expect(row).toMatchObject({
      content_type: 'image',
      content_text: null,
      media_url: null,
      media_type: null,
    });
    expect(conv.last_message_text).toBe('[image]');
  });

  it('edge 3: a button with neither payload nor text stores nulls and previews [button]', async () => {
    const { row, conv } = await store({
      emptyPreview: '[button]',
      content: { type: 'interactive_reply', id: '', title: '' },
    });
    expect(row).toMatchObject({
      content_type: 'interactive',
      content_text: null,
      interactive_reply_id: null,
    });
    expect(conv.last_message_text).toBe('[button]');
  });
});

describe('ingestInbound: hooks', () => {
  it('onConversationCreated fires once, before the message exists; a throwing hook does not undo the message', async () => {
    let messagesAtCreate = -1;
    const onConversationCreated = vi.fn(() => {
      messagesAtCreate = t('messages').length;
      throw new Error('boom');
    });
    const hooks = { onConversationCreated };
    await ingestInbound(db, CONN, [msg()], { ...OPTS, hooks });
    await ingestInbound(db, CONN, [msg({ externalId: 'wamid.2' })], {
      ...OPTS,
      hooks,
    });
    expect(onConversationCreated).toHaveBeenCalledTimes(1);
    expect(messagesAtCreate).toBe(0);
    expect(t('messages')).toHaveLength(2);
  });

  it('a throwing onMessageStored is logged and the message stays stored', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await ingestInbound(db, CONN, [msg()], {
      ...OPTS,
      hooks: {
        onMessageStored: () => {
          throw new Error('fan-out exploded');
        },
      },
    });
    expect(out[0].status).toBe('stored');
    expect(t('messages')).toHaveLength(1);
  });

  it('onMessageStored gets what fan-out needs', async () => {
    const onMessageStored = vi.fn();
    await ingestInbound(
      db,
      CONN,
      [msg({ content: { type: 'interactive_reply', id: 'o', title: 'Yes' } })],
      { ...OPTS, hooks: { onMessageStored } }
    );
    expect(onMessageStored).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'interactive',
        contentText: 'Yes',
        interactiveReplyId: 'o',
        contactCreated: true,
        isFirstInbound: true,
      })
    );
  });
});

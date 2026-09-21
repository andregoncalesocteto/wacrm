/**
 * Characterization tests for what the Flows engine SENDS (US-004,
 * channel-abstraction). They pin the CURRENT behaviour of the real
 * engine driving the senders (text, media, buttons, list): each send
 * persists a `messages` row (sender_type 'bot', status 'sent', Meta wamid as
 * message_id) and updates the conversation preview. Only the Meta HTTP
 * senders are stubbed; the engine, the senders (`./send` over the channel
 * core), recipient resolution and phone variants are real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';
import { dispatchInboundToFlows } from './engine';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  rpcCalls: [] as { name: string; args: unknown }[],
  sendTextMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: h.sendTextMessage,
  sendMediaMessage: h.sendMediaMessage,
  sendInteractiveButtons: h.sendInteractiveButtons,
  sendInteractiveList: h.sendInteractiveList,
}));

vi.mock('@/lib/channels/admin-client', async () => {
  const { fakeCredentialsAdmin } = await import(
    '@/lib/channels/credentials-admin.fake'
  );
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

vi.mock('./admin-client', () => {
  class Query {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: Row = {};
    private filters: ((r: Row) => boolean)[] = [];
    private mode: 'many' | 'maybe' | 'single' = 'many';
    private head = false;
    private inserted: Row | null = null;
    private embedContact = false;
    constructor(private table: string) {}
    select(c?: string, opts?: { head?: boolean }) {
      if (typeof c === 'string' && c.includes('contact:contacts')) {
        this.embedContact = true;
      }
      if (opts?.head) this.head = true;
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
    is(col: string, v: unknown) {
      this.filters.push((r) => (r[col] ?? null) === v);
      return this;
    }
    in(col: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[col]));
      return this;
    }
    filter() {
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
        this.inserted = row;
        out = [row];
      } else if (this.op === 'update') {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
        for (const r of out) Object.assign(r, this.payload);
      } else {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
        if (this.embedContact) {
          // `contact:contacts(*)` embed used by sendOutbound (US-027).
          out = out.map((r) => ({
            ...r,
            contact:
              (h.db.contacts ?? []).find((c) => c.id === r.contact_id) ?? null,
          }));
        }
      }
      if (this.head) return { data: null, count: out.length, error: null };
      if (this.mode === 'many')
        return { data: out, count: out.length, error: null };
      if (this.mode === 'single' && !out[0]) {
        return { data: null, error: { message: 'no rows' } };
      }
      return { data: out[0] ?? null, error: null };
    }
    then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }
  return {
    supabaseAdmin: () => ({
      from: (t: string) => new Query(t),
      rpc: (name: string, args: unknown) => {
        h.rpcCalls.push({ name, args });
        return Promise.resolve({ error: null });
      },
    }),
  };
});

const PHONE = '+15551234567';

function seed(contact: Row = { phone: PHONE }) {
  h.db = {
    contacts: [{ id: 'ct-1', account_id: 'acct-1', ...contact }],
    conversations: [
      {
        id: 'cv-1',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        last_message_text: 'old',
        last_message_at: '2020-01-01T00:00:00Z',
      },
    ],
    channel_connections: [whatsappConnectionRow('acct-1', 'pn-1')],
    channel_connection_credentials: [
      { secrets_encrypted: 'cipher', secrets_format: 'wa_token_v0' },
    ],
    messages: [],
    flows: [],
    flow_nodes: [],
    flow_runs: [],
    flow_run_events: [],
  };
}

const messages = () => h.db.messages;
const conv = () => h.db.conversations[0];

beforeEach(() => {
  h.seq = 0;
  h.rpcCalls = [];
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' });
  h.sendMediaMessage.mockResolvedValue({ messageId: 'wamid.media' });
  h.sendInteractiveButtons.mockResolvedValue({ messageId: 'wamid.btn' });
  h.sendInteractiveList.mockResolvedValue({ messageId: 'wamid.list' });
  seed();
});

describe('engine run driving the real senders', () => {
  function seedFlow(nodes: Row[]) {
    h.db.flows = [
      {
        id: 'fl-1',
        account_id: 'acct-1',
        user_id: 'user-1',
        status: 'active',
        trigger_type: 'keyword',
        trigger_config: { keywords: ['start'], match_type: 'exact' },
        entry_node_id: 'n1',
        created_at: '2020-01-01',
      },
    ];
    h.db.flow_nodes = nodes.map((n) => ({ flow_id: 'fl-1', ...n }));
  }

  const dispatch = () =>
    dispatchInboundToFlows({
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'ct-1',
      conversationId: 'cv-1',
      isFirstInboundMessage: false,
      message: { kind: 'text', text: 'start', meta_message_id: 'wamid.in' },
    });

  it('a text -> media -> buttons flow persists all three messages and suspends on the prompt', async () => {
    seedFlow([
      {
        node_key: 'n1',
        node_type: 'send_message',
        config: { text: 'Hi', next_node_key: 'n2' },
      },
      {
        node_key: 'n2',
        node_type: 'send_media',
        config: {
          media_type: 'image',
          media_url: 'https://x.test/a.png',
          caption: 'Pic',
          next_node_key: 'n3',
        },
      },
      {
        node_key: 'n3',
        node_type: 'send_buttons',
        config: {
          text: 'Pick',
          buttons: [
            { reply_id: 'a', title: 'A', next_node_key: 'n4' },
            { reply_id: 'b', title: 'B', next_node_key: 'n4' },
          ],
        },
      },
    ]);

    const res = await dispatch();

    expect(res).toMatchObject({ consumed: true, outcome: 'started' });
    expect(
      messages().map((m) => [m.content_type, m.message_id, m.sender_type])
    ).toEqual([
      ['text', 'wamid.text', 'bot'],
      ['image', 'wamid.media', 'bot'],
      ['interactive', 'wamid.btn', 'bot'],
    ]);
    // The conversation preview follows the LAST send.
    expect(conv().last_message_text).toBe('Pick');
    // The run stays active and remembers our internal id of the prompt.
    expect(h.db.flow_runs[0]).toMatchObject({
      status: 'active',
      last_prompt_message_id: messages()[2].id,
    });
    expect(h.rpcCalls.map((c) => c.name)).toContain(
      'increment_flow_execution_count'
    );
  });

  it('a list prompt persists the list and stores its message id on the run', async () => {
    seedFlow([
      {
        node_key: 'n1',
        node_type: 'send_list',
        config: {
          text: 'Menu',
          button_label: 'Open',
          sections: [
            { rows: [{ reply_id: 'r1', title: 'One', next_node_key: 'n2' }] },
          ],
        },
      },
    ]);

    await dispatch();

    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({
      content_type: 'interactive',
      message_id: 'wamid.list',
    });
    expect(h.db.flow_runs[0].last_prompt_message_id).toBe(messages()[0].id);
    expect(conv().last_message_text).toBe('Menu');
  });

  it('a failed Meta send fails the run (send_text_failed) and persists no message', async () => {
    seedFlow([
      {
        node_key: 'n1',
        node_type: 'send_message',
        config: { text: 'Hi', next_node_key: 'n2' },
      },
      { node_key: 'n2', node_type: 'end', config: {} },
    ]);
    h.sendTextMessage.mockRejectedValue(new Error('(#100) boom'));

    const res = await dispatch();

    expect(res.consumed).toBe(true);
    expect(messages()).toHaveLength(0);
    expect(h.db.flow_runs[0]).toMatchObject({
      status: 'failed',
      end_reason: 'send_text_failed',
    });
    expect(conv().last_message_text).toBe('old');
  });

  it('a disabled connection fails the run visibly (US-078): no Meta call, no message', async () => {
    seedFlow([
      {
        node_key: 'n1',
        node_type: 'send_message',
        config: { text: 'Hi', next_node_key: 'n2' },
      },
      { node_key: 'n2', node_type: 'end', config: {} },
    ]);
    h.db.channel_connections[0].disabled_at = '2026-09-01T00:00:00Z';
    h.db.conversations[0].connection_id = h.db.channel_connections[0].id;

    const res = await dispatch();

    expect(res.consumed).toBe(true);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
    expect(h.db.flow_runs[0]).toMatchObject({
      status: 'failed',
      end_reason: 'send_text_failed',
    });
    expect(JSON.stringify(h.db.flow_run_events)).toMatch(/disabled/i);
    expect(conv().last_message_text).toBe('old');
  });
});

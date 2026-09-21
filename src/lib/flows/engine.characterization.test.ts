/**
 * Characterization tests for what the Flows engine SENDS (US-004,
 * channel-abstraction). They pin the CURRENT behaviour of the four sender
 * functions in `meta-send.ts` (text, media, buttons, list) and of the real
 * engine driving them: each send persists a `messages` row
 * (sender_type 'bot', status 'sent', Meta wamid as message_id) and updates
 * the conversation preview. Only the Meta HTTP senders are stubbed; the
 * engine, the senders, recipient resolution and phone variants are real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { phoneVariants } from '@/lib/whatsapp/phone-utils';
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from './meta-send';
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
    constructor(private table: string) {}
    select(_c?: string, opts?: { head?: boolean }) {
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
const NOT_ALLOWED = '(#131030) Recipient phone number not in allowed list';

const base = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
};

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
    whatsapp_config: [
      {
        account_id: 'acct-1',
        phone_number_id: 'pn-1',
        access_token: 'cipher',
      },
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

describe('flows engineSendText', () => {
  it('sends with the account credentials, persists a bot message and updates the conversation', async () => {
    const r = await engineSendText({ ...base, text: 'Hello' });

    expect(r).toEqual({ whatsapp_message_id: 'wamid.text' });
    expect(h.sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'dec:cipher',
      to: '15551234567',
      text: 'Hello',
    });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      content_type: 'text',
      content_text: 'Hello',
      message_id: 'wamid.text',
      status: 'sent',
      ai_generated: false,
    });
    expect(conv().last_message_text).toBe('Hello');
    expect(conv().last_message_at).not.toBe('2020-01-01T00:00:00Z');
    expect(typeof conv().updated_at).toBe('string');
  });

  it('flags the row ai_generated when asked (AI auto-reply path)', async () => {
    await engineSendText({ ...base, text: 'Hi', aiGenerated: true });
    expect(messages()[0].ai_generated).toBe(true);
  });

  it('retries the next phone variant on "recipient not allowed" and corrects the contact phone', async () => {
    const variants = phoneVariants('15551234567');
    h.sendTextMessage
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockResolvedValueOnce({ messageId: 'wamid.v2' });

    await engineSendText({ ...base, text: 'Hi' });

    expect(h.sendTextMessage.mock.calls.map((c) => c[0].to)).toEqual(
      variants.slice(0, 2)
    );
    expect(h.db.contacts[0].phone).toBe(variants[1]);
    expect(messages()[0].message_id).toBe('wamid.v2');
  });

  it('throws any other Meta error without persisting anything', async () => {
    h.sendTextMessage.mockRejectedValue(new Error('(#100) boom'));

    await expect(engineSendText({ ...base, text: 'Hi' })).rejects.toThrow(
      '(#100) boom'
    );
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(messages()).toHaveLength(0);
    expect(conv().last_message_text).toBe('old');
  });

  it('refuses a contact of another account without calling Meta', async () => {
    h.db.contacts[0].account_id = 'acct-2';
    await expect(engineSendText({ ...base, text: 'Hi' })).rejects.toThrow(
      'contact not found for this account'
    );
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('throws when the account has no WhatsApp config', async () => {
    h.db.whatsapp_config = [];
    await expect(engineSendText({ ...base, text: 'Hi' })).rejects.toThrow(
      'WhatsApp not configured for this account'
    );
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('sends once to a BSUID-only contact (no phone variants)', async () => {
    seed({ phone: '', wa_user_id: 'US.13491208655302741918' });
    await engineSendText({ ...base, text: 'Hi' });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage.mock.calls[0][0].to).toBe(
      'US.13491208655302741918'
    );
  });

  it('throws a clear error when the contact has no WhatsApp address', async () => {
    seed({ phone: '' });
    await expect(engineSendText({ ...base, text: 'Hi' })).rejects.toThrow(
      /contact has no usable WhatsApp address/
    );
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });
});

describe('flows engineSendMedia', () => {
  it('sends the media and persists content_type = kind with the caption', async () => {
    const r = await engineSendMedia({
      ...base,
      kind: 'image',
      link: 'https://x.test/a.png',
      caption: 'Look',
    });

    expect(r).toEqual({ whatsapp_message_id: 'wamid.media' });
    expect(h.sendMediaMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'dec:cipher',
      to: '15551234567',
      kind: 'image',
      link: 'https://x.test/a.png',
      caption: 'Look',
      filename: undefined,
    });
    expect(messages()[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      content_type: 'image',
      content_text: 'Look',
      message_id: 'wamid.media',
      status: 'sent',
    });
    expect(conv().last_message_text).toBe('Look');
  });

  it('uses "[kind]" as the preview and a null body when there is no caption', async () => {
    await engineSendMedia({
      ...base,
      kind: 'document',
      link: 'https://x.test/a.pdf',
      filename: 'a.pdf',
    });

    expect(h.sendMediaMessage.mock.calls[0][0].filename).toBe('a.pdf');
    expect(messages()[0]).toMatchObject({
      content_type: 'document',
      content_text: null,
    });
    expect(conv().last_message_text).toBe('[document]');
  });

  it('persists nothing when Meta rejects the media', async () => {
    h.sendMediaMessage.mockRejectedValue(new Error('(#131053) bad media'));
    await expect(
      engineSendMedia({ ...base, kind: 'video', link: 'https://x.test/v.mp4' })
    ).rejects.toThrow('(#131053) bad media');
    expect(messages()).toHaveLength(0);
    expect(conv().last_message_text).toBe('old');
  });
});

describe('flows engineSendInteractiveButtons / List', () => {
  const buttons = [
    { id: 'yes', title: 'Yes' },
    { id: 'no', title: 'No' },
  ];

  it('sends buttons, stores the structured payload and the body as preview', async () => {
    const r = await engineSendInteractiveButtons({
      ...base,
      bodyText: 'Confirm?',
      headerText: 'Head',
      footerText: 'Foot',
      buttons,
    });

    expect(r).toEqual({ whatsapp_message_id: 'wamid.btn' });
    expect(h.sendInteractiveButtons).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'dec:cipher',
      to: '15551234567',
      bodyText: 'Confirm?',
      buttons,
      headerText: 'Head',
      footerText: 'Foot',
    });
    expect(messages()[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      content_type: 'interactive',
      content_text: 'Confirm?',
      message_id: 'wamid.btn',
      status: 'sent',
      interactive_payload: {
        kind: 'buttons',
        body: 'Confirm?',
        header: 'Head',
        footer: 'Foot',
        buttons,
      },
    });
    // The customer's tap is stored later by the webhook, never here.
    expect(messages()[0].interactive_reply_id).toBeUndefined();
    expect(conv().last_message_text).toBe('Confirm?');
  });

  it('sends a list and stores kind=list with button_label and sections', async () => {
    const sections = [
      { title: 'S', rows: [{ id: 'r1', title: 'One', description: 'd' }] },
    ];
    const r = await engineSendInteractiveList({
      ...base,
      bodyText: 'Pick',
      buttonLabel: 'Open',
      sections,
    });

    expect(r).toEqual({ whatsapp_message_id: 'wamid.list' });
    expect(h.sendInteractiveList.mock.calls[0][0]).toMatchObject({
      bodyText: 'Pick',
      buttonLabel: 'Open',
      sections,
    });
    expect(messages()[0]).toMatchObject({
      content_type: 'interactive',
      content_text: 'Pick',
      message_id: 'wamid.list',
      interactive_payload: {
        kind: 'list',
        body: 'Pick',
        button_label: 'Open',
        sections,
      },
    });
    expect(conv().last_message_text).toBe('Pick');
  });

  it('retries phone variants for interactive sends too', async () => {
    h.sendInteractiveButtons
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockResolvedValueOnce({ messageId: 'wamid.btn2' });
    await engineSendInteractiveButtons({ ...base, bodyText: 'B', buttons });
    expect(h.sendInteractiveButtons).toHaveBeenCalledTimes(2);
    expect(messages()[0].message_id).toBe('wamid.btn2');
  });

  it('persists nothing when Meta rejects the interactive message', async () => {
    h.sendInteractiveList.mockRejectedValue(new Error('(#100) nope'));
    await expect(
      engineSendInteractiveList({
        ...base,
        bodyText: 'P',
        buttonLabel: 'O',
        sections: [{ rows: [{ id: 'a', title: 'A' }] }],
      })
    ).rejects.toThrow('(#100) nope');
    expect(messages()).toHaveLength(0);
  });
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
});

/**
 * sendOutbound (US-023) with a mocked provider. Ports the relevant cases of
 * whatsapp/send-message.characterization.test.ts to the provider contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { whatsappConnectionRow } from './credentials-admin.fake';
import { registerProvider, resetRegistryForTests } from './registry';
import {
  ChannelError,
  ConnectionDisabledError,
  type Capabilities,
  type ChannelProvider,
  type ContactIdentity,
} from './types';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import {
  sendOutbound,
  showTyping,
  toSendMessageError,
  ConversationNotFoundError,
} from './send';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  flowPauses: [] as { patch: Row; filters: [string, unknown][] }[],
  flowPauseThrows: false,
  insertError: null as { message: string } | null,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      if (h.flowPauseThrows) throw new Error('boom');
      const call = { patch: {} as Row, filters: [] as [string, unknown][] };
      const b: Record<string, unknown> = {
        update: (patch: Row) => {
          call.patch = patch;
          return b;
        },
        eq: (col: string, v: unknown) => {
          call.filters.push([col, v]);
          if (call.filters.length === 3) {
            h.flowPauses.push({ patch: call.patch, filters: call.filters });
            return Promise.resolve({ error: null });
          }
          return b;
        },
      };
      return b;
    },
  }),
}));

function fakeDb(): SupabaseClient {
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
    private run() {
      const rows = (h.db[this.table] ??= []);
      let out: Row[];
      if (this.op === 'insert') {
        if (h.insertError && this.table === 'messages') {
          return { data: null, error: h.insertError };
        }
        const row = { id: `${this.table}-${++h.seq}`, ...this.payload };
        rows.push(row);
        out = [row];
      } else {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
        if (this.op === 'update') {
          for (const r of out) Object.assign(r, this.payload);
        } else if (this.table === 'conversations') {
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
  return { from: (t: string) => new Query(t) } as unknown as SupabaseClient;
}

const caps: Capabilities = {
  templates: true,
  interactiveButtons: true,
  interactiveList: true,
  reactions: true,
  typingIndicator: true,
  deliveryStatus: true,
  readStatus: true,
  initiate: 'template',
  replyWindowHours: 24,
  mediaKinds: ['image', 'document'],
  maxMediaBytes: 1000,
  captionMaxLength: 10,
};

const sendMock = vi.fn();
const resolveTargetMock = vi.fn((ids: ContactIdentity[]) => {
  const p = ids.find((i) => i.kind === 'whatsapp:phone');
  return p ? { kind: p.kind, address: p.externalId } : null;
});

const typingMock = vi.fn();

function provider(over: Partial<ChannelProvider> = {}): ChannelProvider {
  return {
    typing: typingMock,
    type: 'whatsapp_cloud',
    identityKinds: ['whatsapp:phone'],
    capabilities: caps,
    resolveTarget: resolveTargetMock,
    send: sendMock,
    ...over,
  } as unknown as ChannelProvider;
}

function seed(contact: Row = { phone: '15551234567' }, extra: Row = {}) {
  h.db = {
    contacts: [{ id: 'ct-1', account_id: 'acct-1', ...contact }],
    conversations: [
      {
        id: 'cv-1',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        last_message_text: 'old',
        ...extra,
      },
    ],
    channel_connections: [whatsappConnectionRow('acct-1', 'pn-1')],
    contact_identities: [],
    messages: [],
  };
}

const text = (t = 'hi') => ({ type: 'text' as const, text: t });
const send = (over: Partial<Parameters<typeof sendOutbound>[0]> = {}) =>
  sendOutbound({
    conversationId: 'cv-1',
    accountId: 'acct-1',
    message: text(),
    actor: { type: 'agent', userId: 'user-1' },
    db: fakeDb(),
    ...over,
  });

beforeEach(() => {
  resetRegistryForTests();
  registerProvider(provider());
  h.seq = 0;
  h.flowPauses = [];
  h.flowPauseThrows = false;
  h.insertError = null;
  sendMock.mockReset();
  sendMock.mockResolvedValue({ externalId: 'wamid.1' });
  seed();
});

describe('sendOutbound text', () => {
  it('sends, persists the message and updates the conversation', async () => {
    const res = await send();
    expect(res).toMatchObject({
      messageId: 'messages-1',
      externalMessageId: 'wamid.1',
    });
    expect(sendMock.mock.calls[0][1]).toEqual({
      kind: 'whatsapp:phone',
      address: '15551234567',
    });
    expect(h.db.messages[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'agent',
      sender_id: 'user-1',
      content_type: 'text',
      content_text: 'hi',
      media_url: null,
      message_id: 'wamid.1',
      status: 'sent',
      reply_to_message_id: null,
    });
    expect(h.db.conversations[0].last_message_text).toBe('hi');
    expect(h.db.conversations[0].last_message_at).toBeTruthy();
  });

  it('uses contact_identities when present', async () => {
    seed({ phone: '' });
    h.db.contact_identities = [
      {
        account_id: 'acct-1',
        contact_id: 'ct-1',
        kind: 'whatsapp:phone',
        external_id: '15550000000',
      },
    ];
    await send();
    expect(sendMock.mock.calls[0][1].address).toBe('15550000000');
  });

  it('maps bot/flow/automation/ai actors to sender_type bot (ai_generated only for ai)', async () => {
    await send({ actor: { type: 'flow' } });
    await send({ actor: { type: 'ai' } });
    expect(h.db.messages[0]).toMatchObject({ sender_type: 'bot' });
    expect(h.db.messages[0].ai_generated).toBeUndefined();
    expect(h.db.messages[1]).toMatchObject({
      sender_type: 'bot',
      ai_generated: true,
    });
    expect(h.flowPauses).toHaveLength(0);
  });

  it('quotes the parent message by its provider id and stores our id', async () => {
    h.db.messages.push({
      id: 'm-parent',
      conversation_id: 'cv-1',
      message_id: 'wamid.parent',
    });
    await send({ replyToMessageId: 'm-parent' });
    expect(sendMock.mock.calls[0][2].replyTo).toEqual({
      externalId: 'wamid.parent',
    });
    expect(h.db.messages[1].reply_to_message_id).toBe('m-parent');
  });

  it('rejects a reply target from another conversation without sending', async () => {
    await expect(send({ replyToMessageId: 'nope' })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('sendOutbound media', () => {
  it('persists media type, url and caption; preview falls back to [kind]', async () => {
    await send({
      message: {
        type: 'media',
        kind: 'image',
        url: 'https://x/i.png',
        caption: 'cap',
      },
    });
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'image',
      content_text: 'cap',
      media_url: 'https://x/i.png',
    });
    expect(h.db.conversations[0].last_message_text).toBe('cap');

    await send({
      message: { type: 'media', kind: 'document', url: 'https://x/d.pdf' },
    });
    expect(h.db.messages[1].content_text).toBeNull();
    expect(h.db.conversations[0].last_message_text).toBe('[document]');
  });
});

const TPL_ROW = {
  id: 'tpl-1',
  account_id: 'acct-1',
  user_id: 'u-1',
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Order {{1}} ships {{2}}',
  created_at: '2026-01-01T00:00:00Z',
};
const buttons = {
  kind: 'buttons' as const,
  body: 'Pick one',
  header: 'Header',
  footer: 'Footer',
  buttons: [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ],
};
const list = {
  kind: 'list' as const,
  body: 'Choose',
  buttonLabel: 'Open',
  sections: [{ title: 'S', rows: [{ id: 'r1', title: 'Row 1' }] }],
};

describe('sendOutbound template', () => {
  it('resolves the row in the core, passes it to the provider, stores the rendered body', async () => {
    h.db.message_templates = [TPL_ROW];
    await send({
      message: {
        type: 'template',
        template: {
          name: 'order_update',
          language: '',
          provider: { params: ['A1', 'today'] },
        },
      },
    });
    const sent = sendMock.mock.calls[0][2];
    expect(sent.template).toMatchObject({
      name: 'order_update',
      language: 'en',
      provider: { row: TPL_ROW, params: ['A1', 'today'] },
    });
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'template',
      template_name: 'order_update',
      content_text: 'Order A1 ships today',
      message_id: 'wamid.1',
      status: 'sent',
    });
    expect(h.db.conversations[0].last_message_text).toBe(
      'Order A1 ships today'
    );
  });

  it('structured params win, and a caller-rendered body wins over the row', async () => {
    h.db.message_templates = [TPL_ROW];
    await send({
      message: {
        type: 'template',
        template: {
          name: 'order_update',
          language: 'en',
          provider: { params: ['x'], messageParams: { body: ['B1', 'B2'] } },
        },
      },
    });
    expect(h.db.messages[0].content_text).toBe('Order B1 ships B2');
    await send({
      message: {
        type: 'template',
        template: { name: 'order_update', language: 'en' },
      },
      contentText: 'pre-rendered',
    });
    expect(h.db.messages[1].content_text).toBe('pre-rendered');
  });

  it('no local row: language defaults to en_US and content_text is null', async () => {
    await send({
      message: {
        type: 'template',
        template: { name: 'unknown_tpl', language: '' },
      },
    });
    expect(sendMock.mock.calls[0][2].template).toMatchObject({
      language: 'en_US',
      provider: { params: [] },
    });
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'template',
      template_name: 'unknown_tpl',
      content_text: null,
    });
    expect(h.db.conversations[0].last_message_text).toBe('[template]');
  });

  it('malformed local row maps to the legacy template_malformed 500', async () => {
    h.db.message_templates = [
      { account_id: 'acct-1', name: 't', language: 'en' },
    ];
    const err = await send({
      message: { type: 'template', template: { name: 't', language: 'en' } },
    }).catch((e) => e);
    expect(sendMock).not.toHaveBeenCalled();
    expect(toSendMessageError(err)).toMatchObject({
      code: 'template_malformed',
      status: 500,
    });
  });
});

describe('sendOutbound interactive', () => {
  it('buttons: persists the payload and the body as content_text', async () => {
    await send({ message: { type: 'interactive', interactive: buttons } });
    expect(sendMock.mock.calls[0][2].interactive).toEqual(buttons);
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'interactive',
      content_text: 'Pick one',
      interactive_payload: buttons,
      template_name: null,
      message_id: 'wamid.1',
    });
    expect(h.db.conversations[0].last_message_text).toBe('Pick one');
  });

  it('list: persists the legacy button_label shape, sends the neutral one', async () => {
    await send({ message: { type: 'interactive', interactive: list } });
    expect(sendMock.mock.calls[0][2].interactive).toEqual(list);
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'interactive',
      content_text: 'Choose',
      interactive_payload: {
        kind: 'list',
        body: 'Choose',
        button_label: 'Open',
        sections: list.sections,
      },
    });
    expect(
      (h.db.messages[0].interactive_payload as Row).buttonLabel
    ).toBeUndefined();
  });

  it('an invalid payload is rejected before the provider', async () => {
    await expect(
      send({
        message: {
          type: 'interactive',
          interactive: { ...buttons, buttons: [] },
        },
      })
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('template/interactive capability and failure', () => {
  const noCaps = (over: Partial<Capabilities>) => {
    resetRegistryForTests();
    registerProvider({ ...provider(), capabilities: { ...caps, ...over } });
  };
  const tpl = {
    type: 'template' as const,
    template: { name: 'order_update', language: 'en' },
  };

  it.each([
    ['templates', { templates: false }, tpl],
    [
      'buttons',
      { interactiveButtons: false },
      { type: 'interactive' as const, interactive: buttons },
    ],
    [
      'list',
      { interactiveList: false },
      { type: 'interactive' as const, interactive: list },
    ],
  ])(
    'unsupported without %s (provider not called, nothing persisted)',
    async (_n, over, message) => {
      noCaps(over);
      await expect(send({ message })).rejects.toMatchObject({
        code: 'unsupported',
      });
      expect(sendMock).not.toHaveBeenCalled();
      expect(h.db.messages).toHaveLength(0);
      expect(h.db.conversations[0].last_message_text).toBe('old');
    }
  );

  it('buttons still work when only the list capability is missing', async () => {
    noCaps({ interactiveList: false });
    await send({ message: { type: 'interactive', interactive: buttons } });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('a failed provider send persists nothing (template and interactive)', async () => {
    h.db.message_templates = [TPL_ROW];
    sendMock.mockRejectedValue(new ChannelError('unknown', 'nope'));
    await expect(send({ message: tpl })).rejects.toBeInstanceOf(ChannelError);
    await expect(
      send({ message: { type: 'interactive', interactive: list } })
    ).rejects.toBeInstanceOf(ChannelError);
    expect(h.db.messages).toHaveLength(0);
    expect(h.db.conversations[0].last_message_text).toBe('old');
  });
});

describe('capability and target validation (provider never called)', () => {
  it('unsupported media kind', async () => {
    await expect(
      send({ message: { type: 'media', kind: 'video', url: 'u' } })
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(sendMock).not.toHaveBeenCalled();
    expect(h.db.messages).toHaveLength(0);
  });

  it('caption over captionMaxLength (audio-exempt kinds aside)', async () => {
    await expect(
      send({
        message: {
          type: 'media',
          kind: 'image',
          url: 'u',
          caption: 'x'.repeat(11),
        },
      })
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('no destination -> recipient_unreachable before the provider', async () => {
    seed({ phone: '' });
    await expect(send()).rejects.toMatchObject({
      code: 'recipient_unreachable',
    });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('other account -> not found, nothing sent', async () => {
    await expect(send({ accountId: 'acct-2' })).rejects.toBeInstanceOf(
      ConversationNotFoundError
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('no connection -> not configured', async () => {
    h.db.channel_connections = [];
    await expect(send()).rejects.toThrow(/not configured/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('provider outcomes', () => {
  it('a failed send persists nothing and leaves the conversation untouched', async () => {
    sendMock.mockRejectedValue(new ChannelError('unknown', 'Meta blew up'));
    await expect(send()).rejects.toMatchObject({ code: 'unknown' });
    expect(h.db.messages).toHaveLength(0);
    expect(h.db.conversations[0].last_message_text).toBe('old');
    expect(h.flowPauses).toHaveLength(0);
  });

  it('corrects the contact phone to the variant that worked', async () => {
    sendMock.mockResolvedValue({
      externalId: 'wamid.v',
      resolvedAddress: '5551234567',
    });
    const res = await send();
    expect(res.resolvedAddress).toBe('5551234567');
    expect(h.db.contacts[0].phone).toBe('5551234567');
  });

  it('does not touch the contact when no resolvedAddress', async () => {
    await send();
    expect(h.db.contacts[0].phone).toBe('15551234567');
  });

  it('db failure after send -> persist error mapped to db_error/500', async () => {
    h.insertError = { message: 'disk' };
    const err = toSendMessageError(await send().catch((e) => e));
    expect(err).toBeInstanceOf(SendMessageError);
    expect(err).toMatchObject({ code: 'db_error', status: 500 });
  });
});

describe('flow pause', () => {
  it('pauses the active run scoped by account+conversation+active for an agent', async () => {
    await send();
    expect(h.flowPauses).toHaveLength(1);
    expect(h.flowPauses[0].patch).toMatchObject({
      status: 'paused_by_agent',
      end_reason: 'agent_replied',
    });
    expect(h.flowPauses[0].filters).toEqual([
      ['account_id', 'acct-1'],
      ['conversation_id', 'cv-1'],
      ['status', 'active'],
    ]);
  });

  it('pauses only the run of the conversation the agent replied in', async () => {
    h.db.conversations.push({
      id: 'cv-2',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      last_message_text: 'old',
    });
    await send({ conversationId: 'cv-2' });
    expect(h.flowPauses).toHaveLength(1);
    expect(h.flowPauses[0].filters).toEqual([
      ['account_id', 'acct-1'],
      ['conversation_id', 'cv-2'],
      ['status', 'active'],
    ]);
  });

  it('is best-effort', async () => {
    h.flowPauseThrows = true;
    await expect(send()).resolves.toMatchObject({
      externalMessageId: 'wamid.1',
    });
  });
});

describe('toSendMessageError', () => {
  it('reproduces the old wrapping', () => {
    expect(
      toSendMessageError(new ChannelError('unknown', 'nope'))
    ).toMatchObject({
      code: 'meta_error',
      status: 502,
      message: 'Meta API error: nope',
    });
    expect(
      toSendMessageError(new ChannelError('recipient_unreachable', 'x'))
    ).toMatchObject({ code: 'bad_request', status: 400 });
    expect(toSendMessageError(new ConversationNotFoundError())).toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});

describe('showTyping', () => {
  const typing = () =>
    showTyping({
      conversationId: 'cv-1',
      accountId: 'acct-1',
      inboundExternalId: 'wamid.in',
      db: fakeDb(),
    });

  it('calls provider.typing with the resolved target and the inbound id', async () => {
    typingMock.mockReset();
    await typing();
    expect(typingMock).toHaveBeenCalledWith(
      expect.objectContaining({ external_id: 'pn-1' }),
      { kind: 'whatsapp:phone', address: '15551234567' },
      { inboundExternalId: 'wamid.in' }
    );
  });

  it('is a no-op when the provider does not declare typingIndicator', async () => {
    typingMock.mockReset();
    resetRegistryForTests();
    registerProvider(
      provider({ capabilities: { ...caps, typingIndicator: false } })
    );
    await typing();
    expect(typingMock).not.toHaveBeenCalled();
  });

  it('propagates provider errors', async () => {
    typingMock.mockReset();
    typingMock.mockRejectedValue(new ChannelError('unknown', 'x'));
    await expect(typing()).rejects.toBeInstanceOf(ChannelError);
  });
});

describe('sendOutbound disabled connection (US-078)', () => {
  const disabledAt = '2026-09-01T00:00:00Z';

  it('refuses before the provider and persists nothing', async () => {
    seed({ phone: '15551234567' }, { connection_id: 'conn-acct-1' });
    h.db.channel_connections = [
      whatsappConnectionRow('acct-1', 'pn-1', { disabled_at: disabledAt }),
    ];
    const err = await send().catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionDisabledError);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err).toMatchObject({
      code: 'unsupported',
      reason: 'connection_disabled',
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(h.db.messages).toHaveLength(0);
    expect(h.db.conversations[0].last_message_text).toBe('old');
  });

  it('does not fall back to another enabled connection of the account', async () => {
    seed({ phone: '15551234567' }, { connection_id: 'conn-own' });
    h.db.channel_connections = [
      whatsappConnectionRow('acct-1', 'pn-1', {
        id: 'conn-own',
        disabled_at: disabledAt,
      }),
      whatsappConnectionRow('acct-1', 'pn-2', { id: 'conn-other' }),
    ];
    await expect(send()).rejects.toBeInstanceOf(ConnectionDisabledError);
    expect(sendMock).not.toHaveBeenCalled();
    expect(h.db.messages).toHaveLength(0);
  });

  it('refuses when a conversation without connection only finds a disabled one', async () => {
    h.db.channel_connections = [
      whatsappConnectionRow('acct-1', 'pn-1', { disabled_at: disabledAt }),
    ];
    await expect(send()).rejects.toBeInstanceOf(ConnectionDisabledError);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('maps to SendMessageError connection_disabled / 409', () => {
    const mapped = toSendMessageError(new ConnectionDisabledError());
    expect(mapped).toBeInstanceOf(SendMessageError);
    expect(mapped).toMatchObject({ code: 'connection_disabled', status: 409 });
  });

  it('showTyping refuses too', async () => {
    h.db.channel_connections = [
      whatsappConnectionRow('acct-1', 'pn-1', { disabled_at: disabledAt }),
    ];
    await expect(
      showTyping({
        conversationId: 'cv-1',
        accountId: 'acct-1',
        inboundExternalId: 'wamid.in',
        db: fakeDb(),
      })
    ).rejects.toBeInstanceOf(ConnectionDisabledError);
    expect(typingMock).not.toHaveBeenCalled();
  });
});

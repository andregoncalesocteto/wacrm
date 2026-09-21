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
  type Capabilities,
  type ChannelProvider,
  type ContactIdentity,
} from './types';
import { SendMessageError } from '@/lib/whatsapp/send-message';
import {
  sendOutbound,
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

function provider(): ChannelProvider {
  return {
    type: 'whatsapp_cloud',
    identityKinds: ['whatsapp:phone'],
    capabilities: caps,
    resolveTarget: resolveTargetMock,
    send: sendMock,
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

  it('template/interactive are left to US-024', async () => {
    await expect(
      send({
        message: { type: 'template', template: { name: 't', language: 'en' } },
      })
    ).rejects.toMatchObject({ code: 'unsupported' });
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
  it('pauses the active run scoped by account+contact+active for an agent', async () => {
    await send();
    expect(h.flowPauses).toHaveLength(1);
    expect(h.flowPauses[0].patch).toMatchObject({
      status: 'paused_by_agent',
      end_reason: 'agent_replied',
    });
    expect(h.flowPauses[0].filters).toEqual([
      ['account_id', 'acct-1'],
      ['contact_id', 'ct-1'],
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

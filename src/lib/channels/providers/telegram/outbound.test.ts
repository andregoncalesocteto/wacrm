import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelError } from '../../types';
import type { Connection, InboundEvent } from '../../types';

const TOKEN = '123456:SECRET-abc_DEF';
const h = vi.hoisted(() => ({
  db: {} as Record<string, Record<string, unknown>[]>,
  seq: 0,
}));
vi.mock('../../connections', () => ({
  getConnectionCredentials: async () => ({
    bot_token: '123456:SECRET-abc_DEF',
  }),
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));

import { telegramProvider } from './index';
import { registerBuiltinProviders } from '../index';
import { sendOutbound } from '../../send';

const conn = {
  id: 'c1',
  account_id: 'a1',
  channel_type: 'telegram',
  external_id: '123456',
  disabled_at: null,
  config: {},
} as unknown as Connection;
const target = { kind: 'telegram:chat_id', address: '555' };
const fetchMock = vi.fn();
const ok = (result: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  );
const fail = (status: number, description: string, extra: object = {}) =>
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        ok: false,
        error_code: status,
        description,
        ...extra,
      }),
      { status }
    )
  );
const last = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: url as string, body: JSON.parse(init.body as string) };
};
const sent = (id = 77) => ok({ message_id: id, chat: { id: 555 } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveTarget', () => {
  it('uses the telegram:chat_id identity, null when absent', () => {
    expect(
      telegramProvider.resolveTarget([
        { kind: 'telegram:username', externalId: 'bob' },
        { kind: 'telegram:chat_id', externalId: '555' },
      ])
    ).toEqual(target);
    expect(
      telegramProvider.resolveTarget([
        { kind: 'whatsapp:phone', externalId: '1' },
      ])
    ).toBeNull();
  });
});

describe('send', () => {
  it('text: sendMessage, externalId is chat:message_id', async () => {
    sent(77);
    const r = await telegramProvider.send(conn, target, {
      type: 'text',
      text: 'hello',
    });
    expect(r).toEqual({ externalId: '555:77' });
    expect(last().url).toMatch(
      /^https:\/\/api\.telegram\.org\/bot.+\/sendMessage$/
    );
    expect(last().body).toEqual({ chat_id: '555', text: 'hello' });
  });

  it('reply: reply_parameters with the message id part', async () => {
    sent();
    await telegramProvider.send(conn, target, {
      type: 'text',
      text: 'r',
      replyTo: { externalId: '555:42' },
    });
    expect(last().body.reply_parameters).toEqual({
      message_id: 42,
      allow_sending_without_reply: true,
    });
  });

  it('reply to a button tap (chat:cb:id) sends without quoting', async () => {
    sent();
    await telegramProvider.send(conn, target, {
      type: 'text',
      text: 'r',
      replyTo: { externalId: '555:cb:abc' },
    });
    expect(last().body.reply_parameters).toBeUndefined();
  });

  it.each([
    ['image', 'sendPhoto', 'photo'],
    ['video', 'sendVideo', 'video'],
    ['document', 'sendDocument', 'document'],
    ['audio', 'sendAudio', 'audio'],
  ] as const)(
    'media %s -> %s by URL with caption',
    async (kind, method, field) => {
      sent();
      await telegramProvider.send(conn, target, {
        type: 'media',
        kind,
        url: 'https://x.test/f',
        caption: 'cap',
      });
      expect(last().url.endsWith(`/${method}`)).toBe(true);
      expect(last().body).toEqual({
        chat_id: '555',
        [field]: 'https://x.test/f',
        caption: 'cap',
      });
    }
  );

  it('caption over 1024 is invalid, nothing is fetched', async () => {
    await expect(
      telegramProvider.send(conn, target, {
        type: 'media',
        kind: 'image',
        url: 'https://x.test/f',
        caption: 'x'.repeat(1025),
      })
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('buttons: sendMessage with an inline keyboard, one row per button', async () => {
    sent();
    await telegramProvider.send(conn, target, {
      type: 'interactive',
      interactive: {
        kind: 'buttons',
        body: 'Pick',
        buttons: [
          { id: 'yes', title: 'Yes' },
          { id: 'no', title: 'No' },
        ],
      },
    });
    expect(last().body).toEqual({
      chat_id: '555',
      text: 'Pick',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Yes', callback_data: 'yes' }],
          [{ text: 'No', callback_data: 'no' }],
        ],
      },
    });
  });

  it('callback_data over 64 bytes is invalid (bytes, not chars)', async () => {
    const mk = (id: string) => ({
      type: 'interactive' as const,
      interactive: {
        kind: 'buttons' as const,
        body: 'b',
        buttons: [{ id, title: 't' }],
      },
    });
    await expect(
      telegramProvider.send(conn, target, mk('é'.repeat(33)))
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(fetchMock).not.toHaveBeenCalled();
    sent();
    await telegramProvider.send(conn, target, mk('a'.repeat(64)));
  });

  it('template and list are unsupported, before any fetch', async () => {
    await expect(
      telegramProvider.send(conn, target, {
        type: 'template',
        template: { name: 't', language: 'en' },
      })
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      telegramProvider.send(conn, target, {
        type: 'interactive',
        interactive: {
          kind: 'list',
          body: 'b',
          buttonLabel: 'l',
          sections: [],
        },
      })
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('react and typing', () => {
  it('react: setMessageReaction with one emoji; empty clears', async () => {
    ok(true);
    await telegramProvider.react!(conn, target, { externalId: '555:42' }, '👍');
    expect(last().url.endsWith('/setMessageReaction')).toBe(true);
    expect(last().body).toEqual({
      chat_id: '555',
      message_id: 42,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    });
    ok(true);
    await telegramProvider.react!(conn, target, { externalId: '555:42' }, '');
    expect(last().body.reaction).toEqual([]);
  });

  it('react to a non-message ref is invalid', async () => {
    await expect(
      telegramProvider.react!(conn, target, { externalId: '555:cb:x' }, '👍')
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('typing: sendChatAction typing, no inbound id needed', async () => {
    ok(true);
    await telegramProvider.typing!(conn, target);
    expect(last().url.endsWith('/sendChatAction')).toBe(true);
    expect(last().body).toEqual({ chat_id: '555', action: 'typing' });
  });
});

describe('acknowledgeInteraction', () => {
  const tap = (externalId: string): InboundEvent => ({
    kind: 'message',
    externalId,
    sender: [],
    at: new Date(),
    content: { type: 'interactive_reply', id: 'yes', title: 'Yes' },
  });
  it('answers the callback query id from chat:cb:<id>', async () => {
    ok(true);
    await telegramProvider.acknowledgeInteraction!(conn, tap('555:cb:9876'));
    expect(last().url.endsWith('/answerCallbackQuery')).toBe(true);
    expect(last().body).toEqual({ callback_query_id: '9876' });
  });
  it('ignores plain messages', async () => {
    await telegramProvider.acknowledgeInteraction!(conn, {
      kind: 'message',
      externalId: '555:10',
      sender: [],
      at: new Date(),
      content: { type: 'text', text: 'x' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('errors', () => {
  const run = () =>
    telegramProvider.send(conn, target, { type: 'text', text: 'x' });
  it.each([
    [403, 'Forbidden: bot was blocked by the user', 'recipient_unreachable'],
    [400, 'Bad Request: chat not found', 'recipient_unreachable'],
    [400, 'Bad Request: message text is empty', 'invalid'],
    [401, 'Unauthorized', 'auth'],
  ])('%s %s -> %s', async (status, description, code) => {
    fail(status, description);
    await expect(run()).rejects.toMatchObject({ code });
  });

  it('429 -> rate_limited, retryable, with retry_after', async () => {
    fail(429, 'Too Many Requests: retry after 5', {
      parameters: { retry_after: 5 },
    });
    const err = (await run().catch((e) => e)) as ChannelError;
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('5s');
  });

  it('the token never reaches an error message', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`)
    );
    const err = (await run().catch((e) => e)) as ChannelError;
    expect(err.message).not.toContain('SECRET-abc_DEF');
    fail(400, `Bad Request: bot${TOKEN} nope`);
    const err2 = (await run().catch((e) => e)) as ChannelError;
    expect(err2.message).not.toContain('SECRET-abc_DEF');
  });
});

describe('through sendOutbound (fake db, real provider, mocked fetch)', () => {
  function fakeDb(): SupabaseClient {
    class Q {
      op: 'select' | 'insert' | 'update' = 'select';
      payload: Record<string, unknown> = {};
      filters: ((r: Record<string, unknown>) => boolean)[] = [];
      mode: 'many' | 'one' = 'many';
      constructor(public t: string) {}
      select() {
        return this;
      }
      insert(p: Record<string, unknown>) {
        this.op = 'insert';
        this.payload = p;
        return this;
      }
      update(p: Record<string, unknown>) {
        this.op = 'update';
        this.payload = p;
        return this;
      }
      eq(c: string, v: unknown) {
        this.filters.push((r) => r[c] === v);
        return this;
      }
      single() {
        this.mode = 'one';
        return this;
      }
      maybeSingle() {
        this.mode = 'one';
        return this;
      }
      run() {
        const rows = (h.db[this.t] ??= []);
        let out: Record<string, unknown>[];
        if (this.op === 'insert') {
          const row = { id: `${this.t}-${++h.seq}`, ...this.payload };
          rows.push(row);
          out = [row];
        } else {
          out = rows.filter((r) => this.filters.every((f) => f(r)));
          if (this.op === 'update')
            out.forEach((r) => Object.assign(r, this.payload));
          else if (this.t === 'conversations')
            out = out.map((c) => ({
              ...c,
              contact: h.db.contacts.find((k) => k.id === c.contact_id),
            }));
        }
        if (this.mode === 'many') return { data: out, error: null };
        return out[0]
          ? { data: out[0], error: null }
          : { data: null, error: { message: 'no rows' } };
      }
      then<T>(res: (v: unknown) => T, rej?: (e: unknown) => T) {
        return Promise.resolve(this.run()).then(res, rej);
      }
    }
    return { from: (t: string) => new Q(t) } as unknown as SupabaseClient;
  }

  beforeEach(() => {
    registerBuiltinProviders();
    h.seq = 0;
    h.db = {
      contacts: [{ id: 'ct1', account_id: 'a1', phone: '' }],
      contact_identities: [
        {
          account_id: 'a1',
          contact_id: 'ct1',
          kind: 'telegram:chat_id',
          external_id: '555',
        },
      ],
      conversations: [
        { id: 'cv1', account_id: 'a1', contact_id: 'ct1', connection_id: 'c1' },
      ],
      channel_connections: [{ ...conn }],
      messages: [],
    };
  });
  const run = (message: Parameters<typeof sendOutbound>[0]['message']) =>
    sendOutbound({
      conversationId: 'cv1',
      accountId: 'a1',
      message,
      actor: { type: 'bot' },
      db: fakeDb(),
    });

  it('persists the returned chat:message_id', async () => {
    sent(91);
    const r = await run({ type: 'text', text: 'hi' });
    expect(r.externalMessageId).toBe('555:91');
    expect(h.db.messages[0]).toMatchObject({
      message_id: '555:91',
      content_text: 'hi',
      status: 'sent',
    });
    expect(h.db.conversations[0].last_message_text).toBe('hi');
  });

  it('a template is refused by the core before any fetch, nothing persisted', async () => {
    await expect(
      run({ type: 'template', template: { name: 't', language: 'en' } })
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.db.messages).toHaveLength(0);
  });

  it('a blocked bot fails as recipient_unreachable and persists nothing', async () => {
    fail(403, 'Forbidden: bot was blocked by the user');
    await expect(run({ type: 'text', text: 'hi' })).rejects.toMatchObject({
      code: 'recipient_unreachable',
    });
    expect(h.db.messages).toHaveLength(0);
  });
});

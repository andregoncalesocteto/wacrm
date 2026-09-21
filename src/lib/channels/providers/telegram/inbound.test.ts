import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaTransferError } from '../../types';
import type { Connection, InboundEvent } from '../../types';

const SECRET_FOR_ERROR = vi.hoisted(
  () => 'sEcReT_tOkEn-0123456789abcdefghijklmnopqrstuv'
);
const h = vi.hoisted(() => ({
  creds: null as Record<string, unknown> | null,
  byId: null as unknown,
  fail: false,
}));
vi.mock('../../connections', () => ({
  getConnectionCredentials: async () => {
    if (h.fail) throw new Error(`decrypt failed ${SECRET_FOR_ERROR}`);
    return h.creds;
  },
  getConnectionById: async () => h.byId,
  saveConnectionCredentials: vi.fn(),
}));

import { telegramProvider as provider } from './index';

const TOKEN = '123456:BOT-token_XYZ';
const SECRET = 'sEcReT_tOkEn-0123456789abcdefghijklmnopqrstuv';
const ID = '11111111-2222-4333-8444-555555555555';
const conn = {
  id: ID,
  account_id: 'a1',
  channel_type: 'telegram',
  config: {},
} as unknown as Connection;

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', `${name}.json`), 'utf8')
  );

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://crm.example.com/api/channels/telegram/webhook/${ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const parse = (name: string) =>
  provider.parse(req(fixture(name)), conn) as Promise<InboundEvent[]>;
type Msg = Extract<InboundEvent, { kind: 'message' }>;

beforeEach(() => {
  h.creds = { bot_token: TOKEN, secret_token: SECRET };
  h.byId = conn;
  h.fail = false;
});
afterEach(() => vi.restoreAllMocks());

describe('resolveConnection', () => {
  it('loads the connection named by the URL', async () => {
    expect(await provider.resolveConnection(req({}))).toBe(conn);
  });
  it('is null for a non-uuid id, an unknown id or another channel', async () => {
    expect(
      await provider.resolveConnection(
        new Request('https://x/api/channels/telegram/webhook/nope')
      )
    ).toBeNull();
    h.byId = null;
    expect(await provider.resolveConnection(req({}))).toBeNull();
    h.byId = { ...conn, channel_type: 'whatsapp_cloud' };
    expect(await provider.resolveConnection(req({}))).toBeNull();
  });
});

describe('verify', () => {
  const H = 'X-Telegram-Bot-Api-Secret-Token';
  it('accepts the stored secret', async () => {
    expect(await provider.verify(req({}, { [H]: SECRET }), conn)).toBe(true);
  });
  it.each([
    ['a wrong secret of the same length', 'x'.repeat(SECRET.length)],
    ['a shorter secret', SECRET.slice(0, -1)],
    ['a longer secret', SECRET + 'x'],
  ])('rejects %s', async (_n, value) => {
    expect(await provider.verify(req({}, { [H]: value }), conn)).toBe(false);
  });
  it('rejects a missing header', async () => {
    expect(await provider.verify(req({}), conn)).toBe(false);
  });
  it('rejects when no secret is stored or credentials are missing', async () => {
    h.creds = { bot_token: TOKEN };
    expect(await provider.verify(req({}, { [H]: SECRET }), conn)).toBe(false);
    h.creds = null;
    expect(await provider.verify(req({}, { [H]: SECRET }), conn)).toBe(false);
  });
  it('fails closed (and quietly) when the credentials cannot be read', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.fail = true;
    expect(await provider.verify(req({}, { [H]: SECRET }), conn)).toBe(false);
    expect(JSON.stringify(err.mock.calls)).not.toContain(SECRET);
  });
});

describe('parse', () => {
  const sender = [
    { kind: 'telegram:chat_id', externalId: '555000111' },
    { kind: 'telegram:username', externalId: 'maria_s', handle: '@Maria_S' },
  ];

  it('text: externalId is chat:message, identities and name', async () => {
    const [e] = (await parse('text')) as Msg[];
    expect(e).toMatchObject({
      kind: 'message',
      externalId: '555000111:10',
      sender,
      senderName: 'Maria Silva',
      content: { type: 'text', text: 'Olá, tem estoque?' },
    });
    expect(e.at).toEqual(new Date(1758450000 * 1000));
    expect(e.replyToExternalId).toBeUndefined();
  });

  it('reply_to_message becomes replyToExternalId in the same chat', async () => {
    const [e] = (await parse('reply')) as Msg[];
    expect(e.replyToExternalId).toBe('555000111:9');
  });

  it('photo: picks the largest size, jpeg, caption kept', async () => {
    const [e] = (await parse('photo')) as Msg[];
    expect(e.content).toEqual({
      type: 'media',
      kind: 'image',
      media: {
        kind: 'image',
        id: 'AQADlarge:AgACAgQAAxkBAAIB_large',
        mimeType: 'image/jpeg',
      },
      caption: 'veja',
    });
  });

  it('document: file name, mime and caption fallback to the name', async () => {
    const [e] = (await parse('document')) as Msg[];
    expect(e.content).toMatchObject({
      type: 'media',
      kind: 'document',
      media: { mimeType: 'application/pdf', fileName: 'pedido.pdf' },
      caption: 'pedido.pdf',
    });
  });

  it('voice -> audio, video -> video, static sticker -> image', async () => {
    expect(((await parse('voice')) as Msg[])[0].content).toMatchObject({
      kind: 'audio',
      media: { mimeType: 'audio/ogg' },
    });
    expect(((await parse('video')) as Msg[])[0].content).toMatchObject({
      kind: 'video',
      caption: 'clip',
      media: { mimeType: 'video/mp4' },
    });
    expect(((await parse('sticker')) as Msg[])[0].content).toMatchObject({
      kind: 'image',
      media: { mimeType: 'image/webp' },
    });
  });

  it('animated stickers, contacts are unsupported; location has text', async () => {
    const animated = fixture('sticker');
    (
      animated.message as { sticker: { is_animated: boolean } }
    ).sticker.is_animated = true;
    const [s] = (await provider.parse(req(animated), conn)) as Msg[];
    expect(s.content).toMatchObject({ type: 'unsupported' });
    expect(((await parse('contact')) as Msg[])[0].content).toMatchObject({
      type: 'unsupported',
      description: '[contact]',
    });
    expect(((await parse('location')) as Msg[])[0].content).toEqual({
      type: 'location',
      latitude: -23.5505,
      longitude: -46.6333,
      text: '-23.5505,-46.6333',
    });
  });

  it('callback_query -> interactive_reply with data as id and the button text as title', async () => {
    const [e] = (await parse('callback_query')) as Msg[];
    expect(e).toMatchObject({
      kind: 'message',
      externalId: '555000111:cb:4382bfdwdsb323b2d9',
      sender,
      replyToExternalId: '555000111:20',
      content: {
        type: 'interactive_reply',
        id: 'opt_yes',
        title: 'Sim, confirmo',
      },
    });
  });

  it('message_reaction: emoji targets the message; empty list removes', async () => {
    expect(await parse('reaction_added')).toEqual([
      {
        kind: 'reaction',
        externalId: '555000111:10',
        sender,
        emoji: '👍',
        at: new Date(1758450200 * 1000),
      },
    ]);
    expect(
      ((await parse('reaction_removed')) as { emoji: null }[])[0].emoji
    ).toBeNull();
  });

  it('a custom-emoji-only reaction is ignored, not read as a removal', async () => {
    const r = fixture('reaction_added');
    (r.message_reaction as { new_reaction: unknown[] }).new_reaction = [
      { type: 'custom_emoji', custom_emoji_id: '1' },
    ];
    expect(await provider.parse(req(r), conn)).toEqual([]);
  });

  it('ignores edited messages, my_chat_member and group chats (debug log only)', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(await parse('edited_message')).toEqual([]);
    expect(await parse('my_chat_member')).toEqual([]);
    expect(await parse('group_message')).toEqual([]);
    expect(debug).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('oi grupo');
  });

  it('malformed JSON yields nothing; no username -> only the chat id', async () => {
    expect(
      await provider.parse(
        new Request('https://x', { method: 'POST', body: 'not json' }),
        conn
      )
    ).toEqual([]);
    const t = fixture('text');
    const m = t.message as {
      from: { username?: string };
      chat: { username?: string };
    };
    delete m.from.username;
    delete m.chat.username;
    const [e] = (await provider.parse(req(t), conn)) as Msg[];
    expect(e.sender).toEqual([sender[0]]);
  });
});

describe('downloadMedia', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const ref = {
    kind: 'image' as const,
    id: 'AQADlarge:AgACAgQAAxkBAAIB_large',
    mimeType: 'image/jpeg',
  };

  it('getFile with the file_id, then downloads server-side', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true, result: { file_path: 'photos/f.jpg' } })
        )
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const blob = await provider.downloadMedia!(conn, ref);
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('image/jpeg');
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://api.telegram.org/bot${TOKEN}/getFile`
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      file_id: 'AgACAgQAAxkBAAIB_large',
    });
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://api.telegram.org/file/bot${TOKEN}/photos/f.jpg`
    );
  });

  it('a failed transfer is a MediaTransferError without the token', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { file_path: 'p' } }))
      )
      .mockRejectedValueOnce(
        new Error(`fetch failed https://api.telegram.org/file/bot${TOKEN}/p`)
      );
    const err = await provider.downloadMedia!(conn, ref).catch((e) => e);
    expect(err).toBeInstanceOf(MediaTransferError);
    expect(err.message).not.toContain(TOKEN);
  });
});

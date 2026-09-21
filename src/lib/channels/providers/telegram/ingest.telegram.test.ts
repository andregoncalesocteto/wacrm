import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = '123456:BOT-token_XYZ';
const ID = '11111111-2222-4333-8444-555555555555';
const h = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatch }));
vi.mock('../../connections', () => ({
  getConnectionCredentials: async () => ({ bot_token: TOKEN }),
  getConnectionById: vi.fn(),
  saveConnectionCredentials: vi.fn(),
}));

import { db, state } from '../../ingest.fake';
import { ingestInbound } from '../../ingest';
import { createMediaResolver } from '../../media';
import { telegramProvider as provider } from './index';
import type { Connection } from '../../types';

const CONN = {
  id: ID,
  account_id: 'acct-1',
  channel_type: 'telegram',
  config: {},
} as unknown as Connection;
const OPTS = { auditUserId: 'owner-1' };
const t = (n: string) => state.tables[n] ?? [];
const fixture = (n: string) =>
  readFileSync(join(__dirname, '__fixtures__', `${n}.json`), 'utf8');
const events = (n: string) =>
  provider.parse(
    new Request('https://x', { method: 'POST', body: fixture(n) }),
    CONN
  );

const upload = vi.fn();
const storage = {
  from: () => ({
    upload,
    getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }),
  }),
};
const fetchMock = vi.fn();

beforeEach(() => {
  state.tables = {};
  state.seq = 0;
  state.rpcCalls = [];
  h.dispatch.mockReset();
  upload.mockReset().mockResolvedValue({ error: null });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('Telegram events through ingestInbound', () => {
  it('creates contact + identities + conversation + message; a replay adds nothing', async () => {
    const first = await ingestInbound(db, CONN, await events('text'), OPTS);
    expect(first[0].status).toBe('stored');
    expect(t('contacts')).toHaveLength(1);
    expect(t('conversations')).toHaveLength(1);
    expect(t('messages')).toHaveLength(1);
    expect(t('messages')[0]).toMatchObject({
      message_id: '555000111:10',
      content_text: 'Olá, tem estoque?',
    });
    expect(t('contact_identities').map((r) => [r.kind, r.external_id])).toEqual(
      [
        ['telegram:chat_id', '555000111'],
        ['telegram:username', 'maria_s'],
      ]
    );

    const replay = await ingestInbound(db, CONN, await events('text'), OPTS);
    expect(replay[0].status).toBe('duplicate');
    expect(t('contacts')).toHaveLength(1);
    expect(t('conversations')).toHaveLength(1);
    expect(t('messages')).toHaveLength(1);
    expect(t('contact_identities')).toHaveLength(2);
  });

  it('the same message_id in another chat is a different message', async () => {
    await ingestInbound(db, CONN, await events('text'), OPTS);
    const other = JSON.parse(fixture('text'));
    other.message.chat.id = 777;
    other.message.from.id = 777;
    other.message.from.username = 'other';
    const evs = await provider.parse(
      new Request('https://x', { method: 'POST', body: JSON.stringify(other) }),
      CONN
    );
    await ingestInbound(db, CONN, evs, OPTS);
    expect(t('messages').map((m) => m.message_id)).toEqual([
      '555000111:10',
      '777:10',
    ]);
  });

  it('a button tap is stored as an interactive reply; a replay is a duplicate', async () => {
    await ingestInbound(db, CONN, await events('callback_query'), OPTS);
    expect(t('messages')[0]).toMatchObject({
      content_type: 'interactive',
      interactive_reply_id: 'opt_yes',
    });
    const again = await ingestInbound(
      db,
      CONN,
      await events('callback_query'),
      OPTS
    );
    expect(again[0].status).toBe('duplicate');
    expect(t('messages')).toHaveLength(1);
  });

  it('mirrors media via getFile without storing or logging a token-bearing URL', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/getFile')
        ? new Response(
            JSON.stringify({ ok: true, result: { file_path: 'photos/p.jpg' } })
          )
        : new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'image/jpeg' },
          })
    );
    const logs = [
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'info'),
    ];
    await ingestInbound(db, CONN, await events('photo'), {
      ...OPTS,
      hooks: { resolveMedia: createMediaResolver({ provider, storage }) },
    });

    expect(upload).toHaveBeenCalledTimes(1);
    const path = t('messages')[0].media_url as string;
    expect(path).toMatch(/^https:\/\/cdn\/account-acct-1\/inbound\//);
    // Nothing persisted (rows, uploaded object names) or logged carries the token.
    const persisted = JSON.stringify([
      state.tables,
      upload.mock.calls.map((c) => c[0]),
    ]);
    expect(persisted).not.toContain(TOKEN);
    expect(persisted).not.toContain('api.telegram.org');
    expect(JSON.stringify(logs.flatMap((l) => l.mock.calls))).not.toContain(
      TOKEN
    );
    // The token-bearing URL was only ever used for the download itself.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `https://api.telegram.org/bot${TOKEN}/getFile`,
      `https://api.telegram.org/file/bot${TOKEN}/photos/p.jpg`,
    ]);
  });

  it('when the download fails the message is kept with no media_url and no token in logs', async () => {
    fetchMock.mockRejectedValue(
      new Error(`fetch failed for https://api.telegram.org/bot${TOKEN}/getFile`)
    );
    const err = vi.spyOn(console, 'error');
    await ingestInbound(db, CONN, await events('photo'), {
      ...OPTS,
      hooks: { resolveMedia: createMediaResolver({ provider, storage }) },
    });
    expect(t('messages')).toHaveLength(1);
    expect(t('messages')[0].media_url ?? null).toBeNull();
    expect(JSON.stringify(err.mock.calls)).not.toContain(TOKEN);
  });

  it('a reaction targets the message by chat:message id', async () => {
    await ingestInbound(db, CONN, await events('text'), OPTS);
    const [r] = await ingestInbound(
      db,
      CONN,
      await events('reaction_added'),
      OPTS
    );
    expect(r.status).toBe('reaction_set');
    expect(t('message_reactions')).toHaveLength(1);
  });
});

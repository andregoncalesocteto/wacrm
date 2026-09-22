import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = '123456:BOT-token_XYZ';
const SECRET = 'sEcReT_tOkEn-0123456789abcdefghijklmnopqrstuv';
const ID = '11111111-2222-4333-8444-555555555555';

const h = vi.hoisted(() => ({
  conn: null as Record<string, unknown> | null,
  ingest: vi.fn(),
  afters: [] as (() => Promise<void>)[],
  owner: 'owner-1' as string | null,
}));

vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => Promise<void>) => {
    h.afters.push(fn);
  },
}));
vi.mock('@/lib/channels/connections', () => ({
  getConnectionById: async () => h.conn,
  getConnectionCredentials: async () => ({
    bot_token: TOKEN,
    secret_token: SECRET,
  }),
  getConnectionByExternalId: vi.fn(),
}));
vi.mock('@/lib/channels/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: h.owner ? { owner_user_id: h.owner } : null,
          }),
        }),
      }),
    }),
    storage: {},
  }),
}));
vi.mock('@/lib/channels/ingest', () => ({ ingestInbound: h.ingest }));

import { POST } from './route';

const update = JSON.parse(
  readFileSync(
    join(
      process.cwd(),
      'src/lib/channels/providers/telegram/__fixtures__/text.json'
    ),
    'utf8'
  )
);
const call = (
  channel: string,
  headers: Record<string, string> = {
    'x-telegram-bot-api-secret-token': SECRET,
  }
) =>
  POST(
    new Request(`https://crm/api/channels/${channel}/webhook/${ID}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(update),
    }),
    { params: Promise.resolve({ channel, connectionId: ID }) }
  );
const flush = async () => {
  for (const fn of h.afters.splice(0)) await fn();
};

beforeEach(() => {
  h.conn = {
    id: ID,
    account_id: 'a1',
    channel_type: 'telegram',
    disabled_at: null,
    config: {},
  };
  h.owner = 'owner-1';
  h.afters = [];
  h.ingest.mockReset().mockResolvedValue([]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

describe('POST /api/channels/[channel]/webhook/[connectionId]', () => {
  it('valid secret: 200 immediately, ingest runs in after() with hooks', async () => {
    const res = await call('telegram');
    expect(res.status).toBe(200);
    expect(h.ingest).not.toHaveBeenCalled();
    await flush();
    expect(h.ingest).toHaveBeenCalledTimes(1);
    const [, connection, events, opts] = h.ingest.mock.calls[0];
    expect(connection.id).toBe(ID);
    expect(events).toHaveLength(1);
    expect(events[0].externalId).toBe('555000111:10');
    expect(opts.auditUserId).toBe('owner-1');
    expect(opts.hooks).toEqual({
      resolveMedia: expect.any(Function),
      onMessageStored: expect.any(Function),
      onConversationCreated: expect.any(Function),
    });
  });

  it.each([
    ['wrong', { 'x-telegram-bot-api-secret-token': 'nope' }],
    ['missing', {}],
  ])('%s secret: 401 and nothing is processed', async (_n, headers) => {
    const res = await call('telegram', headers);
    expect(res.status).toBe(401);
    await flush();
    expect(h.afters).toHaveLength(0);
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('a disabled connection: 200, nothing processed', async () => {
    h.conn!.disabled_at = '2026-09-21T00:00:00Z';
    const res = await call('telegram');
    expect(res.status).toBe(200);
    await flush();
    expect(h.ingest).not.toHaveBeenCalled();
  });

  it('a disabled connection still requires the secret', async () => {
    h.conn!.disabled_at = '2026-09-21T00:00:00Z';
    expect((await call('telegram', {})).status).toBe(401);
  });

  it.each(['whatsapp_cloud', 'nope'])(
    'channel %s: 404 (no generic webhook)',
    async (channel) => {
      expect((await call(channel)).status).toBe(404);
      expect(h.ingest).not.toHaveBeenCalled();
    }
  );

  it('unknown connection or a connection of another channel: 404', async () => {
    h.conn = null;
    expect((await call('telegram')).status).toBe(404);
    h.conn = { id: ID, channel_type: 'whatsapp_cloud' };
    expect((await call('telegram')).status).toBe(404);
  });

  it('never logs the secret or the bot token', async () => {
    const spies = [
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'debug'),
    ];
    await call('telegram', { 'x-telegram-bot-api-secret-token': 'bad' });
    h.ingest.mockRejectedValueOnce(new Error('db down'));
    await call('telegram');
    await flush();
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain('rejected request');
  });

  it('an update with nothing to store is acked without after()', async () => {
    update.message.chat.type = 'group';
    expect((await call('telegram')).status).toBe(200);
    expect(h.afters).toHaveLength(0);
    update.message.chat.type = 'private';
  });

  it('a button tap is acknowledged (answerCallbackQuery) before ingest; failure swallowed', async () => {
    const tap = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'src/lib/channels/providers/telegram/__fixtures__/callback_query.json'
        ),
        'utf8'
      )
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: true }))
      )
      .mockRejectedValueOnce(new Error('network'));
    vi.stubGlobal('fetch', fetchMock);
    const post = () =>
      POST(
        new Request(`https://crm/api/channels/telegram/webhook/${ID}`, {
          method: 'POST',
          headers: { 'x-telegram-bot-api-secret-token': SECRET },
          body: JSON.stringify(tap),
        }),
        { params: Promise.resolve({ channel: 'telegram', connectionId: ID }) }
      );
    expect((await post()).status).toBe(200);
    await flush();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/answerCallbackQuery');
    expect(JSON.parse(init.body).callback_query_id).toBe(
      String(tap.callback_query.id)
    );
    expect(h.ingest).toHaveBeenCalledTimes(1);
    // Second tap: the ack fails, ingest still runs.
    await post();
    await flush();
    expect(h.ingest).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('an ingest failure is swallowed after the ack', async () => {
    h.ingest.mockRejectedValueOnce(new Error('db down'));
    expect((await call('telegram')).status).toBe(200);
    await expect(flush()).resolves.toBeUndefined();
  });
});

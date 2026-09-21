import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelError } from '../../types';
import type { Connection } from '../../types';

const h = vi.hoisted(() => ({
  creds: null as Record<string, unknown> | null,
  saved: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../connections', () => ({
  getConnectionCredentials: async () => h.creds,
  saveConnectionCredentials: async (
    _id: string,
    _acct: string,
    c: Record<string, unknown>
  ) => {
    h.saved.push(c);
    h.creds = c;
  },
}));

import { telegramProvider, telegramCapabilities } from './index';
import { registerBuiltinProviders } from '../index';
import { getProvider } from '../../registry';
import { sanitize } from './errors';

const TOKEN = '123456:SECRET-abc_DEF';
const conn = {
  id: 'c1',
  account_id: 'a1',
  external_id: '123456',
  config: {},
} as unknown as Connection;

const fetchMock = vi.fn();
const reply = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status })
  );
const ok = (result: unknown) => reply({ ok: true, result });
const lastCall = () => {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: url as string, body: JSON.parse(init.body as string) };
};

beforeEach(() => {
  h.creds = { bot_token: TOKEN };
  h.saved = [];
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com/');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('capabilities and registry', () => {
  it('declares the Telegram capabilities', () => {
    expect(telegramCapabilities).toMatchObject({
      templates: false,
      interactiveButtons: true,
      interactiveList: false,
      reactions: true,
      typingIndicator: true,
      deliveryStatus: false,
      readStatus: false,
      initiate: 'after_inbound',
      replyWindowHours: null,
      maxMediaBytes: 50 * 1024 * 1024,
      captionMaxLength: 1024,
    });
    expect(telegramCapabilities.mediaKinds).toEqual([
      'image',
      'video',
      'document',
      'audio',
    ]);
  });

  it('is registered by registerBuiltinProviders', () => {
    registerBuiltinProviders();
    expect(getProvider('telegram').type).toBe('telegram');
  });

  it('validates credentials and config', () => {
    const c = telegramProvider.credentialsSchema;
    expect(c.safeParse({}).success).toBe(false);
    expect(c.safeParse({ bot_token: '' }).success).toBe(false);
    expect(c.safeParse({ bot_token: TOKEN, extra: 1 })).toEqual({
      success: true,
      data: { bot_token: TOKEN },
    });
    expect(telegramProvider.configSchema.safeParse({}).success).toBe(true);
    expect(telegramProvider.configSchema.safeParse([]).success).toBe(false);
  });

  it('inbound/outbound are unsupported for now', async () => {
    await expect(async () =>
      telegramProvider.send(
        conn,
        { kind: 'k', address: '1' },
        {
          type: 'text',
          text: 'x',
        }
      )
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(() => telegramProvider.parse(new Request('http://x'), conn)).toThrow(
      ChannelError
    );
  });
});

describe('connect', () => {
  it('generates a url-safe secret, persists it and calls setWebhook', async () => {
    ok(true);
    const r = await telegramProvider.connect(conn);
    expect(r).toEqual({
      ok: true,
      details: {
        webhook_url: 'https://crm.example.com/api/channels/telegram/webhook/c1',
      },
    });
    const { url, body } = lastCall();
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/setWebhook`);
    expect(body.url).toBe(
      'https://crm.example.com/api/channels/telegram/webhook/c1'
    );
    expect(body.allowed_updates).toEqual([
      'message',
      'edited_message',
      'callback_query',
      'message_reaction',
    ]);
    expect(body.secret_token).toMatch(/^[A-Za-z0-9_-]{32,256}$/);
    // persisted (merged with bot_token) and the same one sent to Telegram
    expect(h.saved).toEqual([
      { bot_token: TOKEN, secret_token: body.secret_token },
    ]);
  });

  it('uses a fresh secret on every connect', async () => {
    ok(true);
    ok(true);
    await telegramProvider.connect(conn);
    const a = lastCall().body.secret_token;
    await telegramProvider.connect(conn);
    expect(lastCall().body.secret_token).not.toBe(a);
  });

  it.each(['http://localhost:3000', 'http://crm.example.com', ''])(
    'refuses a non-HTTPS public URL (%s) without calling Telegram',
    async (origin) => {
      vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
      const r = await telegramProvider.connect(conn);
      expect(r.ok).toBe(false);
      expect(r.error?.code).toBe('invalid');
      expect(r.message).toMatch(/HTTPS/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(h.saved).toEqual([]);
    }
  );

  it('maps a Bot API failure and never leaks the token', async () => {
    reply(
      {
        ok: false,
        error_code: 401,
        description: `Unauthorized https://api.telegram.org/bot${TOKEN}/setWebhook`,
      },
      401
    );
    const r = await telegramProvider.connect(conn);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('auth');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain('SECRET-abc');
  });

  it('a network error keeps the reason but not the token', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error(
        `fetch failed for https://api.telegram.org/bot${TOKEN}/setWebhook`
      )
    );
    const r = await telegramProvider.connect(conn);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('fails clearly when there is no bot token', async () => {
    h.creds = null;
    const r = await telegramProvider.connect(conn);
    expect(r).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('disconnect', () => {
  it('calls deleteWebhook', async () => {
    ok(true);
    await telegramProvider.disconnect(conn);
    expect(lastCall().url).toBe(
      `https://api.telegram.org/bot${TOKEN}/deleteWebhook`
    );
  });
  it('is best-effort: swallows failures', async () => {
    reply({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    await expect(telegramProvider.disconnect(conn)).resolves.toBeUndefined();
    fetchMock.mockRejectedValueOnce(new Error('down'));
    await expect(telegramProvider.disconnect(conn)).resolves.toBeUndefined();
  });
});

describe('health', () => {
  const OURS = 'https://crm.example.com/api/channels/telegram/webhook/c1';
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('connected: our url, no error, few pending', async () => {
    ok({ url: OURS, pending_update_count: 2 });
    expect((await telegramProvider.health(conn)).state).toBe('connected');
    expect(lastCall().url).toContain('/getWebhookInfo');
  });
  it('connected when an old error is stale', async () => {
    ok({
      url: OURS,
      pending_update_count: 0,
      last_error_date: nowSec() - 3 * 3600,
      last_error_message: 'old',
    });
    expect((await telegramProvider.health(conn)).state).toBe('connected');
  });
  it('degraded on a recent delivery error', async () => {
    ok({
      url: OURS,
      pending_update_count: 0,
      last_error_date: nowSec() - 60,
      last_error_message: 'Wrong response from the webhook: 502',
    });
    const h1 = await telegramProvider.health(conn);
    expect(h1.state).toBe('degraded');
    expect(h1.reason).toContain('502');
  });
  it('degraded on many pending updates', async () => {
    ok({ url: OURS, pending_update_count: 500 });
    expect((await telegramProvider.health(conn)).state).toBe('degraded');
  });
  it('needs_action when the webhook is missing or elsewhere', async () => {
    ok({ url: '', pending_update_count: 0 });
    expect((await telegramProvider.health(conn)).state).toBe('needs_action');
    ok({ url: 'https://other.example.com/hook' });
    expect((await telegramProvider.health(conn)).state).toBe('needs_action');
  });
  it('needs_action when the token is invalid (401)', async () => {
    reply({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    expect((await telegramProvider.health(conn)).state).toBe('needs_action');
  });
  it('degraded on a transient failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    expect((await telegramProvider.health(conn)).state).toBe('degraded');
  });
});

describe('deriveExternalId', () => {
  it('returns the bot id as a string', async () => {
    ok({ id: 987654321, is_bot: true, first_name: 'Shop' });
    await expect(
      telegramProvider.deriveExternalId!({}, { bot_token: TOKEN })
    ).resolves.toBe('987654321');
    expect(lastCall().url).toContain('/getMe');
  });
  it('an invalid token is an auth ChannelError without the token', async () => {
    reply({ ok: false, error_code: 401, description: 'Unauthorized' }, 401);
    const err = await telegramProvider.deriveExternalId!(
      {},
      { bot_token: TOKEN }
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.code).toBe('auth');
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('Bot API error mapping', () => {
  const codeFor = async (status: number, extra: object = {}) => {
    reply(
      { ok: false, error_code: status, description: 'x', ...extra },
      status
    );
    return telegramProvider.deriveExternalId!({}, { bot_token: TOKEN }).catch(
      (e) => e as ChannelError
    );
  };
  it.each([
    [401, 'auth'],
    [404, 'auth'],
    [403, 'recipient_unreachable'],
    [400, 'invalid'],
    [500, 'unknown'],
  ])('%i -> %s', async (status, code) => {
    expect(((await codeFor(status)) as ChannelError).code).toBe(code);
  });
  it('429 -> rate_limited, retryable, with retry_after', async () => {
    const e = (await codeFor(429, {
      parameters: { retry_after: 7 },
    })) as ChannelError;
    expect(e.code).toBe('rate_limited');
    expect(e.retryable).toBe(true);
    expect(e.message).toContain('7s');
  });
  it('sanitize strips the token and bot<token> URL forms', () => {
    expect(sanitize(`a ${TOKEN} b`, TOKEN)).not.toContain('SECRET');
    expect(sanitize('x/bot999:AAA-bbb/getMe')).toBe('x/bot***/getMe');
  });
});

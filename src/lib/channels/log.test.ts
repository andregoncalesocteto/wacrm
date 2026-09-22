import { afterEach, describe, expect, it, vi } from 'vitest';
import { channelLog, connCtx, formatChannelLog } from './log';

const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const SECRET_TOKEN = 'wh-secret-9f8e7d6c5b4a';
const FILE_URL = `https://api.telegram.org/file/bot${BOT_TOKEN}/photos/p.jpg`;

afterEach(() => vi.restoreAllMocks());

describe('channelLog format', () => {
  it('emits [channel:<type>] conn=<id> event=<id> message key=value', () => {
    const line = formatChannelLog(
      { type: 'telegram', connectionId: 'c1', eventId: '55:9' },
      'stored',
      { count: 2 }
    );
    expect(line).toBe('[channel:telegram] conn=c1 event=55:9 stored count=2');
  });

  it('uses - for unknown parts and derives the context from a connection', () => {
    expect(formatChannelLog({}, 'x')).toBe('[channel:-] conn=- event=- x');
    expect(connCtx({ id: 'c2', channel_type: 'whatsapp_cloud' }, 'w1')).toEqual(
      { type: 'whatsapp_cloud', connectionId: 'c2', eventId: 'w1' }
    );
  });

  it('writes through the console level asked for', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    channelLog('warn', {}, 'careful');
    expect(warn).toHaveBeenCalledWith('[channel:-] conn=- event=- careful');
  });
});

describe('channelLog never leaks secrets', () => {
  const capture = () => {
    const spies = (['info', 'warn', 'error'] as const).map((l) =>
      vi.spyOn(console, l).mockImplementation(() => {})
    );
    return () => JSON.stringify(spies.flatMap((s) => s.mock.calls));
  };

  it('redacts credential-like fields by key', () => {
    const out = capture();
    channelLog('info', {}, 'connected', {
      bot_token: BOT_TOKEN,
      secret_token: SECRET_TOKEN,
      access_token: 'EAAB-meta-token',
      credentials: { bot_token: BOT_TOKEN, secret_token: SECRET_TOKEN },
      password: 'hunter2',
    });
    const text = out();
    for (const s of [BOT_TOKEN, SECRET_TOKEN, 'EAAB-meta-token', 'hunter2']) {
      expect(text).not.toContain(s);
    }
    expect(text).toContain('[redacted]');
  });

  it('redacts secrets nested inside an object field', () => {
    const out = capture();
    channelLog('error', {}, 'boom', {
      payload: { conn: { secret_token: SECRET_TOKEN } },
    });
    expect(out()).not.toContain(SECRET_TOKEN);
  });

  it('scrubs Telegram file URLs and bot tokens out of messages and errors', () => {
    const out = capture();
    channelLog('error', {}, `download failed ${FILE_URL}`, {
      error: new Error(`fetch failed for ${FILE_URL}`),
      raw: `token is ${BOT_TOKEN}`,
      api: `https://api.telegram.org/bot${BOT_TOKEN}/getFile`,
      supabase: { message: `bad ${FILE_URL}` },
    });
    const text = out();
    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain('api.telegram.org');
    expect(text).not.toContain('photos/p.jpg');
  });
});

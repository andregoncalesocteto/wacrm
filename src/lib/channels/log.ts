/**
 * Structured, secret-free logging for everything under lib/channels/.
 *
 * Line shape: `[channel:<type>] conn=<id> event=<id> <message> key=value ...`
 * (`-` stands for an unknown type / connection / event).
 *
 * Nothing sensitive may leave through here: fields whose key looks like a
 * secret are replaced, and string content is scrubbed of Telegram bot
 * tokens and Telegram API / file URLs (which embed the bot token). Callers
 * should still pass only what they need, never a credentials object.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  /** Channel type key, e.g. `whatsapp_cloud` or `telegram`. */
  type?: string | null;
  connectionId?: string | null;
  /** Provider event id (external message id, update id, ...). */
  eventId?: string | null;
}

const REDACTED = '[redacted]';

const SECRET_KEY =
  /token|secret|credential|password|passwd|authorization|api[_-]?key|access[_-]?key|bearer/i;

/** Telegram API / file URLs carry the bot token in the path. */
const TELEGRAM_URL = /https?:\/\/api\.telegram\.org\S*/gi;
/** `bot<id>:<token>` and a bare `<id>:<token>` bot token. */
const BOT_TOKEN = /(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}/g;

/** Scrubs secrets out of arbitrary text. */
export function scrub(text: string): string {
  return text
    .replace(TELEGRAM_URL, '[telegram-url]')
    .replace(BOT_TOKEN, REDACTED);
}

function render(value: unknown): string {
  if (value instanceof Error) return scrub(value.message);
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    const msg = (value as { message?: unknown }).message;
    // Supabase / provider errors: the message is enough.
    if (typeof msg === 'string') return scrub(msg);
    try {
      return scrub(JSON.stringify(value, redactingReplacer));
    } catch {
      return '[unserializable]';
    }
  }
  return scrub(String(value));
}

function redactingReplacer(key: string, value: unknown): unknown {
  return key && SECRET_KEY.test(key) ? REDACTED : value;
}

/** Builds the log line (exported for tests). */
export function formatChannelLog(
  ctx: LogContext,
  message: string,
  fields?: Record<string, unknown>
): string {
  const head = `[channel:${ctx.type || '-'}] conn=${ctx.connectionId || '-'} event=${ctx.eventId || '-'}`;
  const tail = Object.entries(fields ?? {})
    .map(([k, v]) => `${k}=${SECRET_KEY.test(k) ? REDACTED : render(v)}`)
    .join(' ');
  return `${head} ${scrub(message)}${tail ? ` ${tail}` : ''}`;
}

export function channelLog(
  level: LogLevel,
  ctx: LogContext,
  message: string,
  fields?: Record<string, unknown>
): void {
  console[level](formatChannelLog(ctx, message, fields));
}

/** Context for a loaded connection (type + id). */
export function connCtx(
  conn: { id: string; channel_type?: string | null } | null | undefined,
  eventId?: string | null
): LogContext {
  return {
    type: conn?.channel_type ?? null,
    connectionId: conn?.id ?? null,
    eventId: eventId ?? null,
  };
}

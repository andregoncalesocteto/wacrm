import { ChannelError } from '../../types';

/**
 * Bot API failures -> ChannelError (design.md section 5). The Telegram URL
 * embeds the bot token (`/bot<token>/METHOD`), so nothing built from a URL,
 * a fetch error or an error description may reach a message unsanitized.
 */

export interface BotApiFailure {
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

/** Removes the token (and any `bot<token>` URL form) from a string. */
export function sanitize(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join('***');
  // Any token-shaped `bot<id>:<secret>` left in a URL.
  return out.replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot***');
}

/** Maps a Bot API `{ ok: false }` body (+ HTTP status) to a ChannelError. */
export function fromBotApiFailure(
  body: BotApiFailure,
  httpStatus: number,
  token?: string
): ChannelError {
  const code = body.error_code ?? httpStatus;
  const message = sanitize(
    body.description || `Telegram request failed (${code})`,
    token
  );
  const opts = { providerCode: code };
  if (code === 401 || code === 404)
    return new ChannelError('auth', message, opts);
  if (code === 429) {
    const wait = body.parameters?.retry_after;
    return new ChannelError(
      'rate_limited',
      wait ? `${message} (retry after ${wait}s)` : message,
      { ...opts, retryable: true }
    );
  }
  if (code === 403)
    return new ChannelError('recipient_unreachable', message, opts);
  if (code === 400) return new ChannelError('invalid', message, opts);
  return new ChannelError('unknown', message, opts);
}

import { ChannelError } from '../../types';
import { fromBotApiFailure, sanitize } from './errors';
import type { BotApiFailure } from './errors';

const API_BASE = 'https://api.telegram.org';

/**
 * ONE Bot API call (`POST https://api.telegram.org/bot<token>/<method>`, JSON
 * body). Returns `result`; throws a ChannelError whose message never contains
 * the token. Never logs.
 */
export async function callBotApi<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  } catch (err) {
    // The fetch error can quote the URL (token included): drop it, keep the reason.
    const reason = err instanceof Error ? sanitize(err.message, token) : '';
    throw new ChannelError(
      'unknown',
      `Could not reach Telegram (${method})${reason ? `: ${reason}` : ''}`,
      { retryable: true }
    );
  }

  let body: ({ ok: boolean; result?: T } & BotApiFailure) | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!body || body.ok !== true) {
    throw fromBotApiFailure(body ?? {}, res.status, token);
  }
  return body.result as T;
}

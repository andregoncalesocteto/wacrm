import { randomBytes } from 'node:crypto';
import { ChannelError } from '../../types';
import type { Connection, ConnectResult, Health } from '../../types';
import {
  getConnectionCredentials,
  saveConnectionCredentials,
} from '../../connections';
import { callBotApi } from './api';

/**
 * Lifecycle of the Telegram provider (design.md section 9). Webhook per
 * connection: `${NEXT_PUBLIC_SITE_URL}/api/channels/telegram/webhook/<id>`,
 * authenticated by a random `secret_token` kept encrypted in the credentials.
 */

export const WEBHOOK_ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'message_reaction',
];

/** Pending updates above this mean we are not keeping up (degraded). */
export const PENDING_UPDATES_DEGRADED = 100;
/** A delivery error older than this no longer counts (seconds). */
export const RECENT_ERROR_SECONDS = 60 * 60;

/** Stable `reason` of the https guard; the UI maps it to a translated message. */
export const PUBLIC_HTTPS_REQUIRED = 'public_https_required';

const WEBHOOK_PATH = (id: string) => `/api/channels/telegram/webhook/${id}`;

interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
}

async function requireBotToken(conn: Connection) {
  const creds = await getConnectionCredentials(conn.id);
  if (!creds || typeof creds.bot_token !== 'string' || !creds.bot_token) {
    throw new ChannelError('auth', 'Telegram connection has no bot token');
  }
  return { creds, token: creds.bot_token };
}

/** `secret_token`: 43 chars of base64url = A-Z a-z 0-9 _ - (Telegram's allowed set). */
export function generateSecretToken(): string {
  return randomBytes(32).toString('base64url');
}

function failure(err: unknown): ConnectResult {
  const ce =
    err instanceof ChannelError
      ? err
      : new ChannelError('unknown', 'Telegram connect failed');
  return { ok: false, message: ce.message, error: ce.toInfo() };
}

export async function connect(conn: Connection): Promise<ConnectResult> {
  const origin = (process.env.NEXT_PUBLIC_SITE_URL ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!origin.startsWith('https://')) {
    const message =
      'Telegram only delivers webhooks to a public HTTPS URL. Set NEXT_PUBLIC_SITE_URL to your public https:// address (use a tunnel such as ngrok or Cloudflare Tunnel in development) and connect again.';
    return {
      ok: false,
      message,
      error: { code: 'invalid', message, reason: PUBLIC_HTTPS_REQUIRED },
    };
  }
  const webhookUrl = `${origin}${WEBHOOK_PATH(conn.id)}`;

  try {
    const { creds, token } = await requireBotToken(conn);
    const secretToken = generateSecretToken();
    // Persist BEFORE registering: the first update may arrive right after setWebhook.
    await saveConnectionCredentials(conn.id, conn.account_id, {
      ...creds,
      secret_token: secretToken,
    });
    await callBotApi<true>(token, 'setWebhook', {
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: WEBHOOK_ALLOWED_UPDATES,
    });
    return { ok: true, details: { webhook_url: webhookUrl } };
  } catch (err) {
    return failure(err);
  }
}

/** Best-effort: never throws (the connection is being turned off anyway). */
export async function disconnect(conn: Connection): Promise<void> {
  try {
    const { token } = await requireBotToken(conn);
    await callBotApi<true>(token, 'deleteWebhook');
  } catch {
    // Nothing to do: a stale webhook 404s/401s on our side and the token may be revoked.
  }
}

export async function health(conn: Connection): Promise<Health> {
  const checkedAt = new Date();
  try {
    const { token } = await requireBotToken(conn);
    const info = await callBotApi<WebhookInfo>(token, 'getWebhookInfo');

    if (!info.url) {
      return {
        state: 'needs_action',
        reason: 'Webhook is not set. Reconnect the channel.',
        checkedAt,
      };
    }
    if (!info.url.endsWith(WEBHOOK_PATH(conn.id))) {
      return {
        state: 'needs_action',
        reason: 'Webhook points to another address. Reconnect the channel.',
        checkedAt,
      };
    }
    const errorAgeSeconds = info.last_error_date
      ? checkedAt.getTime() / 1000 - info.last_error_date
      : Infinity;
    if (info.last_error_message && errorAgeSeconds <= RECENT_ERROR_SECONDS) {
      return {
        state: 'degraded',
        reason: `Recent delivery error: ${info.last_error_message}`,
        checkedAt,
      };
    }
    if ((info.pending_update_count ?? 0) > PENDING_UPDATES_DEGRADED) {
      return {
        state: 'degraded',
        reason: `${info.pending_update_count} updates waiting for delivery`,
        checkedAt,
      };
    }
    return { state: 'connected', checkedAt };
  } catch (err) {
    const ce = err instanceof ChannelError ? err : null;
    if (ce?.code === 'auth') {
      return {
        state: 'needs_action',
        reason: 'Bot token is invalid or was revoked.',
        checkedAt,
      };
    }
    return {
      state: 'degraded',
      reason: ce?.message ?? 'Telegram health check failed',
      checkedAt,
    };
  }
}

/** Bot id from getMe (the token proves it); an invalid token is `auth`. */
export async function deriveExternalId(
  _config: Record<string, unknown>,
  credentials: Record<string, unknown>
): Promise<string> {
  const token = credentials.bot_token;
  if (typeof token !== 'string' || !token) {
    throw new ChannelError('auth', 'Telegram bot token is missing');
  }
  const me = await callBotApi<{ id?: number }>(token, 'getMe');
  if (me?.id === undefined || me.id === null) {
    throw new ChannelError('unknown', 'Telegram getMe returned no bot id');
  }
  return String(me.id);
}

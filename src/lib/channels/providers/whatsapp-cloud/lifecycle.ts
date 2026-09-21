import { ChannelError } from '../../types';
import type {
  Connection,
  ConnectOptions,
  ConnectResult,
  Health,
  MediaRef,
  Target,
} from '../../types';
import { getConnectionCredentials } from '../../connections';
import {
  downloadMedia as metaDownloadMedia,
  getMediaUrl,
  getSubscribedApps,
  listWabaPhoneNumbers,
  registerPhoneNumber,
  sendTypingIndicator,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api';
import { explainMetaError } from '@/lib/whatsapp/meta-error-explain';
import type { MetaConnectStep } from '@/lib/whatsapp/meta-error-explain';
import {
  appSubscriptionState,
  describeWabaPhoneMismatch,
  phoneNumberBelongsToWaba,
} from '@/lib/whatsapp/waba-pairing';
import { toChannelError } from './errors';

/**
 * Lifecycle and optional operations of the WhatsApp provider. Reuses the same
 * meta-api calls and pairing/explain helpers as the production routes
 * (`api/whatsapp/config` and `config/verify-registration`, untouched).
 */

async function requireAccessToken(conn: Connection): Promise<string> {
  const creds = await getConnectionCredentials(conn.id);
  if (!creds?.access_token) {
    throw new ChannelError('auth', 'WhatsApp connection has no access token');
  }
  return creds.access_token;
}

const wabaIdOf = (conn: Connection): string | null => {
  const v = conn.config?.waba_id;
  return typeof v === 'string' && v.trim() ? v : null;
};

/**
 * Same steps and order as POST /api/whatsapp/config: read the number, check it
 * belongs to the WABA, register it (only with a PIN), subscribe the WABA.
 * Never persists anything (the PIN included); the core stores the outcome.
 * A missing PIN is not a failure (Meta test numbers, issue #242).
 */
export async function connect(
  conn: Connection,
  opts: ConnectOptions = {}
): Promise<ConnectResult> {
  const fail = (err: unknown, step?: MetaConnectStep): ConnectResult => {
    const ce = toChannelError(err);
    const message = step
      ? explainMetaError(err, step, {
          phoneNumberId: conn.external_id,
          wabaId: wabaIdOf(conn),
        }).summary
      : ce.message;
    return { ok: false, message, error: { ...ce.toInfo(), message } };
  };

  let token: string;
  try {
    token = await requireAccessToken(conn);
  } catch (err) {
    return fail(err);
  }
  const phoneNumberId = conn.external_id;
  const wabaId = wabaIdOf(conn);
  if (!wabaId) {
    const message =
      'No WABA ID on file: webhooks cannot be wired without it. Add it and reconnect.';
    return { ok: false, message, error: { code: 'invalid', message } };
  }

  try {
    await verifyPhoneNumber({ phoneNumberId, accessToken: token });
  } catch (err) {
    return fail(err, 'verify_number');
  }

  try {
    const numbers = await listWabaPhoneNumbers({ wabaId, accessToken: token });
    if (!phoneNumberBelongsToWaba(numbers, phoneNumberId)) {
      const message = describeWabaPhoneMismatch(numbers, phoneNumberId, wabaId);
      return { ok: false, message, error: { code: 'invalid', message } };
    }
  } catch (err) {
    return fail(err, 'waba_phone_numbers');
  }

  const pin = opts.pin;
  if (pin !== undefined && pin !== '' && !/^\d{6}$/.test(pin)) {
    const message = 'PIN must be exactly 6 digits.';
    return { ok: false, message, error: { code: 'invalid', message } };
  }
  let registration: 'registered' | 'skipped' = 'skipped';
  if (pin) {
    try {
      await registerPhoneNumber({ phoneNumberId, accessToken: token, pin });
      registration = 'registered';
    } catch (err) {
      return fail(err, 'register');
    }
  }

  try {
    await subscribeWabaToApp({ wabaId, accessToken: token });
  } catch (err) {
    return fail(err, 'subscribe_waba');
  }

  return {
    ok: true,
    ...(registration === 'skipped' && {
      message:
        'Number not registered (no PIN supplied): inbound webhook routing may need a PIN.',
    }),
    details: { registration },
  };
}

/**
 * Deliberate no-op. Meta offers unsubscribing the WABA from the app and
 * deregistering the number, but both affect the whole WABA (other numbers,
 * other connections of the same app) and the user did not ask for that.
 * Marking the connection disconnected is the core's job.
 */
export async function disconnect(): Promise<void> {}

/**
 * Live check, same three signals as GET verify-registration: number metadata,
 * WABA subscription and local registration (`config.registered_at`).
 * Bad/expired token or missing subscription -> needs_action; Meta down or
 * rate limited -> degraded; not registered but otherwise fine -> degraded.
 */
export async function health(conn: Connection): Promise<Health> {
  const checkedAt = new Date();
  const result = (state: Health['state'], reason?: string): Health => ({
    state,
    ...(reason && { reason }),
    checkedAt,
  });

  let token: string;
  try {
    token = await requireAccessToken(conn);
  } catch (err) {
    return result('needs_action', toChannelError(err).message);
  }

  try {
    await verifyPhoneNumber({
      phoneNumberId: conn.external_id,
      accessToken: token,
    });
  } catch (err) {
    const ce = toChannelError(err);
    if (ce.code === 'auth' || ce.code === 'invalid') {
      return result('needs_action', `Phone number check failed: ${ce.message}`);
    }
    return result('degraded', `Phone number check failed: ${ce.message}`);
  }

  const wabaId = wabaIdOf(conn);
  if (!wabaId) {
    return result(
      'needs_action',
      'No WABA ID on file: webhooks cannot be wired without it.'
    );
  }
  try {
    const subs = await getSubscribedApps({ wabaId, accessToken: token });
    if (!appSubscriptionState(subs, process.env.META_APP_ID).subscribed) {
      return result(
        'needs_action',
        'WABA has no subscribed apps. Reconnect to subscribe.'
      );
    }
  } catch (err) {
    const ce = toChannelError(err);
    return result(
      ce.code === 'auth' ? 'needs_action' : 'degraded',
      `WABA subscription check failed: ${ce.message}`
    );
  }

  if (!conn.config?.registered_at) {
    return result(
      'degraded',
      'Number not registered with Meta (no PIN supplied); inbound routing may not work.'
    );
  }
  return result('connected');
}

/** Two-step Meta media fetch (id -> URL -> bytes), returned as a Blob. */
export async function downloadMedia(
  conn: Connection,
  ref: MediaRef
): Promise<Blob> {
  const token = await requireAccessToken(conn);
  try {
    const { url, mimeType } = await getMediaUrl({
      mediaId: ref.id,
      accessToken: token,
    });
    const { buffer, contentType } = await metaDownloadMedia({
      downloadUrl: url,
      accessToken: token,
    });
    return new Blob([new Uint8Array(buffer)], {
      type: contentType || mimeType,
    });
  } catch (err) {
    throw toChannelError(err);
  }
}

/** Typing indicator rides on the read receipt of the INBOUND message. */
export async function typing(
  conn: Connection,
  _target: Target,
  opts: { inboundExternalId?: string } = {}
): Promise<void> {
  if (!opts.inboundExternalId) {
    throw new ChannelError(
      'invalid',
      'WhatsApp typing indicator needs the inbound message id (inboundExternalId)'
    );
  }
  const token = await requireAccessToken(conn);
  try {
    await sendTypingIndicator({
      phoneNumberId: conn.external_id,
      accessToken: token,
      messageId: opts.inboundExternalId,
    });
  } catch (err) {
    throw toChannelError(err);
  }
}

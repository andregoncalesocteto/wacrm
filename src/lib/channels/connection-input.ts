import { getProvider } from './registry';
import { registerBuiltinProviders } from './providers';
import type { ChannelProvider } from './types';

// Input validation and response shaping for /api/channels/connections.

export const DISPLAY_NAME_MAX = 120;
const EXTERNAL_ID_MAX = 200;

export type Fail = {
  ok: false;
  error: string;
  code?: string;
  details?: unknown;
};
type Ok<T> = { ok: true; value: T };

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Config keys that are secret-ish and never leave the server. */
const SECRET_KEY = /token|secret|password|api_?key|private/i;

/** The connection as returned to clients: no credentials, no secret config keys. */
export function publicConnection(row: Record<string, unknown>) {
  const config = isObject(row.config) ? row.config : {};
  return {
    id: row.id,
    store_id: row.store_id,
    channel_type: row.channel_type,
    display_name: row.display_name,
    external_id: row.external_id,
    status: row.status,
    config: Object.fromEntries(
      Object.entries(config).filter(([k]) => !SECRET_KEY.test(k))
    ),
    last_inbound_at: row.last_inbound_at ?? null,
    last_outbound_at: row.last_outbound_at ?? null,
    last_error: row.last_error ?? null,
    disabled_at: row.disabled_at ?? null,
  };
}

export const PUBLIC_COLUMNS =
  'id, store_id, channel_type, display_name, external_id, status, config, last_inbound_at, last_outbound_at, last_error, disabled_at';

export function providerFor(channelType: unknown): Ok<ChannelProvider> | Fail {
  registerBuiltinProviders();
  if (typeof channelType !== 'string' || !channelType) {
    return { ok: false, error: 'channel_type is required' };
  }
  try {
    return { ok: true, value: getProvider(channelType) };
  } catch {
    return {
      ok: false,
      error: `Unknown channel_type "${channelType}"`,
      code: 'unknown_channel_type',
    };
  }
}

export function parseDisplayName(v: unknown): Ok<string> | Fail {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) return { ok: false, error: 'display_name is required' };
  if (name.length > DISPLAY_NAME_MAX) {
    return {
      ok: false,
      error: `display_name must be at most ${DISPLAY_NAME_MAX} characters`,
    };
  }
  return { ok: true, value: name };
}

export function parseConfig(
  provider: ChannelProvider,
  config: unknown
): Ok<Record<string, unknown>> | Fail {
  const r = provider.configSchema.safeParse(config);
  if (!r.success) {
    return {
      ok: false,
      error: 'Invalid config',
      code: 'invalid_config',
      details: r.error,
    };
  }
  return { ok: true, value: config as Record<string, unknown> };
}

export function parseCredentials(
  provider: ChannelProvider,
  credentials: unknown
): Ok<Record<string, unknown>> | Fail {
  const r = provider.credentialsSchema.safeParse(credentials);
  if (!r.success) {
    return {
      ok: false,
      error: 'Invalid credentials',
      code: 'invalid_credentials',
      details: r.error,
    };
  }
  // Store what the provider validated (its parsed shape), not arbitrary extras.
  return {
    ok: true,
    value: (r.data ?? credentials) as Record<string, unknown>,
  };
}

/**
 * external_id: the explicit one, else derived from the config when the
 * provider keeps it there (WhatsApp `phone_number_id`), else required.
 */
export function resolveExternalId(
  explicit: unknown,
  config: Record<string, unknown>
): Ok<string> | Fail {
  const candidate = explicit ?? config.phone_number_id;
  const v =
    typeof candidate === 'string'
      ? candidate.trim()
      : typeof candidate === 'number'
        ? String(candidate)
        : '';
  if (!v) return { ok: false, error: 'external_id is required' };
  if (v.length > EXTERNAL_ID_MAX) {
    return { ok: false, error: 'external_id is too long' };
  }
  return { ok: true, value: v };
}

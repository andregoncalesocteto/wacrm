import { ChannelError } from '../../types';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

/** Meta (Graph / WhatsApp Cloud) error codes grouped by what the core should do. */
const AUTH_CODES = new Set([190, 102, 463, 467, 10, 200]);
const RATE_LIMIT_CODES = new Set([
  4, 17, 32, 613, 80007, 130429, 131048, 131056,
]);
const UNREACHABLE_CODES = new Set([131026, 131030, 131021, 131033, 131037]);
const WINDOW_CLOSED_CODES = new Set([131047]);
const INVALID_CODES = new Set([
  100, 131008, 131009, 131051, 131052, 131053, 132000, 132001, 132005, 132007,
  132012, 132015, 132016,
]);

/** Meta puts its code in the text as "(#131030)" when the body was not JSON. */
function codeFromMessage(message: string): number | null {
  const m = /\(#(\d{3,6})\)|\b(131\d{3}|132\d{3})\b/.exec(message);
  const raw = m?.[1] ?? m?.[2];
  return raw ? Number(raw) : null;
}

/**
 * Converts anything thrown by `lib/whatsapp/meta-api.ts` into a typed
 * ChannelError, keeping Meta's original message and code (`providerCode`).
 * An existing ChannelError passes through unchanged.
 */
export function toChannelError(err: unknown): ChannelError {
  if (err instanceof ChannelError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const meta = err instanceof MetaApiError ? err : null;
  const code = meta?.code ?? codeFromMessage(message);
  const providerCode = code ?? undefined;
  const opts = { providerCode, cause: err };

  if (code !== null) {
    if (AUTH_CODES.has(code)) return new ChannelError('auth', message, opts);
    if (RATE_LIMIT_CODES.has(code)) {
      return new ChannelError('rate_limited', message, opts);
    }
    if (UNREACHABLE_CODES.has(code)) {
      return new ChannelError('recipient_unreachable', message, opts);
    }
    if (WINDOW_CLOSED_CODES.has(code)) {
      return new ChannelError('window_closed', message, opts);
    }
    if (INVALID_CODES.has(code))
      return new ChannelError('invalid', message, opts);
  }

  if (meta) {
    if (meta.httpStatus === 401) return new ChannelError('auth', message, opts);
    if (meta.httpStatus === 429) {
      return new ChannelError('rate_limited', message, opts);
    }
    if (meta.httpStatus === 400)
      return new ChannelError('invalid', message, opts);
  }

  // Local validation thrown by meta-api before any network call
  // (e.g. "Interactive button message requires 1-3 buttons").
  if (!meta && /^Interactive |exceeds|requires|must be/i.test(message)) {
    return new ChannelError('invalid', message, opts);
  }
  return new ChannelError('unknown', message, opts);
}

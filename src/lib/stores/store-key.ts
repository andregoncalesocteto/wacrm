// The STORE KEY `CODE/STORE ACRONYM/BUSINESS ACRONYM` (e.g. `89/RPA/BLC`).
// Pure helpers, shared by the routes, the UI and the lookup.

export interface StoreKeyParts {
  store_code?: string | null;
  store_acronym?: string | null;
  business_acronym?: string | null;
}

/** The key as the operator typed it, or null unless all three parts are set. */
export function buildStoreKey(parts: StoreKeyParts): string | null {
  const code = parts.store_code?.trim();
  const acronym = parts.store_acronym?.trim();
  const business = parts.business_acronym?.trim();
  if (!code || !acronym || !business) return null;
  return `${code}/${acronym}/${business}`;
}

/**
 * Canonical form used for comparison: each part trimmed, the whole lower-cased
 * (mirrors `stores.store_key_normalized`). Null when the input is not three
 * non-empty parts.
 */
export function normalizeStoreKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('/').map((p) => p.trim());
  if (parts.length !== 3 || parts.some((p) => !p)) return null;
  return parts.join('/').toLowerCase();
}

/** Route error bodies (the UI maps `code` to a translated message). */
export const STORE_KEY_TAKEN = {
  error: 'Another store in this account already has this store key',
  code: 'store_key_taken',
} as const;

export const INVALID_NOTIFICATION_CONNECTION = {
  error:
    'notification_connection_id must be a WhatsApp connection of this store',
  code: 'invalid_notification_connection',
} as const;

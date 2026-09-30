// Input validation for the store routes (POST/PATCH /api/stores).

export const STORE_LIMITS = {
  name: 120,
  address: 300,
  phone: 40,
  manager_name: 120,
  menu_url: 2048,
  store_code: 40,
  store_acronym: 40,
  business_acronym: 40,
} as const;

/**
 * A Digital menu address must be an absolute https:// URL with a host.
 * Blank is not valid here; callers treat blank as "no menu" before calling.
 */
export function isValidMenuUrl(raw: string): boolean {
  const v = raw.trim();
  if (!v || v.length > STORE_LIMITS.menu_url) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname !== '';
  } catch {
    return false;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoreInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  business_hours?: Record<string, unknown> | null;
  manager_name?: string | null;
  menu_url?: string | null;
  store_code?: string | null;
  store_acronym?: string | null;
  business_acronym?: string | null;
  /** Checked against the DB by the route (same store/account, WhatsApp). */
  notification_connection_id?: string | null;
  settings?: Record<string, unknown>;
}

export type StoreParse =
  { ok: true; value: StoreInput } | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a store payload. `partial` (PATCH) only validates the fields that are
 * present; otherwise (POST) `name` is required. Optional text fields are
 * trimmed and an empty string becomes null.
 */
export function parseStoreInput(body: unknown, partial: boolean): StoreParse {
  if (!isObject(body)) return { ok: false, error: 'Invalid JSON body' };
  const out: StoreInput = {};

  if ('name' in body || !partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { ok: false, error: 'name is required' };
    if (name.length > STORE_LIMITS.name) {
      return {
        ok: false,
        error: `name must be at most ${STORE_LIMITS.name} characters`,
      };
    }
    out.name = name;
  }

  for (const key of [
    'address',
    'phone',
    'manager_name',
    'menu_url',
    'store_code',
    'store_acronym',
    'business_acronym',
  ] as const) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw === null || raw === undefined) {
      out[key] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      return { ok: false, error: `${key} must be a string or null` };
    }
    const v = raw.trim();
    if (v.length > STORE_LIMITS[key]) {
      return {
        ok: false,
        error: `${key} must be at most ${STORE_LIMITS[key]} characters`,
      };
    }
    if (key === 'menu_url' && v && !isValidMenuUrl(v)) {
      return { ok: false, error: 'menu_url must be a valid https:// URL' };
    }
    if (
      (key === 'store_code' ||
        key === 'store_acronym' ||
        key === 'business_acronym') &&
      v.includes('/')
    ) {
      return { ok: false, error: `${key} must not contain "/"` };
    }
    out[key] = v || null;
  }

  if ('notification_connection_id' in body) {
    const raw = body.notification_connection_id;
    if (raw === null || raw === undefined || raw === '') {
      out.notification_connection_id = null;
    } else if (typeof raw === 'string' && UUID_RE.test(raw)) {
      out.notification_connection_id = raw;
    } else {
      return {
        ok: false,
        error: 'notification_connection_id must be a UUID or null',
      };
    }
  }

  if ('business_hours' in body) {
    const bh = body.business_hours;
    if (bh === null || bh === undefined) out.business_hours = null;
    else if (isObject(bh)) out.business_hours = bh;
    else {
      return { ok: false, error: 'business_hours must be an object or null' };
    }
  }

  if ('settings' in body) {
    if (!isObject(body.settings)) {
      return { ok: false, error: 'settings must be an object' };
    }
    out.settings = body.settings;
  }

  return { ok: true, value: out };
}

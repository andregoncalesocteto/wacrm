// Input validation for the store routes (POST/PATCH /api/stores).

export const STORE_LIMITS = {
  name: 120,
  address: 300,
  phone: 40,
  manager_name: 120,
} as const;

export interface StoreInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  business_hours?: Record<string, unknown> | null;
  manager_name?: string | null;
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

  for (const key of ['address', 'phone', 'manager_name'] as const) {
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
    out[key] = v || null;
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

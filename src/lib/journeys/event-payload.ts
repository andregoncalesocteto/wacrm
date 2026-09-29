import { badRequest } from '@/lib/api/v1/respond';

/**
 * Body of `POST /api/v1/journey/events`: parsing and validation only. Every
 * failure is a `bad_request` naming the offending field (the caller is another
 * team's backend; the message is what they debug with).
 */

/** Every name the contract lists. Only some have a handler yet (see events.ts). */
export const JOURNEY_EVENT_NAMES = [
  'ViewContent',
  'AddToCart',
  'InitiateCheckout',
  'Purchase',
  'OrderStatusChanged',
] as const;
export type JourneyEventName = (typeof JOURNEY_EVENT_NAMES)[number];

export interface CartItem {
  id: string;
  name: string | null;
  quantity: number;
  unit_price: number;
}

/** `properties` of AddToCart / InitiateCheckout: the WHOLE cart at that moment. */
export interface CartProperties {
  currency: string;
  cart: { value: number; items: CartItem[] };
}

export interface CommonEventFields {
  eventId: string;
  name: string;
  idtrack: string;
  occurredAt: Date;
}

const MAX_EVENT_ID_LENGTH = 200;
const MAX_CART_ITEMS = 200;
// ISO 8601 with an explicit UTC designator (`Z` or `+00:00`).
const ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]00:?00)$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function requireString(
  body: Record<string, unknown>,
  field: string,
  path = field
): string {
  const v = body[field];
  if (typeof v !== 'string' || v.trim() === '') {
    throw badRequest(`'${path}' is required and must be a non-empty string`);
  }
  return v.trim();
}

/** Validate the fields every event carries. `name` is checked by the caller. */
export function parseCommonFields(body: unknown): CommonEventFields {
  if (!isObject(body)) throw badRequest('Request body must be a JSON object');

  const eventId = requireString(body, 'event_id');
  if (eventId.length > MAX_EVENT_ID_LENGTH) {
    throw badRequest(
      `'event_id' must have at most ${MAX_EVENT_ID_LENGTH} characters`
    );
  }
  const name = requireString(body, 'name');
  const idtrack = requireString(body, 'idtrack');

  const rawAt = requireString(body, 'occurred_at');
  const occurredAt = new Date(rawAt);
  if (!ISO_UTC.test(rawAt) || Number.isNaN(occurredAt.getTime())) {
    throw badRequest(
      "'occurred_at' must be an ISO 8601 UTC timestamp, e.g. 2026-10-02T21:14:05Z"
    );
  }
  return { eventId, name, idtrack, occurredAt };
}

/** Validate `properties` of AddToCart / InitiateCheckout. */
export function parseCartProperties(body: unknown): CartProperties {
  const properties = isObject(body) ? body.properties : undefined;
  if (!isObject(properties)) {
    throw badRequest("'properties' is required and must be an object");
  }

  const currency = requireString(
    properties,
    'currency',
    'properties.currency'
  ).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw badRequest(
      "'properties.currency' must be a 3-letter ISO 4217 code, e.g. BRL"
    );
  }

  const cart = properties.cart;
  if (!isObject(cart)) {
    throw badRequest("'properties.cart' is required and must be an object");
  }
  const value = cart.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest("'properties.cart.value' must be a number >= 0");
  }
  const rawItems = cart.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw badRequest(
      "'properties.cart.items' must be a non-empty array (send the whole cart)"
    );
  }
  if (rawItems.length > MAX_CART_ITEMS) {
    throw badRequest(
      `'properties.cart.items' must have at most ${MAX_CART_ITEMS} items`
    );
  }

  const items = rawItems.map((raw, i): CartItem => {
    const at = `properties.cart.items[${i}]`;
    if (!isObject(raw)) throw badRequest(`'${at}' must be an object`);
    const id = requireString(raw, 'id', `${at}.id`);
    const quantity = raw.quantity;
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      throw badRequest(`'${at}.quantity' must be an integer >= 1`);
    }
    const unitPrice = raw.unit_price;
    if (
      typeof unitPrice !== 'number' ||
      !Number.isFinite(unitPrice) ||
      unitPrice < 0
    ) {
      throw badRequest(`'${at}.unit_price' must be a number >= 0`);
    }
    const name =
      typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : null;
    return { id, name, quantity, unit_price: unitPrice };
  });

  return { currency, cart: { value, items } };
}

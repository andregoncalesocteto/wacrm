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

/** `customer` of an event (direct events, contract addendum v2). */
export interface EventCustomer {
  /** E.164 with the `+`. Absent only when the event carries an `idtrack`. */
  phone: string | null;
  name: string | null;
}

/**
 * `consent` of an event. Only its FORMAT is validated here; ticket #20 stores
 * it. A purpose left out is `undefined` (never a revocation).
 */
export interface EventConsent {
  notifications?: boolean;
  marketing?: boolean;
  givenAt?: Date;
}

export interface CommonEventFields {
  eventId: string;
  name: string;
  /** Null for a direct event (identified by `storeKey` + `customer.phone`). */
  idtrack: string | null;
  storeKey: string | null;
  customer: EventCustomer | null;
  consent: EventConsent | null;
  occurredAt: Date;
}

const MAX_EVENT_ID_LENGTH = 200;
const MAX_CART_ITEMS = 200;
const MAX_STORE_KEY_LENGTH = 200;
const MAX_CUSTOMER_NAME_LENGTH = 200;
/** E.164 with the mandatory `+` (the menu normalises before sending). */
const E164 = /^\+[1-9]\d{6,14}$/;
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
  const idtrack = optionalString(body, 'idtrack');
  const storeKey = optionalString(body, 'store_key');
  if (storeKey && storeKey.length > MAX_STORE_KEY_LENGTH) {
    throw badRequest(
      `'store_key' must have at most ${MAX_STORE_KEY_LENGTH} characters`
    );
  }
  const customer = parseCustomer(body.customer);
  const consent = parseConsent(body.consent);

  if (!idtrack && !(storeKey && customer?.phone)) {
    throw badRequest(
      "The event must carry 'idtrack', or 'store_key' together with 'customer.phone'"
    );
  }

  const rawAt = requireString(body, 'occurred_at');
  const occurredAt = new Date(rawAt);
  if (!ISO_UTC.test(rawAt) || Number.isNaN(occurredAt.getTime())) {
    throw badRequest(
      "'occurred_at' must be an ISO 8601 UTC timestamp, e.g. 2026-10-02T21:14:05Z"
    );
  }
  return {
    eventId,
    name,
    idtrack,
    storeKey,
    customer,
    consent,
    occurredAt,
  };
}

/** A string field that may be absent/null; present means non-empty. */
function optionalString(
  body: Record<string, unknown>,
  field: string,
  path = field
): string | null {
  const v = body[field];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.trim() === '') {
    throw badRequest(`'${path}' must be a non-empty string when present`);
  }
  return v.trim();
}

function parseCustomer(raw: unknown): EventCustomer | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw badRequest("'customer' must be an object");
  const phone = optionalString(raw, 'phone', 'customer.phone');
  if (phone !== null && !E164.test(phone)) {
    throw badRequest(
      "'customer.phone' must be in international E.164 format with a leading '+', e.g. +5511999998888"
    );
  }
  const name = optionalString(raw, 'name', 'customer.name');
  if (name && name.length > MAX_CUSTOMER_NAME_LENGTH) {
    throw badRequest(
      `'customer.name' must have at most ${MAX_CUSTOMER_NAME_LENGTH} characters`
    );
  }
  return { phone, name };
}

function parseConsent(raw: unknown): EventConsent | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw badRequest("'consent' must be an object");
  const consent: EventConsent = {};
  for (const purpose of ['notifications', 'marketing'] as const) {
    const v = raw[purpose];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') {
      throw badRequest(`'consent.${purpose}' must be a boolean`);
    }
    consent[purpose] = v;
  }
  const given = raw.given_at;
  if (given !== undefined && given !== null) {
    const at = typeof given === 'string' ? new Date(given) : null;
    if (
      typeof given !== 'string' ||
      !ISO_UTC.test(given) ||
      !at ||
      Number.isNaN(at.getTime())
    ) {
      throw badRequest(
        "'consent.given_at' must be an ISO 8601 UTC timestamp, e.g. 2026-10-02T21:10:00Z"
      );
    }
    consent.givenAt = at;
  }
  return consent;
}

function parseItems(raw: unknown, path: string, hint = ''): CartItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw badRequest(`'${path}' must be a non-empty array${hint}`);
  }
  if (raw.length > MAX_CART_ITEMS) {
    throw badRequest(`'${path}' must have at most ${MAX_CART_ITEMS} items`);
  }

  return raw.map((entry, i): CartItem => {
    const at = `${path}[${i}]`;
    if (!isObject(entry)) throw badRequest(`'${at}' must be an object`);
    const id = requireString(entry, 'id', `${at}.id`);
    const quantity = entry.quantity;
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      throw badRequest(`'${at}.quantity' must be an integer >= 1`);
    }
    const unitPrice = entry.unit_price;
    if (
      typeof unitPrice !== 'number' ||
      !Number.isFinite(unitPrice) ||
      unitPrice < 0
    ) {
      throw badRequest(`'${at}.unit_price' must be a number >= 0`);
    }
    const name =
      typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : null;
    return { id, name, quantity, unit_price: unitPrice };
  });
}

function parseCurrency(properties: Record<string, unknown>): string {
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
  return currency;
}

/** `properties` of Purchase: the order as the Digital menu placed it. */
export interface PurchaseProperties {
  orderId: string;
  currency: string;
  value: number;
  items: CartItem[];
}

const MAX_ORDER_ID_LENGTH = 200;

/** Validate `properties` of Purchase. */
export function parsePurchaseProperties(body: unknown): PurchaseProperties {
  const properties = isObject(body) ? body.properties : undefined;
  if (!isObject(properties)) {
    throw badRequest("'properties' is required and must be an object");
  }
  const orderId = requireString(properties, 'order_id', 'properties.order_id');
  if (orderId.length > MAX_ORDER_ID_LENGTH) {
    throw badRequest(
      `'properties.order_id' must have at most ${MAX_ORDER_ID_LENGTH} characters`
    );
  }
  const currency = parseCurrency(properties);
  const value = properties.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest("'properties.value' must be a number >= 0");
  }
  const items = parseItems(properties.items, 'properties.items');
  return { orderId, currency, value, items };
}

/**
 * The closed set of `OrderStatusChanged.properties.status` (contract §5).
 * `placed` is not one of them: it is the Purchase itself.
 */
export const ORDER_EVENT_STATUSES = [
  'received',
  'preparing',
  'finished',
  'out_for_delivery',
  'ready_for_pickup',
  'delivered',
  'cancelled',
] as const;
export type OrderEventStatus = (typeof ORDER_EVENT_STATUSES)[number];

/** `properties` of OrderStatusChanged. */
export interface OrderStatusProperties {
  orderId: string;
  status: OrderEventStatus;
}

/** Validate `properties` of OrderStatusChanged. */
export function parseOrderStatusProperties(
  body: unknown
): OrderStatusProperties {
  const properties = isObject(body) ? body.properties : undefined;
  if (!isObject(properties)) {
    throw badRequest("'properties' is required and must be an object");
  }
  const orderId = requireString(properties, 'order_id', 'properties.order_id');
  if (orderId.length > MAX_ORDER_ID_LENGTH) {
    throw badRequest(
      `'properties.order_id' must have at most ${MAX_ORDER_ID_LENGTH} characters`
    );
  }
  const status = requireString(properties, 'status', 'properties.status');
  if (!(ORDER_EVENT_STATUSES as readonly string[]).includes(status)) {
    throw badRequest(
      `'properties.status' must be one of: ${ORDER_EVENT_STATUSES.join(', ')}`
    );
  }
  return { orderId, status: status as OrderEventStatus };
}

/** Validate `properties` of AddToCart / InitiateCheckout. */
export function parseCartProperties(body: unknown): CartProperties {
  const properties = isObject(body) ? body.properties : undefined;
  if (!isObject(properties)) {
    throw badRequest("'properties' is required and must be an object");
  }

  const currency = parseCurrency(properties);

  const cart = properties.cart;
  if (!isObject(cart)) {
    throw badRequest("'properties.cart' is required and must be an object");
  }
  const value = cart.value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw badRequest("'properties.cart.value' must be a number >= 0");
  }
  const items = parseItems(
    cart.items,
    'properties.cart.items',
    ' (send the whole cart)'
  );

  return { currency, cart: { value, items } };
}

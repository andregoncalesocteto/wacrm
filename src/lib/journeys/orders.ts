import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import type { PurchaseProperties } from './event-payload';
import type { JourneyRow } from './journeys';

/**
 * Orders (ticket #6): the `Purchase` journey event creates one Order per
 * `order_id` of the Digital menu. Every query is filtered by `accountId`
 * (service-role client: RLS is off).
 *
 * `orders.status` holds the whole vocabulary of `OrderStatusChanged` (ticket
 * #7). A new Order is `placed`: the Purchase itself, before any status arrives.
 */
export const ORDER_STATUSES = [
  'placed',
  'received',
  'preparing',
  'finished',
  'out_for_delivery',
  'ready_for_pickup',
  'delivered',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface OrderRow {
  id: string;
  account_id: string;
  external_order_id: string;
  contact_id: string;
  conversation_id: string | null;
  connection_id: string | null;
  journey_id: string | null;
  deal_id: string | null;
  idtrack: string;
  status: OrderStatus;
  value: number;
  currency: string;
  items: unknown;
  placed_at: string;
  [column: string]: unknown;
}

export async function findOrderByExternalId(
  db: SupabaseClient,
  accountId: string,
  externalOrderId: string
): Promise<OrderRow | null> {
  const { data, error } = await db
    .from('orders')
    .select('*')
    .eq('account_id', accountId)
    .eq('external_order_id', externalOrderId)
    .maybeSingle();
  if (error) throw new Error(`order lookup failed: ${error.message}`);
  return (data as OrderRow | null) ?? null;
}

/**
 * The Journey this `order_id` already closed as won, or null. A Purchase for
 * such an order is a duplicate: nothing else may happen. An order whose
 * Journey is still open is a Purchase that failed half-way; it is NOT a
 * duplicate, the retry finishes it (see `recordPurchase`).
 */
export async function findCompletedPurchase(
  db: SupabaseClient,
  accountId: string,
  externalOrderId: string
): Promise<{ journeyId: string } | null> {
  const order = await findOrderByExternalId(db, accountId, externalOrderId);
  if (!order?.journey_id) return null;
  const { data, error } = await db
    .from('journeys')
    .select('state')
    .eq('account_id', accountId)
    .eq('id', order.journey_id)
    .maybeSingle();
  if (error) throw new Error(`journey lookup failed: ${error.message}`);
  return (data as { state?: string } | null)?.state === 'won'
    ? { journeyId: order.journey_id }
    : null;
}

/**
 * Create the Order of `journey` and everything hanging from it, except closing
 * the Journey (the caller does that last, so a failure leaves it open and the
 * retry, which finds the same Order, completes the job):
 *   - the Order (unique per account + `order_id`);
 *   - the deal's value / currency follow the order;
 *   - `contacts.last_purchase_at` (never moves backwards).
 * Returns `duplicate: true` when the `order_id` belongs to another Journey (a
 * concurrent Purchase won the race): the caller must then do nothing more.
 */
export async function recordPurchase(
  db: SupabaseClient,
  args: {
    accountId: string;
    journey: JourneyRow;
    idtrack: string;
    occurredAt: Date;
    purchase: PurchaseProperties;
  }
): Promise<{ duplicate: boolean }> {
  const { accountId, journey, purchase } = args;

  const { error } = await db.from('orders').insert({
    account_id: accountId,
    external_order_id: purchase.orderId,
    contact_id: journey.contact_id,
    conversation_id: journey.conversation_id,
    connection_id: journey.connection_id,
    journey_id: journey.id,
    deal_id: journey.deal_id,
    idtrack: args.idtrack,
    status: 'placed',
    value: purchase.value,
    currency: purchase.currency,
    items: purchase.items,
    placed_at: args.occurredAt.toISOString(),
  });
  if (error) {
    if (!isUniqueViolation(error)) {
      throw new Error(`order creation failed: ${error.message}`);
    }
    const existing = await findOrderByExternalId(
      db,
      accountId,
      purchase.orderId
    );
    if (existing?.journey_id !== journey.id) return { duplicate: true };
    // Same Journey: a previous attempt died before closing it. Carry on.
  }

  if (journey.deal_id) {
    const { error: dealErr } = await db
      .from('deals')
      .update({ value: purchase.value, currency: purchase.currency })
      .eq('id', journey.deal_id)
      .eq('account_id', accountId);
    if (dealErr)
      throw new Error(`order deal update failed: ${dealErr.message}`);
  }

  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('last_purchase_at')
    .eq('account_id', accountId)
    .eq('id', journey.contact_id)
    .maybeSingle();
  if (contactErr) {
    throw new Error(`contact lookup failed: ${contactErr.message}`);
  }
  const previous = (contact as { last_purchase_at?: string | null } | null)
    ?.last_purchase_at;
  if (!previous || new Date(previous).getTime() < args.occurredAt.getTime()) {
    const { error: upErr } = await db
      .from('contacts')
      .update({ last_purchase_at: args.occurredAt.toISOString() })
      .eq('id', journey.contact_id)
      .eq('account_id', accountId);
    if (upErr) throw new Error(`last purchase update failed: ${upErr.message}`);
  }
  return { duplicate: false };
}

/**
 * The single check every scheduled Journey message (resumptions, abandoned
 * cart: tickets #9/#10) MUST make right before sending: a Journey that is no
 * longer `open` (won, lost) sends nothing. Checking at fire time, not at
 * schedule time, is what makes closing the Journey cancel them all.
 */
export async function isJourneyOpen(
  db: SupabaseClient,
  args: { accountId: string; journeyId: string }
): Promise<boolean> {
  const { data, error } = await db
    .from('journeys')
    .select('state')
    .eq('account_id', args.accountId)
    .eq('id', args.journeyId)
    .maybeSingle();
  if (error) throw new Error(`journey lookup failed: ${error.message}`);
  return (data as { state?: string } | null)?.state === 'open';
}

/**
 * Cancel whatever is still scheduled for a Journey that has just closed.
 * Today nothing is scheduled per Journey (resumptions arrive with #9/#10, and
 * they check `isJourneyOpen` when they fire), so this has nothing to delete
 * and returns 0. It is the one place where a persisted schedule of those
 * tickets must be removed, so closing a Journey stays a single call site.
 */
export async function cancelPendingForJourney(
  _db: SupabaseClient,
  _args: { accountId: string; journeyId: string }
): Promise<number> {
  return 0;
}

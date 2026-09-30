import type { SupabaseClient } from '@supabase/supabase-js';
import { JOURNEY_STAGES } from './constants';
import { findOpenJourney, type JourneyRow } from './journeys';
import type { OrderStatus } from './orders';

/** What a human picking up a conversation needs to know about the Journey. */
export interface JourneyHandoffState {
  /** Name of the deal's pipeline stage (falls back to the default stage name). */
  stageName: string;
  state: 'open' | 'won' | 'lost';
  cart: { itemsCount: number; value: number; currency: string } | null;
  order: {
    externalOrderId: string;
    status: OrderStatus;
    /** When the order reached its current status. */
    since: string;
  } | null;
  /** Name of the latest behaviour event of the Journey (e.g. `AddToCart`). */
  lastEventName: string | null;
}

interface StateArgs {
  accountId: string;
  contactId: string;
  conversationId: string;
}

/**
 * Read-only snapshot of the contact's Journey on the conversation's
 * connection: the open Journey if there is one, otherwise the most recent.
 * Null when the contact has no Journey there. Every query is filtered by
 * `accountId`. Throws on a read error: callers that must not fail (the AI
 * handoff) catch and fall back.
 */
export async function loadJourneyHandoffState(
  db: SupabaseClient,
  args: StateArgs
): Promise<JourneyHandoffState | null> {
  const { accountId, contactId, conversationId } = args;

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('connection_id')
    .eq('account_id', accountId)
    .eq('id', conversationId)
    .maybeSingle();
  if (convErr)
    throw new Error(`conversation lookup failed: ${convErr.message}`);
  const connectionId = (conv as { connection_id?: string | null } | null)
    ?.connection_id;
  if (!connectionId) return null;

  let journey: JourneyRow | null = await findOpenJourney(db, {
    accountId,
    contactId,
    connectionId,
  });
  if (!journey) {
    const { data, error } = await db
      .from('journeys')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .eq('connection_id', connectionId)
      .order('link_sent_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`journey lookup failed: ${error.message}`);
    journey = (data as JourneyRow | null) ?? null;
  }
  if (!journey) return null;

  const [stageName, order, lastEventName] = await Promise.all([
    readStageName(db, accountId, journey),
    readOrder(db, accountId, contactId, connectionId, journey.id),
    readLastEventName(db, accountId, journey.id),
  ]);

  const items = Number(journey.cart_items_count) || 0;
  return {
    stageName,
    state: journey.state,
    cart:
      journey.state === 'open' && items > 0
        ? {
            itemsCount: items,
            value: Number(journey.cart_value) || 0,
            currency: String(journey.cart_currency ?? ''),
          }
        : null,
    order,
    lastEventName,
  };
}

async function readStageName(
  db: SupabaseClient,
  accountId: string,
  journey: JourneyRow
): Promise<string> {
  const fallback =
    JOURNEY_STAGES.find((s) => s.key === journey.stage)?.name ?? journey.stage;
  if (!journey.deal_id) return fallback;
  const { data: deal } = await db
    .from('deals')
    .select('stage_id')
    .eq('account_id', accountId)
    .eq('id', journey.deal_id)
    .maybeSingle();
  const stageId = (deal as { stage_id?: string } | null)?.stage_id;
  if (!stageId) return fallback;
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('name')
    .eq('id', stageId)
    .maybeSingle();
  return (stage as { name?: string } | null)?.name?.trim() || fallback;
}

/** The Journey's most recent order, else the contact's latest on this connection. */
async function readOrder(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  connectionId: string,
  journeyId: string
): Promise<JourneyHandoffState['order']> {
  const latest = async (scope: Record<string, string>) => {
    let q = db.from('orders').select('*').eq('account_id', accountId);
    for (const [col, v] of Object.entries(scope)) q = q.eq(col, v);
    const { data, error } = await q
      .order('placed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`order lookup failed: ${error.message}`);
    return data as {
      external_order_id: string;
      status: OrderStatus;
      status_changed_at: string | null;
      placed_at: string;
    } | null;
  };
  const row =
    (await latest({ journey_id: journeyId })) ??
    (await latest({ contact_id: contactId, connection_id: connectionId }));
  if (!row) return null;
  return {
    externalOrderId: row.external_order_id,
    status: row.status,
    since: row.status_changed_at ?? row.placed_at,
  };
}

async function readLastEventName(
  db: SupabaseClient,
  accountId: string,
  journeyId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('journey_events')
    .select('name')
    .eq('account_id', accountId)
    .eq('journey_id', journeyId)
    .order('occurred_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(`journey event lookup failed: ${error.message}`);
  // Order status changes are reported through the order line, not as an event.
  const rows = (data as { name: string }[] | null) ?? [];
  return rows.find((r) => r.name !== 'OrderStatusChanged')?.name ?? null;
}

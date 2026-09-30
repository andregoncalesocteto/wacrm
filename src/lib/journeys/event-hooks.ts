import type { SupabaseClient } from '@supabase/supabase-js';
import type { JourneyStage } from './constants';
import type { AutomationOrderContext } from '@/lib/automations/order-vars';
import type { OrderStatusChange } from './orders';

/** What a journey-event trigger needs to know about an accepted event. */
export interface AcceptedJourneyEvent {
  accountId: string;
  eventId: string;
  name: string;
  occurredAt: Date;
  journeyId: string;
  contactId: string;
  /** Null for a direct event whose customer has no conversation yet: the
   *  automation step creates it (after the consent check). */
  conversationId: string | null;
  connectionId: string | null;
  /** Store of a direct event; lets a send step create the missing conversation. */
  storeId?: string | null;
  /** Journey stage after the event (never behind where it was before). */
  stage: JourneyStage;
  /** Validated event properties (cart, order...), when the caller has them. */
  properties?: Record<string, unknown>;
}

/**
 * THE extension point for "an event was accepted". Called once per event, after
 * its effects are committed and only for the first delivery of an `event_id`
 * (replays never reach it). It fires the automations whose trigger is
 * `journey_event` and lists this event's name; every accepted event goes
 * through here, Purchase included.
 *
 * It must not throw into the request: the caller also logs and swallows
 * failures, and the automation engine never throws on its own, so a broken
 * automation never turns an accepted event into an error the menu would retry.
 */
export async function onJourneyEventAccepted(
  _db: SupabaseClient,
  event: AcceptedJourneyEvent
): Promise<void> {
  // A Purchase carries the order: expose it to `{{order_id}}` and friends so the
  // thank-you message can mention it. Other events have no order.
  const p = event.properties as
    | {
        orderId?: unknown;
        value?: unknown;
        currency?: unknown;
        items?: unknown;
      }
    | undefined;
  const order: AutomationOrderContext | undefined =
    event.name === 'Purchase' && typeof p?.orderId === 'string'
      ? {
          external_id: p.orderId,
          status: 'placed',
          value: typeof p.value === 'number' ? p.value : null,
          currency: typeof p.currency === 'string' ? p.currency : null,
          items: Array.isArray(p.items) ? p.items : [],
        }
      : undefined;
  // Loaded lazily: the engine imports this module's package (`@/lib/journeys`).
  const { runAutomationsForTrigger } = await import('@/lib/automations/engine');
  await runAutomationsForTrigger({
    accountId: event.accountId,
    triggerType: 'journey_event',
    contactId: event.contactId,
    context: {
      ...(event.conversationId ? { conversation_id: event.conversationId } : {}),
      ...(event.connectionId ? { connection_id: event.connectionId } : {}),
      ...(event.storeId ? { store_id: event.storeId } : {}),
      journey_id: event.journeyId,
      journey_event_id: event.eventId,
      journey_event_name: event.name,
      journey_event_properties: event.properties ?? {},
      journey_stage: event.stage,
      ...(order ? { order } : {}),
    },
  });
}

/**
 * THE extension point for "an order changed status" (ticket #8). Called once,
 * after the change is committed, ONLY when the status really changed: a late or
 * repeated status that was ignored, and a replayed `event_id`, never reach it.
 * It is not `onJourneyEventAccepted`: `OrderStatusChanged` opens no Journey and
 * does not go through that hook.
 *
 * It fires the automations whose trigger is `order_status_changed` and lists
 * the new status (ticket #11), on the conversation/connection of the order.
 * The engine only looks at the order's account, and no automation is configured
 * for a status means nothing is sent.
 *
 * Like the other hook it must not throw into the request; the caller also logs
 * and swallows failures.
 */
export async function onOrderStatusChanged(
  db: SupabaseClient,
  change: OrderStatusChange,
  /** Store of a direct event: lets a send step create a missing conversation. */
  storeId?: string | null
): Promise<void> {
  // Value and items are not in the change: read them from the order (account-scoped).
  const { data, error } = await db
    .from('orders')
    .select('value, currency, items')
    .eq('id', change.orderId)
    .eq('account_id', change.accountId)
    .maybeSingle();
  if (error) {
    console.error('[journeys] order read for status trigger failed:', error);
  }
  const row = data as {
    value: number | null;
    currency: string | null;
    items: AutomationOrderContext['items'];
  } | null;

  // Loaded lazily: the engine imports this module's package (`@/lib/journeys`).
  const { runAutomationsForTrigger } = await import('@/lib/automations/engine');
  await runAutomationsForTrigger({
    accountId: change.accountId,
    triggerType: 'order_status_changed',
    contactId: change.contactId,
    context: {
      ...(change.conversationId
        ? { conversation_id: change.conversationId }
        : {}),
      ...(change.connectionId ? { connection_id: change.connectionId } : {}),
      ...(change.journeyId ? { journey_id: change.journeyId } : {}),
      ...(storeId ? { store_id: storeId } : {}),
      order: {
        external_id: change.externalOrderId,
        status: change.status,
        previous_status: change.previousStatus,
        value: row?.value ?? null,
        currency: row?.currency ?? null,
        items: Array.isArray(row?.items) ? row.items : [],
      },
    },
  });
}

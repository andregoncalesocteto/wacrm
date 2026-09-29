import type { SupabaseClient } from '@supabase/supabase-js';
import type { JourneyStage } from './constants';
import type { OrderStatusChange } from './orders';

/** What a journey-event trigger needs to know about an accepted event. */
export interface AcceptedJourneyEvent {
  accountId: string;
  eventId: string;
  name: string;
  occurredAt: Date;
  journeyId: string;
  contactId: string;
  conversationId: string;
  connectionId: string;
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
  // Loaded lazily: the engine imports this module's package (`@/lib/journeys`).
  const { runAutomationsForTrigger } = await import('@/lib/automations/engine');
  await runAutomationsForTrigger({
    accountId: event.accountId,
    triggerType: 'journey_event',
    contactId: event.contactId,
    context: {
      conversation_id: event.conversationId,
      connection_id: event.connectionId,
      journey_id: event.journeyId,
      journey_event_id: event.eventId,
      journey_event_name: event.name,
      journey_event_properties: event.properties ?? {},
      journey_stage: event.stage,
    },
  });
}

/**
 * THE extension point for "an order changed status" (ticket #8; ticket #11
 * fires the "order status change" trigger from here). Called once, after the
 * change is committed, ONLY when the status really changed: a late or repeated
 * status that was ignored, and a replayed `event_id`, never reach it. It is not
 * `onJourneyEventAccepted`: `OrderStatusChanged` opens no Journey and does not
 * go through that hook.
 *
 * Today a no-op. Like the other hook it must not throw into the request; the
 * caller also logs and swallows failures.
 */
export async function onOrderStatusChanged(
  _db: SupabaseClient,
  _change: OrderStatusChange
): Promise<void> {}

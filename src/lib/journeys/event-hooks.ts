import type { SupabaseClient } from '@supabase/supabase-js';
import type { JourneyStage } from './constants';

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
}

/**
 * THE extension point for "an event was accepted". Called once per event, after
 * its effects are committed and only for the first delivery of an `event_id`
 * (replays never reach it). Ticket #7 fills it in to fire automations whose
 * trigger is a journey event; until then it does nothing.
 *
 * It must not throw into the request: the caller logs and swallows failures, so
 * a broken automation never turns an accepted event into an error the menu
 * would retry.
 */
export async function onJourneyEventAccepted(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _db: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _event: AcceptedJourneyEvent
): Promise<void> {}

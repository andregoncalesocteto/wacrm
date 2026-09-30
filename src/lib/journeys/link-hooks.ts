import type { SupabaseClient } from '@supabase/supabase-js';
import type { JourneyRow } from './journeys';

/**
 * Extension point for "a menu link was sent": fires the automations whose
 * trigger is `menu_link_sent`. `recordMenuLinkSent` calls it, and both senders
 * of the link (the `{{menu_link}}` automation step and the AI reply) go
 * through that, so one trigger covers both. Fired on every send, first link or
 * renewal (the automation supersedes its parked runs of the previous link).
 *
 * Never throws: a broken automation must not fail a message already sent.
 */
export async function onMenuLinkSent(
  _db: SupabaseClient,
  args: {
    accountId: string;
    contactId: string;
    conversationId: string;
    connectionId: string;
    journey: JourneyRow;
  }
): Promise<void> {
  // The Resumptions hang on the link; a direct Journey has none and is never
  // part of them (the abandoned cart is its only recovery).
  if (args.journey.origin === 'menu_direct') return;
  try {
    // Loaded lazily: the engine imports this module's package (`@/lib/journeys`).
    const { runAutomationsForTrigger } =
      await import('@/lib/automations/engine');
    await runAutomationsForTrigger({
      accountId: args.accountId,
      triggerType: 'menu_link_sent',
      contactId: args.contactId,
      context: {
        conversation_id: args.conversationId,
        connection_id: args.connectionId,
        journey_id: args.journey.id,
        journey_stage: args.journey.stage,
        menu_link_sent_at: args.journey.link_sent_at ?? undefined,
      },
    });
  } catch (err) {
    console.error('[journeys] menu_link_sent dispatch failed:', err);
  }
}

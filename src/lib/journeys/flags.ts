import type { SupabaseClient } from '@supabase/supabase-js';
import type { JourneyRow } from './journeys';

/**
 * One-shot marks on a Journey ("this message already went out"). The value is
 * the `journeys` column that holds the instant; the key is what automations
 * store in a `journey_flag` condition / a `send_message` step.
 */
export const JOURNEY_FLAGS = {
  abandoned_cart_sent: 'abandoned_cart_sent_at',
} as const;

export type JourneyFlag = keyof typeof JOURNEY_FLAGS;

export function isJourneyFlag(value: unknown): value is JourneyFlag {
  return typeof value === 'string' && Object.hasOwn(JOURNEY_FLAGS, value);
}

export function isJourneyFlagSet(
  journey: JourneyRow | null,
  flag: JourneyFlag
): boolean {
  return !!journey && journey[JOURNEY_FLAGS[flag]] != null;
}

/**
 * Atomically mark the flag on the Journey. True only for the caller that
 * flipped it from unset to set, so two concurrent runs cannot both send.
 */
export async function claimJourneyFlag(
  db: SupabaseClient,
  args: { accountId: string; journeyId: string; flag: JourneyFlag; at?: Date }
): Promise<boolean> {
  const column = JOURNEY_FLAGS[args.flag];
  const { data, error } = await db
    .from('journeys')
    .update({ [column]: (args.at ?? new Date()).toISOString() })
    .eq('id', args.journeyId)
    .eq('account_id', args.accountId)
    .is(column, null)
    .select('id');
  if (error) throw new Error(`claim ${args.flag} failed: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Undo a claim whose send failed, so a later trigger may try again. */
export async function releaseJourneyFlag(
  db: SupabaseClient,
  args: { accountId: string; journeyId: string; flag: JourneyFlag }
): Promise<void> {
  const { error } = await db
    .from('journeys')
    .update({ [JOURNEY_FLAGS[args.flag]]: null })
    .eq('id', args.journeyId)
    .eq('account_id', args.accountId);
  if (error) console.error('[journeys] release flag failed:', error);
}

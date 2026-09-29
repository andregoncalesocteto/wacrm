import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { JOURNEY_STAGES, type JourneyStage } from './constants';
import { ensureJourneyPipeline } from './pipeline';

export interface JourneyRow {
  id: string;
  account_id: string;
  contact_id: string;
  conversation_id: string | null;
  connection_id: string;
  deal_id: string | null;
  state: 'open' | 'won' | 'lost';
  stage: JourneyStage;
  link_sent_at: string;
  link_count: number;
  [column: string]: unknown;
}

export interface OpenJourneyArgs {
  accountId: string;
  /** Audit `user_id` for the deal (the automation author). */
  userId: string;
  contactId: string;
  conversationId: string;
  connectionId: string;
  /** Instant the menu link was sent: anchor of the resumption clocks. */
  linkSentAt?: Date;
}

const STAGE_RANK = new Map(JOURNEY_STAGES.map((s, i) => [s.key, i]));

/**
 * Register a menu link sent: open the contact's Journey on this connection
 * (or reuse the open one) with its deal at "Link enviado", and stamp
 * `link_sent_at` (latest link; `link_count` counts them).
 *
 * - Open Journey exists for contact + connection: reused (a resend never opens
 *   another); its clock is re-anchored and its deal recreated if missing.
 * - Otherwise a Journey and its deal are created, the pipeline first if the
 *   account has none yet. The DB forbids two open Journeys per contact +
 *   connection and two open deals per Journey; a concurrent loser re-reads.
 */
export async function openOrRenewJourney(
  db: SupabaseClient,
  args: OpenJourneyArgs
): Promise<JourneyRow> {
  const at = (args.linkSentAt ?? new Date()).toISOString();

  let journey = await findOpenJourney(db, args);
  if (journey) {
    const { error } = await db
      .from('journeys')
      .update({
        link_sent_at: at,
        link_count: (journey.link_count ?? 1) + 1,
        conversation_id: args.conversationId,
      })
      .eq('id', journey.id)
      .eq('account_id', args.accountId);
    if (error) throw new Error(`journey renewal failed: ${error.message}`);
    journey = {
      ...journey,
      link_sent_at: at,
      link_count: (journey.link_count ?? 1) + 1,
      conversation_id: args.conversationId,
    };
  } else {
    const { data, error } = await db
      .from('journeys')
      .insert({
        account_id: args.accountId,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        connection_id: args.connectionId,
        state: 'open',
        stage: 'link_sent',
        link_sent_at: at,
        link_count: 1,
      })
      .select('*')
      .single();
    if (error && !isUniqueViolation(error)) {
      throw new Error(`journey creation failed: ${error.message}`);
    }
    journey = (data as JourneyRow | null) ?? (await findOpenJourney(db, args));
    if (!journey) throw new Error('journey could not be opened');
  }

  if (!journey.deal_id) {
    const dealId = await ensureJourneyDeal(db, args, journey);
    journey = { ...journey, deal_id: dealId };
  }
  return journey;
}

export async function findOpenJourney(
  db: SupabaseClient,
  args: Pick<OpenJourneyArgs, 'accountId' | 'contactId' | 'connectionId'>
): Promise<JourneyRow | null> {
  const { data, error } = await db
    .from('journeys')
    .select('*')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('connection_id', args.connectionId)
    .eq('state', 'open')
    .maybeSingle();
  if (error) throw new Error(`journey lookup failed: ${error.message}`);
  return (data as JourneyRow | null) ?? null;
}

/** The Journey's single open deal, created at "Link enviado" when absent. */
async function ensureJourneyDeal(
  db: SupabaseClient,
  args: OpenJourneyArgs,
  journey: JourneyRow
): Promise<string> {
  const findDeal = async () => {
    const { data } = await db
      .from('deals')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('journey_id', journey.id)
      .eq('status', 'open')
      .maybeSingle();
    return (data as { id: string } | null)?.id ?? null;
  };

  let dealId = await findDeal();
  if (!dealId) {
    const { pipelineId, stageIds } = await ensureJourneyPipeline(db, args);
    const [{ data: account }, { data: contact }] = await Promise.all([
      db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.accountId)
        .maybeSingle(),
      db
        .from('contacts')
        .select('name, phone')
        .eq('account_id', args.accountId)
        .eq('id', args.contactId)
        .maybeSingle(),
    ]);
    const who =
      (contact as { name?: string; phone?: string } | null)?.name?.trim() ||
      (contact as { phone?: string } | null)?.phone?.trim() ||
      '';
    const { data, error } = await db
      .from('deals')
      .insert({
        account_id: args.accountId,
        user_id: args.userId,
        pipeline_id: pipelineId,
        stage_id: stageIds.link_sent,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        connection_id: args.connectionId,
        journey_id: journey.id,
        title: who ? `Jornada de pedido - ${who}` : 'Jornada de pedido',
        value: 0,
        currency:
          (account as { default_currency?: string } | null)?.default_currency ??
          'USD',
        status: 'open',
      })
      .select('id')
      .single();
    if (error && !isUniqueViolation(error)) {
      throw new Error(`journey deal creation failed: ${error.message}`);
    }
    dealId = (data as { id: string } | null)?.id ?? (await findDeal());
    if (!dealId) throw new Error('journey deal could not be created');
  }

  const { error } = await db
    .from('journeys')
    .update({ deal_id: dealId })
    .eq('id', journey.id)
    .eq('account_id', args.accountId);
  if (error) throw new Error(`journey deal link failed: ${error.message}`);
  return dealId;
}

/**
 * Move a Journey (and its deal) forward to `stage`. The funnel never recedes:
 * a target at or behind the current stage is a no-op. `won` / `lost` are the
 * terminal stages; they also set the Journey state and close it.
 * Returns whether anything changed.
 */
export async function advanceJourneyStage(
  db: SupabaseClient,
  args: {
    accountId: string;
    userId: string;
    journeyId: string;
    stage: JourneyStage;
    at?: Date;
  }
): Promise<boolean> {
  const { data, error } = await db
    .from('journeys')
    .select('*')
    .eq('account_id', args.accountId)
    .eq('id', args.journeyId)
    .maybeSingle();
  if (error) throw new Error(`journey lookup failed: ${error.message}`);
  const journey = data as JourneyRow | null;
  if (!journey) throw new Error('journey not found');
  if (journey.state !== 'open') return false;
  if (
    (STAGE_RANK.get(args.stage) ?? -1) <= (STAGE_RANK.get(journey.stage) ?? -1)
  ) {
    return false;
  }

  const at = (args.at ?? new Date()).toISOString();
  const terminal = args.stage === 'won' || args.stage === 'lost';
  const { error: upErr } = await db
    .from('journeys')
    .update({
      stage: args.stage,
      last_event_at: at,
      ...(terminal ? { state: args.stage, closed_at: at } : {}),
    })
    .eq('id', journey.id)
    .eq('account_id', args.accountId);
  if (upErr) throw new Error(`journey advance failed: ${upErr.message}`);

  if (journey.deal_id) {
    const { stageIds } = await ensureJourneyPipeline(db, args);
    const { error: dealErr } = await db
      .from('deals')
      .update({
        stage_id: stageIds[args.stage],
        ...(terminal ? { status: args.stage } : {}),
      })
      .eq('id', journey.deal_id)
      .eq('account_id', args.accountId);
    if (dealErr)
      throw new Error(`journey deal advance failed: ${dealErr.message}`);
  }
  return true;
}

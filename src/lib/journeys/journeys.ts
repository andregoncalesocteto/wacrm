import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { JOURNEY_STAGES, type JourneyStage } from './constants';
import { ensureJourneyPipeline } from './pipeline';

/** How a Journey started: a link sent by the CRM, or a direct menu event. */
export type JourneyOrigin = 'crm_link' | 'menu_direct';

export interface JourneyRow {
  id: string;
  account_id: string;
  contact_id: string;
  conversation_id: string | null;
  /** Null only for a direct Journey of a store with no WhatsApp connection. */
  connection_id: string | null;
  /** Set on direct Journeys (`origin = 'menu_direct'`); null on the others. */
  store_id: string | null;
  origin: JourneyOrigin;
  deal_id: string | null;
  state: 'open' | 'won' | 'lost';
  stage: JourneyStage;
  /** Null on a direct Journey: no link was ever sent. */
  link_sent_at: string | null;
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

export interface OpenDirectJourneyArgs {
  accountId: string;
  /** Audit `user_id` for the deal. */
  userId: string;
  contactId: string;
  /** The store's notice connection; null when it has none. */
  connectionId: string | null;
  storeId: string;
  /** Existing conversation of the contact on `connectionId`, when there is one. */
  conversationId: string | null;
  /** Stage the first event reaches: the Journey is born already there. */
  stage: Exclude<JourneyStage, 'link_sent' | 'lost' | 'won'>;
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
        // A direct Journey that gets a CRM link is now a Journey WITH a link:
        // resumptions (onMenuLinkSent) and the funnel must treat it as one.
        // Its stage is untouched (never regresses).
        origin: 'crm_link',
      })
      .eq('id', journey.id)
      .eq('account_id', args.accountId);
    if (error) throw new Error(`journey renewal failed: ${error.message}`);
    journey = {
      ...journey,
      link_sent_at: at,
      link_count: (journey.link_count ?? 1) + 1,
      conversation_id: args.conversationId,
      origin: 'crm_link',
    };
  } else {
    const { data, error } = await db
      .from('journeys')
      .insert({
        account_id: args.accountId,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        connection_id: args.connectionId,
        origin: 'crm_link',
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
  args: {
    accountId: string;
    userId: string;
    contactId: string;
    conversationId: string | null;
    connectionId: string | null;
  },
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
        // A direct Journey is born already at the stage its first event
        // reached, never at "Link enviado".
        stage_id: stageIds[journey.stage],
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
  const targetRank = STAGE_RANK.get(args.stage) ?? -1;
  const stagesBefore = JOURNEY_STAGES.filter(
    (s) => (STAGE_RANK.get(s.key) ?? -1) < targetRank
  ).map((s) => s.key);
  // Compare-and-swap on the stage read: conditional on `state = 'open'` AND on
  // the current stage still being BEFORE the target. Of two concurrent closers
  // (Purchase, the abandonment sweep, two cron runs) only one flips the row,
  // and of two concurrent advances (AddToCart, InitiateCheckout) the slower
  // one cannot pull the Journey back. Only the winner goes on to move the
  // deal. `lost` is not engagement, so it leaves `last_event_at` be.
  const { data: moved, error: upErr } = await db
    .from('journeys')
    .update({
      stage: args.stage,
      ...(args.stage === 'lost' ? {} : { last_event_at: at }),
      ...(terminal ? { state: args.stage, closed_at: at } : {}),
    })
    .eq('id', journey.id)
    .eq('account_id', args.accountId)
    .eq('state', 'open')
    .in('stage', stagesBefore)
    .select('id');
  if (upErr) throw new Error(`journey advance failed: ${upErr.message}`);
  if (!moved || moved.length === 0) return false;

  if (journey.deal_id) {
    const { stageIds } = await ensureJourneyPipeline(db, args);
    // Same compare-and-swap for the deal, so a slower concurrent advance
    // cannot leave it behind the Journey. Terminal stages always apply.
    let dealUpdate = db
      .from('deals')
      .update({
        stage_id: stageIds[args.stage],
        ...(terminal ? { status: args.stage } : {}),
      })
      .eq('id', journey.deal_id)
      .eq('account_id', args.accountId);
    if (!terminal) {
      dealUpdate = dealUpdate.in(
        'stage_id',
        stagesBefore.map((k) => stageIds[k])
      );
    }
    const { error: dealErr } = await dealUpdate;
    if (dealErr)
      throw new Error(`journey deal advance failed: ${dealErr.message}`);
  }
  return true;
}

/**
 * The contact's open Journey on this connection, or (connection-less) on this
 * store. Mirrors the two partial unique indexes of migration 064.
 */
export async function findOpenDirectJourney(
  db: SupabaseClient,
  args: Pick<
    OpenDirectJourneyArgs,
    'accountId' | 'contactId' | 'connectionId' | 'storeId'
  >
): Promise<JourneyRow | null> {
  if (args.connectionId) {
    return findOpenJourney(db, {
      accountId: args.accountId,
      contactId: args.contactId,
      connectionId: args.connectionId,
    });
  }
  const { data, error } = await db
    .from('journeys')
    .select('*')
    .eq('account_id', args.accountId)
    .eq('contact_id', args.contactId)
    .eq('store_id', args.storeId)
    .is('connection_id', null)
    .eq('state', 'open')
    .maybeSingle();
  if (error) throw new Error(`journey lookup failed: ${error.message}`);
  return (data as JourneyRow | null) ?? null;
}

/**
 * Open the Journey of a direct event (no menu link): origin `menu_direct`,
 * `link_sent_at` null, born at `args.stage` with its deal there. Reuses the
 * open one when it exists (the DB forbids two per contact + connection, or per
 * contact + store without a connection); a concurrent loser re-reads.
 */
export async function openDirectJourney(
  db: SupabaseClient,
  args: OpenDirectJourneyArgs
): Promise<JourneyRow> {
  let journey = await findOpenDirectJourney(db, args);
  if (!journey) {
    const { data, error } = await db
      .from('journeys')
      .insert({
        account_id: args.accountId,
        contact_id: args.contactId,
        conversation_id: args.conversationId,
        connection_id: args.connectionId,
        store_id: args.storeId,
        origin: 'menu_direct',
        state: 'open',
        stage: args.stage,
        link_sent_at: null,
        link_count: 0,
      })
      .select('*')
      .single();
    if (error && !isUniqueViolation(error)) {
      throw new Error(`journey creation failed: ${error.message}`);
    }
    journey =
      (data as JourneyRow | null) ?? (await findOpenDirectJourney(db, args));
    if (!journey) throw new Error('journey could not be opened');
  }
  if (!journey.deal_id) {
    const dealId = await ensureJourneyDeal(db, args, journey);
    journey = { ...journey, deal_id: dealId };
  }
  return journey;
}

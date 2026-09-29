import type { SupabaseClient } from '@supabase/supabase-js';
import { advanceJourneyStage, type JourneyRow } from './journeys';

/** Quiet time after which an open Journey is considered abandoned. */
export const JOURNEY_LOST_AFTER_MS = 24 * 60 * 60 * 1000;

/** Candidates fetched per page. */
export const JOURNEY_LOST_BATCH = 50;

/**
 * Budget of one sweep: it walks the candidates page by page until it has
 * examined this many, or this much time passed, or there are no more. A
 * Journey that is quiet on the Journey clocks but not eligible (the customer
 * keeps writing, a run is still pending) stays a candidate, so a fixed first
 * page would fill up with them; paging past them is what lets a newer
 * abandoned Journey be reached.
 */
export const JOURNEY_LOST_MAX_EXAMINED = 500;
export const JOURNEY_LOST_MAX_MS = 20_000;

export interface LostSweepResult {
  /** Open Journeys examined. */
  checked: number;
  /** Journeys this run closed as lost. */
  lost: number;
}

/**
 * Close abandoned Journeys as "Perdido" (state `lost`, deal `lost` at the
 * "Perdido" stage). A Journey is eligible when BOTH hold:
 *
 * 1. 24 h passed since its latest engagement: the most recent of
 *    `last_event_at`, `link_sent_at` and the customer's last inbound message
 *    on the conversation. A Journey opened by an event without a link has
 *    `link_sent_at` = the event's time, so that event is the anchor.
 * 2. No automation run tied to this Journey is still waiting (`pending`) or
 *    executing (`running`): Resumptions (30 min) and the abandoned-cart
 *    message (10 min) end long before 24 h, so in practice this is "24 h of
 *    silence and nothing left to send".
 *
 * Safe to run concurrently and repeatedly: the close is a conditional UPDATE
 * on `state = 'open'` (`advanceJourneyStage`), so a Journey is closed, and its
 * deal moved, by exactly one caller. Won Journeys are never open, hence never
 * touched.
 */
export async function closeAbandonedJourneys(
  db: SupabaseClient,
  opts: {
    now?: Date;
    /** Page size. */
    limit?: number;
    maxExamined?: number;
    maxMs?: number;
  } = {}
): Promise<LostSweepResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - JOURNEY_LOST_AFTER_MS).toISOString();
  const pageSize = opts.limit ?? JOURNEY_LOST_BATCH;
  const maxExamined = opts.maxExamined ?? JOURNEY_LOST_MAX_EXAMINED;
  const deadline = Date.now() + (opts.maxMs ?? JOURNEY_LOST_MAX_MS);

  const owners = new Map<string, string | null>();
  const result: LostSweepResult = { checked: 0, lost: 0 };

  // Rows this sweep closed leave the candidate set, so the offset only counts
  // the ones that stayed (ineligible), which are what the next page skips.
  let offset = 0;
  while (result.checked < maxExamined && Date.now() < deadline) {
    // Cheap pre-filter in SQL (both clocks quiet); the message clock and the
    // pending runs are checked per candidate. Oldest first.
    const { data, error } = await db
      .from('journeys')
      .select('*')
      .eq('state', 'open')
      .lt('link_sent_at', cutoff)
      .or(`last_event_at.is.null,last_event_at.lt.${cutoff}`)
      .order('link_sent_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`journey sweep lookup failed: ${error.message}`);
    const page = (data ?? []) as JourneyRow[];
    if (page.length === 0) break;

    const lostBefore = result.lost;
    await examine(db, page, { now, cutoff, owners, result, maxExamined });
    offset += page.length - (result.lost - lostBefore);
    if (page.length < pageSize) break;
  }
  return result;
}

async function examine(
  db: SupabaseClient,
  page: JourneyRow[],
  ctx: {
    now: Date;
    cutoff: string;
    owners: Map<string, string | null>;
    result: LostSweepResult;
    maxExamined: number;
  }
): Promise<void> {
  const { now, cutoff, owners, result } = ctx;
  for (const journey of page) {
    if (result.checked >= ctx.maxExamined) return;
    result.checked++;
    try {
      if (!(await isAbandoned(db, journey, cutoff))) continue;

      let userId = owners.get(journey.account_id);
      if (userId === undefined) {
        userId = await ownerOf(db, journey.account_id);
        owners.set(journey.account_id, userId);
      }
      if (!userId) continue;

      const closed = await advanceJourneyStage(db, {
        accountId: journey.account_id,
        userId,
        journeyId: journey.id,
        stage: 'lost',
        at: now,
      });
      if (closed) result.lost++;
    } catch (err) {
      // One bad Journey must not block the rest of the batch.
      console.error('[journeys] lost sweep failed for', journey.id, err);
    }
  }
}

async function isAbandoned(
  db: SupabaseClient,
  journey: JourneyRow,
  cutoff: string
): Promise<boolean> {
  const lastCustomerMessage = await lastInboundAt(db, journey);
  const engagement = Math.max(
    Date.parse(journey.link_sent_at),
    Date.parse((journey.last_event_at as string | null) ?? '') || 0,
    lastCustomerMessage
  );
  if (!(engagement < Date.parse(cutoff))) return false;
  return !(await hasPendingRuns(db, journey));
}

/** Instant (ms) of the customer's latest message, 0 when there is none. */
async function lastInboundAt(
  db: SupabaseClient,
  journey: JourneyRow
): Promise<number> {
  let conversationIds: string[] = journey.conversation_id
    ? [journey.conversation_id]
    : [];
  if (conversationIds.length === 0) {
    const { data, error } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', journey.account_id)
      .eq('contact_id', journey.contact_id)
      .eq('connection_id', journey.connection_id);
    if (error) throw new Error(`conversation lookup failed: ${error.message}`);
    conversationIds = ((data ?? []) as { id: string }[]).map((c) => c.id);
  }
  if (conversationIds.length === 0) return 0;

  const { data, error } = await db
    .from('messages')
    .select('created_at')
    .in('conversation_id', conversationIds)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`message lookup failed: ${error.message}`);
  return (
    Date.parse((data as { created_at?: string } | null)?.created_at ?? '') || 0
  );
}

/**
 * Runs parked or executing for THIS Journey (their saved context carries
 * `journey_id`: `menu_link_sent` and `journey_event` triggers set it). An
 * unrelated Wait of the same contact does not hold the Journey open.
 */
async function hasPendingRuns(
  db: SupabaseClient,
  journey: JourneyRow
): Promise<boolean> {
  const { data, error } = await db
    .from('automation_pending_executions')
    .select('id, context')
    .eq('account_id', journey.account_id)
    .eq('contact_id', journey.contact_id)
    .in('status', ['pending', 'running']);
  if (error) throw new Error(`pending lookup failed: ${error.message}`);
  return ((data ?? []) as { context: { journey_id?: string } | null }[]).some(
    (row) => row.context?.journey_id === journey.id
  );
}

async function ownerOf(
  db: SupabaseClient,
  accountId: string
): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle();
  return (data as { owner_user_id?: string } | null)?.owner_user_id ?? null;
}

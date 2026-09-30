import type { SupabaseClient } from '@supabase/supabase-js';
import type { JourneyStage } from './constants';

/** Funnel steps in order; `lost` is an outcome, not a step. */
export const FUNNEL_STAGES = [
  'link_sent',
  'browsing',
  'cart',
  'checkout',
  'won',
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelCounts {
  /** Journeys that reached each step (in it or beyond, `won` included). */
  reached: Record<FunnelStage, number>;
  /** Journeys closed as lost (they still count in the steps they reached). */
  lost: number;
  /** Link sent -> Bought, 0..1; null when no Journey has a link sent. */
  conversion: number | null;
}

export interface FunnelGroup extends FunnelCounts {
  key: string;
  /** Store name (by store) or channel type (by channel). */
  label: string;
}

export interface JourneyFunnel {
  total: FunnelCounts;
  byChannel: FunnelGroup[];
  byStore: FunnelGroup[];
}

const PAGE = 1000;

interface JourneyMilestones {
  /** Null on a direct Journey of a store with no WhatsApp connection. */
  connection_id: string | null;
  /** Set on direct Journeys; used to group them by store without a connection. */
  store_id?: string | null;
  stage: JourneyStage;
  first_view_content_at: string | null;
  last_add_to_cart_at: string | null;
  checkout_started_at: string | null;
  purchased_at: string | null;
}

/**
 * Deepest funnel step a Journey reached, from the milestones the events stamp
 * (not from `stage`, which reads `lost` for a Journey that gave up and would
 * lose where it got to). Skipping steps counts: a Purchase alone reached all.
 * `stage` is the fallback for a milestone that was never stamped.
 */
export function deepestStepReached(j: JourneyMilestones): number {
  let deepest = 0;
  if (j.first_view_content_at) deepest = 1;
  if (j.last_add_to_cart_at) deepest = 2;
  if (j.checkout_started_at) deepest = 3;
  if (j.purchased_at) deepest = 4;
  const byStage = FUNNEL_STAGES.indexOf(j.stage as FunnelStage);
  return Math.max(deepest, byStage);
}

const emptyCounts = (): FunnelCounts => ({
  reached: { link_sent: 0, browsing: 0, cart: 0, checkout: 0, won: 0 },
  lost: 0,
  conversion: null,
});

function add(counts: FunnelCounts, j: JourneyMilestones) {
  const deepest = deepestStepReached(j);
  FUNNEL_STAGES.forEach((s, i) => {
    if (i <= deepest) counts.reached[s]++;
  });
  if (j.stage === 'lost') counts.lost++;
}

function finish(counts: FunnelCounts): FunnelCounts {
  counts.conversion =
    counts.reached.link_sent > 0
      ? counts.reached.won / counts.reached.link_sent
      : null;
  return counts;
}

async function selectAll<T>(
  page: (
    from: number,
    to: number
  ) => PromiseLike<{
    data: unknown[] | null;
    error: { message: string } | null;
  }>,
  what: string
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`${what} read failed: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * Conversion funnel of the account's Journeys, overall and grouped by the
 * channel type and by the store of each Journey's connection. Read-only and
 * always filtered by `account_id` (works with an RLS client or service-role).
 */
export async function journeyFunnel(
  db: SupabaseClient,
  args: { accountId: string }
): Promise<JourneyFunnel> {
  const [journeys, connections, stores] = await Promise.all([
    selectAll<JourneyMilestones>(
      (from, to) =>
        db
          .from('journeys')
          .select(
            'connection_id, store_id, stage, first_view_content_at, last_add_to_cart_at, checkout_started_at, purchased_at'
          )
          .eq('account_id', args.accountId)
          .order('id')
          .range(from, to),
      'journeys'
    ),
    selectAll<{ id: string; channel_type: string; store_id: string }>(
      (from, to) =>
        db
          .from('channel_connections')
          .select('id, channel_type, store_id')
          .eq('account_id', args.accountId)
          .order('id')
          .range(from, to),
      'connections'
    ),
    selectAll<{ id: string; name: string }>(
      (from, to) =>
        db
          .from('stores')
          .select('id, name')
          .eq('account_id', args.accountId)
          .order('id')
          .range(from, to),
      'stores'
    ),
  ]);

  const connById = new Map(connections.map((c) => [c.id, c]));
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  const total = emptyCounts();
  const byChannel = new Map<string, FunnelGroup>();
  const byStore = new Map<string, FunnelGroup>();
  const group = (
    map: Map<string, FunnelGroup>,
    key: string,
    label: string
  ): FunnelGroup => {
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, label, ...emptyCounts() }));
    return g;
  };

  for (const j of journeys) {
    const conn = j.connection_id ? connById.get(j.connection_id) : undefined;
    add(total, j);
    if (!conn) {
      // No connection (direct, store without WhatsApp): still counts for its
      // store, but has no channel.
      if (j.store_id) {
        add(
          group(byStore, j.store_id, storeName.get(j.store_id) ?? j.store_id),
          j
        );
      }
      continue;
    }
    add(group(byChannel, conn.channel_type, conn.channel_type), j);
    add(
      group(
        byStore,
        conn.store_id,
        storeName.get(conn.store_id) ?? conn.store_id
      ),
      j
    );
  }

  const sorted = (map: Map<string, FunnelGroup>) =>
    [...map.values()]
      .map((g) => ({ ...g, ...finish(g) }))
      .sort(
        (a, b) =>
          b.reached.link_sent - a.reached.link_sent ||
          a.label.localeCompare(b.label)
      );
  return {
    total: finish(total),
    byChannel: sorted(byChannel),
    byStore: sorted(byStore),
  };
}

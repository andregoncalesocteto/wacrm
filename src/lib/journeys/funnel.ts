import type { SupabaseClient } from '@supabase/supabase-js';
import type { JourneyStage } from './constants';
import type { JourneyOrigin } from './journeys';

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
  /**
   * Link sent -> Bought, 0..1, over CRM-link Journeys only (a direct Journey
   * never had a link sent); null when none has a link sent.
   */
  conversion: number | null;
  /** Journeys counted (any stage, lost included). */
  total: number;
  /** Bought / total Journeys, 0..1; null without Journeys. */
  purchaseRate: number | null;
}

export const JOURNEY_ORIGINS: JourneyOrigin[] = ['crm_link', 'menu_direct'];

/** Counts of both origins together, plus each origin on its own. */
export interface FunnelWithOrigin extends FunnelCounts {
  byOrigin: Record<JourneyOrigin, FunnelCounts>;
}

export interface FunnelGroup extends FunnelWithOrigin {
  /** `NO_GROUP` for Journeys with no connection (channel) or no store. */
  key: string;
  /** Store name (by store) or channel type (by channel). */
  label: string;
}

/** Group key of the Journeys that have no connection / no store. */
export const NO_GROUP = '__none__';

export interface JourneyFunnel {
  total: FunnelWithOrigin;
  byChannel: FunnelGroup[];
  byStore: FunnelGroup[];
}

const PAGE = 1000;

interface JourneyMilestones {
  /** Null on a direct Journey of a store with no WhatsApp connection. */
  connection_id: string | null;
  /** Absent (legacy rows) means `crm_link`. */
  origin?: JourneyOrigin | null;
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
  total: 0,
  purchaseRate: null,
});

const emptyWithOrigin = (): FunnelWithOrigin => ({
  ...emptyCounts(),
  byOrigin: { crm_link: emptyCounts(), menu_direct: emptyCounts() },
});

const originOf = (j: JourneyMilestones): JourneyOrigin =>
  j.origin === 'menu_direct' ? 'menu_direct' : 'crm_link';

function addTo(counts: FunnelCounts, j: JourneyMilestones, origin: JourneyOrigin) {
  const deepest = deepestStepReached(j);
  FUNNEL_STAGES.forEach((s, i) => {
    // A direct Journey never had a link sent: its funnel starts at the first
    // step it reached.
    if (i === 0 && origin === 'menu_direct') return;
    if (i <= deepest) counts.reached[s]++;
  });
  if (j.stage === 'lost') counts.lost++;
  counts.total++;
}

function add(counts: FunnelWithOrigin, j: JourneyMilestones) {
  const origin = originOf(j);
  addTo(counts, j, origin);
  addTo(counts.byOrigin[origin], j, origin);
}

function rates(counts: FunnelCounts): FunnelCounts {
  counts.conversion =
    counts.reached.link_sent > 0
      ? counts.reached.won / counts.reached.link_sent
      : null;
  counts.purchaseRate =
    counts.total > 0 ? counts.reached.won / counts.total : null;
  return counts;
}

function finish<T extends FunnelWithOrigin>(counts: T): T {
  rates(counts);
  JOURNEY_ORIGINS.forEach((o) => rates(counts.byOrigin[o]));
  // Link -> purchase only makes sense for Journeys that had a link sent, and
  // the combined `link_sent` is already only theirs.
  counts.conversion = counts.byOrigin.crm_link.conversion;
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
 * channel type and by store, and split by origin (CRM link / direct). A Journey
 * without a connection (direct) is grouped under `NO_GROUP` for the channel
 * and by its own `store_id` for the store, so none is dropped. Read-only and
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
            'connection_id, store_id, origin, stage, first_view_content_at, last_add_to_cart_at, checkout_started_at, purchased_at'
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

  const total = emptyWithOrigin();
  const byChannel = new Map<string, FunnelGroup>();
  const byStore = new Map<string, FunnelGroup>();
  const group = (
    map: Map<string, FunnelGroup>,
    key: string,
    label: string
  ): FunnelGroup => {
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, label, ...emptyWithOrigin() }));
    return g;
  };

  for (const j of journeys) {
    const conn = j.connection_id ? connById.get(j.connection_id) : undefined;
    const storeId = conn?.store_id ?? j.store_id ?? null;
    add(total, j);
    add(
      group(
        byChannel,
        conn?.channel_type ?? NO_GROUP,
        conn?.channel_type ?? NO_GROUP
      ),
      j
    );
    add(
      group(
        byStore,
        storeId ?? NO_GROUP,
        storeId ? (storeName.get(storeId) ?? storeId) : NO_GROUP
      ),
      j
    );
  }

  const sorted = (map: Map<string, FunnelGroup>) =>
    [...map.values()]
      .map((g) => ({ ...g, ...finish(g) }))
      .sort(
        (a, b) =>
          b.total - a.total ||
          a.label.localeCompare(b.label)
      );
  return {
    total: finish(total),
    byChannel: sorted(byChannel),
    byStore: sorted(byStore),
  };
}

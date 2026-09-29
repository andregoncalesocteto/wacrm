import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  ApiError,
  badRequest,
  idtrackExpired,
  idtrackNotFound,
  orderNotFound,
} from '@/lib/api/v1/respond';
import type { JourneyStage } from './constants';
import {
  JOURNEY_EVENT_NAMES,
  parseCartProperties,
  parseCommonFields,
  parseOrderStatusProperties,
  parsePurchaseProperties,
  type CartProperties,
  type CommonEventFields,
  type OrderStatusProperties,
  type PurchaseProperties,
} from './event-payload';
import { onJourneyEventAccepted, onOrderStatusChanged } from './event-hooks';
import {
  advanceJourneyStage,
  findOpenJourney,
  openOrRenewJourney,
  type JourneyRow,
} from './journeys';
import {
  cancelPendingForJourney,
  changeOrderStatus,
  findCompletedPurchase,
  findOrderByExternalId,
  recordPurchase,
  type OrderStatusChange,
} from './orders';
import { resolveTrackingToken } from './tokens';

/**
 * Public events API core (`POST /api/v1/journey/events`), ticket #5.
 *
 *   validate -> replay if event_id already done -> resolve idtrack -> claim
 *   event_id -> run the event's handler -> store the response -> hook.
 *
 * Every query is filtered by `accountId` (service-role client: RLS is off).
 * To support a new event (Purchase, OrderStatusChanged) add an entry to
 * EVENT_HANDLERS: a `parseProperties` and a `handle`. Nothing else changes.
 */

export interface JourneyEventResult {
  event_id: string;
  /** Null only for an order whose Journey row no longer exists. */
  journey_id: string | null;
  stage: JourneyStage;
  duplicate: boolean;
}

interface Target {
  contactId: string;
  conversationId: string;
  connectionId: string;
}

interface HandlerContext {
  db: SupabaseClient;
  accountId: string;
  /** Audit user for rows created by the API (deals, pipeline). */
  userId: string;
  event: CommonEventFields & { properties: unknown };
  journey: JourneyRow;
  now: Date;
}

interface EventHandler {
  parseProperties(body: unknown): unknown;
  /**
   * Runs before any Journey is looked up or opened. Returns the Journey the
   * event was already applied to when it is a duplicate under another
   * `event_id` (Purchase with a known `order_id`): the event is then answered
   * 200 and nothing else happens.
   */
  findDuplicate?(
    db: SupabaseClient,
    accountId: string,
    properties: unknown
  ): Promise<{ journeyId: string } | null>;
  /**
   * Apply the event to the (open) Journey and its deal. Returns
   * `{ duplicateOf }` when the event turned out to be a duplicate found while
   * handling (Purchase that lost the order race): answered as `duplicate`,
   * with no hook.
   */
  handle?(
    ctx: HandlerContext
  ): Promise<void | { duplicateOf: { journeyId: string | null } }>;
  /**
   * For events about something that already exists (an Order) and so must not
   * open or touch a Journey. Replaces `handle`; the Journey is only reported.
   * A `change` is handed to `onOrderStatusChanged` after the response is saved.
   */
  handleStandalone?(ctx: StandaloneContext): Promise<{
    journeyId: string | null;
    change: OrderStatusChange | null;
  }>;
}

interface StandaloneContext {
  db: SupabaseClient;
  accountId: string;
  event: CommonEventFields & { properties: unknown };
  target: Target;
  now: Date;
}

const CLAIM_POLL_MS = 150;
const CLAIM_POLL_TRIES = 5;
/** A claim with no response older than this belongs to a crashed request. */
const CLAIM_STALE_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms = (v: unknown): number | null =>
  typeof v === 'string' || v instanceof Date ? new Date(v).getTime() : null;
const latest = (...vals: (number | null)[]): number | null =>
  vals.reduce<number | null>(
    (a, b) => (b === null ? a : a === null ? b : Math.max(a, b)),
    null
  );

async function updateJourney(
  ctx: HandlerContext,
  patch: Record<string, unknown>
): Promise<void> {
  const { error } = await ctx.db
    .from('journeys')
    .update({ ...patch, last_event_at: ctx.now.toISOString() })
    .eq('id', ctx.journey.id)
    .eq('account_id', ctx.accountId);
  if (error) throw new Error(`journey event update failed: ${error.message}`);
}

async function moveTo(ctx: HandlerContext, stage: JourneyStage) {
  await advanceJourneyStage(ctx.db, {
    accountId: ctx.accountId,
    userId: ctx.userId,
    journeyId: ctx.journey.id,
    stage,
    at: ctx.now,
  });
}

/**
 * ViewContent counts views: a read-modify-write, so the write is a
 * compare-and-swap on the count read (`eq`, or `is null`). Concurrent events
 * that lose it re-read the Journey and try again, so no increment is lost.
 */
const VIEW_COUNT_TRIES = 5;

const viewContent: EventHandler = {
  parseProperties: () => null,
  async handle(ctx) {
    let row: Record<string, unknown> = ctx.journey;
    for (let attempt = 0; attempt < VIEW_COUNT_TRIES; attempt++) {
      const seen =
        (row.view_content_count as number | null | undefined) ?? null;
      const first = !row.first_view_content_at;
      const guarded = ctx.db
        .from('journeys')
        .update({
          view_content_count: (seen ?? 0) + 1,
          last_event_at: ctx.now.toISOString(),
          ...(first
            ? { first_view_content_at: ctx.event.occurredAt.toISOString() }
            : {}),
        })
        .eq('id', ctx.journey.id)
        .eq('account_id', ctx.accountId);
      const { data, error } = await (
        seen === null
          ? guarded.is('view_content_count', null)
          : guarded.eq('view_content_count', seen)
      ).select('id');
      if (error) {
        throw new Error(`journey event update failed: ${error.message}`);
      }
      if (Array.isArray(data) && data.length > 0) {
        await moveTo(ctx, 'browsing');
        return;
      }
      const { data: fresh, error: readErr } = await ctx.db
        .from('journeys')
        .select('*')
        .eq('id', ctx.journey.id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (readErr) {
        throw new Error(`journey lookup failed: ${readErr.message}`);
      }
      if (!fresh) return;
      row = fresh as Record<string, unknown>;
    }
    throw new Error('view count update kept conflicting; retry');
  },
};

/**
 * AddToCart / InitiateCheckout both carry the whole cart. The snapshot is
 * replaced unless it is OLDER than the one already stored (a late, out-of-order
 * event must not overwrite a newer cart). The stage never recedes either way.
 */
function cartHandler(
  stage: 'cart' | 'checkout',
  field: 'last_add_to_cart_at' | 'checkout_started_at'
): EventHandler {
  return {
    parseProperties: parseCartProperties,
    async handle(ctx) {
      const props = ctx.event.properties as CartProperties;
      const at = ctx.event.occurredAt.getTime();
      const j = ctx.journey;
      const snapshotAt = latest(
        ms(j.last_add_to_cart_at),
        ms(j.checkout_started_at)
      );
      const fresh = snapshotAt === null || at >= snapshotAt;
      const stamp = new Date(latest(ms(j[field]), at) as number).toISOString();

      await updateJourney(ctx, {
        [field]: stamp,
        ...(fresh
          ? {
              cart_items_count: props.cart.items.reduce(
                (n, i) => n + i.quantity,
                0
              ),
              cart_value: props.cart.value,
              cart_currency: props.currency,
              cart_items: props.cart.items,
            }
          : {}),
      });
      if (fresh && j.deal_id) {
        const { error } = await ctx.db
          .from('deals')
          .update({ value: props.cart.value, currency: props.currency })
          .eq('id', j.deal_id as string)
          .eq('account_id', ctx.accountId);
        if (error)
          throw new Error(`journey deal update failed: ${error.message}`);
      }
      await moveTo(ctx, stage);
    },
  };
}

/**
 * Purchase: creates the Order and closes the Journey as won (its deal moves to
 * "Comprou" and is marked won). The Journey is closed LAST: a failure before
 * that leaves it open, and the retry finishes the job (see `recordPurchase`).
 * A Purchase on a lost Journey never reaches here with that Journey: only an
 * open one is reused, so a fresh Journey is opened for it.
 */
const purchase: EventHandler = {
  parseProperties: parsePurchaseProperties,
  findDuplicate: (db, accountId, properties) =>
    findCompletedPurchase(
      db,
      accountId,
      (properties as PurchaseProperties).orderId
    ),
  async handle(ctx) {
    const props = ctx.event.properties as PurchaseProperties;
    const outcome = await recordPurchase(ctx.db, {
      accountId: ctx.accountId,
      journey: ctx.journey,
      idtrack: ctx.event.idtrack,
      eventId: ctx.event.eventId,
      occurredAt: ctx.event.occurredAt,
      purchase: props,
    });
    if (outcome.duplicate) {
      return { duplicateOf: { journeyId: outcome.journeyId } };
    }
    await updateJourney(ctx, {
      purchased_at: ctx.event.occurredAt.toISOString(),
    });
    await moveTo(ctx, 'won');
    await cancelPendingForJourney(ctx.db, {
      accountId: ctx.accountId,
      journeyId: ctx.journey.id,
    });
  },
};

/**
 * OrderStatusChanged (ticket #8): the order is found by (account, `order_id`)
 * and must belong to the contact of the token, else `order_not_found` (400)
 * without saying whether another contact owns it. The status only moves
 * forward (`changeOrderStatus`); an older / equal one is accepted, answered
 * 200 and ignored: no write, no hook. The Journey is not touched (it closed
 * with the Purchase) and never opened.
 */
const orderStatusChanged: EventHandler = {
  parseProperties: parseOrderStatusProperties,
  async handleStandalone(ctx) {
    const props = ctx.event.properties as OrderStatusProperties;
    const order = await findOrderByExternalId(
      ctx.db,
      ctx.accountId,
      props.orderId
    );
    if (!order || order.contact_id !== ctx.target.contactId) {
      throw orderNotFound(props.orderId);
    }
    const change = await changeOrderStatus(ctx.db, {
      accountId: ctx.accountId,
      order,
      status: props.status,
      occurredAt: ctx.event.occurredAt,
      eventId: ctx.event.eventId,
      now: ctx.now,
    });
    return { journeyId: order.journey_id, change };
  },
};

/** Events with a handler today. */
const EVENT_HANDLERS: Record<string, EventHandler> = {
  ViewContent: viewContent,
  AddToCart: cartHandler('cart', 'last_add_to_cart_at'),
  InitiateCheckout: cartHandler('checkout', 'checkout_started_at'),
  Purchase: purchase,
  OrderStatusChanged: orderStatusChanged,
};

function handlerFor(name: string): EventHandler {
  const handler = EVENT_HANDLERS[name];
  if (handler) return handler;
  if ((JOURNEY_EVENT_NAMES as readonly string[]).includes(name)) {
    throw badRequest(`Event '${name}' is not supported yet`);
  }
  throw badRequest(
    `Unknown event name '${name}'. Supported: ${Object.keys(EVENT_HANDLERS).join(', ')}`
  );
}

interface EventRow {
  id: string;
  response: JourneyEventResult | null;
  created_at: string;
}

async function findEventRow(
  db: SupabaseClient,
  accountId: string,
  eventId: string
): Promise<EventRow | null> {
  const { data, error } = await db
    .from('journey_events')
    .select('id, response, created_at')
    .eq('account_id', accountId)
    .eq('event_id', eventId)
    .maybeSingle();
  if (error) throw new Error(`journey event lookup failed: ${error.message}`);
  return (data as EventRow | null) ?? null;
}

const replay = (row: EventRow): JourneyEventResult => ({
  ...(row.response as JourneyEventResult),
  duplicate: true,
});

/**
 * Take the event_id, or find who has it. Returns `{claim}` when this request
 * owns it, or `{replay}` with the original response. A concurrent request that
 * is still working is awaited briefly; a stale claim (crashed request) is taken
 * over; otherwise the caller gets a retryable 500 and re-sends the same id.
 */
async function claimEvent(
  db: SupabaseClient,
  accountId: string,
  event: CommonEventFields
): Promise<{ claimId: string } | { replay: JourneyEventResult }> {
  const { data, error } = await db
    .from('journey_events')
    .insert({
      account_id: accountId,
      event_id: event.eventId,
      name: event.name,
      occurred_at: event.occurredAt.toISOString(),
    })
    .select('id')
    .single();
  if (!error && data) return { claimId: (data as { id: string }).id };
  if (!isUniqueViolation(error)) {
    throw new Error(`journey event claim failed: ${error?.message}`);
  }

  for (let i = 0; i <= CLAIM_POLL_TRIES; i++) {
    const row = await findEventRow(db, accountId, event.eventId);
    if (!row) return claimEvent(db, accountId, event); // released meanwhile
    if (row.response) return { replay: replay(row) };
    if (Date.now() - new Date(row.created_at).getTime() > CLAIM_STALE_MS) {
      const { data: taken } = await db
        .from('journey_events')
        .update({ created_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('account_id', accountId)
        .eq('created_at', row.created_at)
        .is('response', null)
        .select('id');
      if (Array.isArray(taken) && taken.length > 0) return { claimId: row.id };
    }
    if (i < CLAIM_POLL_TRIES) await sleep(CLAIM_POLL_MS);
  }
  throw new ApiError(
    'internal',
    'This event_id is still being processed; retry with the same event_id',
    500
  );
}

async function saveResponse(
  db: SupabaseClient,
  accountId: string,
  claimId: string,
  result: JourneyEventResult,
  now: Date
): Promise<void> {
  const { error } = await db
    .from('journey_events')
    .update({
      journey_id: result.journey_id,
      response: result,
      completed_at: now.toISOString(),
    })
    .eq('id', claimId)
    .eq('account_id', accountId);
  if (error) throw new Error(`journey event save failed: ${error.message}`);
}

/** Accept one behaviour event. Throws `ApiError` for every 4xx. */
export async function processJourneyEvent(
  db: SupabaseClient,
  args: {
    accountId: string;
    body: unknown;
    /** Resolves the audit user only when a row has to be created. */
    resolveUserId: () => Promise<string>;
    now?: Date;
  }
): Promise<JourneyEventResult> {
  const { accountId } = args;
  const common = parseCommonFields(args.body);
  const handler = handlerFor(common.name);
  const event = {
    ...common,
    properties: handler.parseProperties(args.body),
  };

  // A repeated event_id answers with the original response even if its
  // idtrack has expired since.
  const existing = await findEventRow(db, accountId, event.eventId);
  if (existing?.response) return replay(existing);

  const now = args.now ?? new Date();
  const token = await resolveTrackingToken(
    db,
    { accountId, token: event.idtrack },
    now
  );
  if (!token.ok) {
    throw token.reason === 'expired' ? idtrackExpired() : idtrackNotFound();
  }

  const claim = await claimEvent(db, accountId, event);
  if ('replay' in claim) return claim.replay;

  try {
    const duplicateOf = await handler.findDuplicate?.(
      db,
      accountId,
      event.properties
    );
    if (duplicateOf) {
      const result: JourneyEventResult = {
        event_id: event.eventId,
        journey_id: duplicateOf.journeyId,
        stage: 'won',
        duplicate: true,
      };
      await saveResponse(db, accountId, claim.claimId, result, now);
      return result;
    }

    const target: Target = {
      contactId: token.contactId,
      conversationId: token.conversationId,
      connectionId: token.connectionId,
    };

    if (handler.handleStandalone) {
      const { journeyId, change } = await handler.handleStandalone({
        db,
        accountId,
        event,
        target,
        now,
      });
      let stage: JourneyStage = 'won';
      if (journeyId) {
        const { data: j, error: jErr } = await db
          .from('journeys')
          .select('stage')
          .eq('id', journeyId)
          .eq('account_id', accountId)
          .maybeSingle();
        if (jErr) throw new Error(`journey lookup failed: ${jErr.message}`);
        stage = (j as { stage: JourneyStage } | null)?.stage ?? stage;
      }
      const result: JourneyEventResult = {
        event_id: event.eventId,
        journey_id: journeyId,
        stage,
        duplicate: false,
      };
      await saveResponse(db, accountId, claim.claimId, result, now);
      if (change) {
        try {
          await onOrderStatusChanged(db, change);
        } catch (hookErr) {
          console.error('[journeys] onOrderStatusChanged failed:', hookErr);
        }
      }
      return result;
    }

    const userId = await args.resolveUserId();
    // Reuse the open Journey; with none (closed, or never opened) start a new
    // one. openOrRenewJourney is NOT used on an open one: it would count a
    // link that was never sent.
    const journey =
      (await findOpenJourney(db, { accountId, ...target })) ??
      (await openOrRenewJourney(db, {
        accountId,
        userId,
        contactId: target.contactId,
        conversationId: target.conversationId,
        connectionId: target.connectionId,
        linkSentAt: now,
      }));

    const handled = await handler.handle?.({
      db,
      accountId,
      userId,
      event,
      journey,
      now,
    });

    // Duplicate found while handling: answer it, without hook nor effects.
    const reportedId = handled ? handled.duplicateOf.journeyId : journey.id;
    const { data: after, error } = await db
      .from('journeys')
      .select('stage')
      .eq('id', reportedId ?? journey.id)
      .eq('account_id', accountId)
      .single();
    if (error) throw new Error(`journey lookup failed: ${error.message}`);
    const stage = (after as { stage: JourneyStage }).stage;

    const result: JourneyEventResult = {
      event_id: event.eventId,
      journey_id: reportedId,
      stage,
      duplicate: !!handled,
    };
    await saveResponse(db, accountId, claim.claimId, result, now);
    if (handled) return result;

    try {
      await onJourneyEventAccepted(db, {
        accountId,
        eventId: event.eventId,
        name: event.name,
        occurredAt: event.occurredAt,
        journeyId: journey.id,
        ...target,
        stage,
        properties: event.properties as Record<string, unknown>,
      });
    } catch (hookErr) {
      console.error('[journeys] onJourneyEventAccepted failed:', hookErr);
    }
    return result;
  } catch (err) {
    // Release the id so the caller's retry is processed, not stuck.
    await db
      .from('journey_events')
      .delete()
      .eq('id', claim.claimId)
      .eq('account_id', accountId)
      .is('response', null);
    throw err;
  }
}

import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeAdmin } from '@/lib/automations/engine.characterization.fake';
import { loadJourneyHandoffState } from './handoff-state';

type Row = Record<string, unknown>;
const h = { db: {} as Record<string, Row[]>, seq: 0, rpcCalls: [] as never[] };
const db = () => fakeAdmin(h).supabaseAdmin() as unknown as SupabaseClient;

const args = { accountId: 'acct-1', contactId: 'ct-1', conversationId: 'cv-1' };

const journey = (over: Row = {}): Row => ({
  id: 'j-1',
  account_id: 'acct-1',
  contact_id: 'ct-1',
  connection_id: 'conn-1',
  deal_id: 'd-1',
  state: 'open',
  stage: 'cart',
  link_sent_at: '2026-05-01T10:00:00Z',
  cart_items_count: 2,
  cart_value: 89.8,
  cart_currency: 'BRL',
  ...over,
});

beforeEach(() => {
  h.seq = 0;
  h.db = {
    conversations: [
      { id: 'cv-1', account_id: 'acct-1', connection_id: 'conn-1' },
    ],
    journeys: [],
    deals: [{ id: 'd-1', account_id: 'acct-1', stage_id: 's-cart' }],
    pipeline_stages: [{ id: 's-cart', name: 'Carrinho (renomeada)' }],
    orders: [],
    journey_events: [],
  };
});

describe('loadJourneyHandoffState', () => {
  it('is null when the contact has no Journey on the connection', async () => {
    h.db.journeys = [journey({ connection_id: 'other' })];
    expect(await loadJourneyHandoffState(db(), args)).toBeNull();
  });

  it('reads stage, cart, active order and last event', async () => {
    h.db.journeys = [journey()];
    h.db.orders = [
      {
        account_id: 'acct-1',
        journey_id: 'j-1',
        external_order_id: 'PED-1',
        status: 'preparing',
        status_changed_at: '2026-05-01T11:00:00Z',
        placed_at: '2026-05-01T10:50:00Z',
      },
    ];
    h.db.journey_events = [
      {
        account_id: 'acct-1',
        journey_id: 'j-1',
        name: 'ViewContent',
        occurred_at: '2026-05-01T10:10:00Z',
      },
      {
        account_id: 'acct-1',
        journey_id: 'j-1',
        name: 'AddToCart',
        occurred_at: '2026-05-01T10:20:00Z',
      },
      {
        account_id: 'acct-1',
        journey_id: 'j-1',
        name: 'OrderStatusChanged',
        occurred_at: '2026-05-01T11:00:00Z',
      },
    ];
    expect(await loadJourneyHandoffState(db(), args)).toEqual({
      stageName: 'Carrinho (renomeada)',
      state: 'open',
      cart: { itemsCount: 2, value: 89.8, currency: 'BRL' },
      order: {
        externalOrderId: 'PED-1',
        status: 'preparing',
        since: '2026-05-01T11:00:00Z',
      },
      lastEventName: 'AddToCart',
    });
  });

  it('prefers the open Journey over a more recent closed one', async () => {
    h.db.journeys = [
      journey({
        id: 'j-old',
        state: 'open',
        deal_id: null,
        stage: 'browsing',
        cart_items_count: 0,
      }),
      journey({
        id: 'j-new',
        state: 'won',
        link_sent_at: '2026-05-02T10:00:00Z',
      }),
    ];
    const s = await loadJourneyHandoffState(db(), args);
    expect(s).toMatchObject({
      state: 'open',
      stageName: 'Navegando',
      cart: null,
    });
  });

  it('falls back to the most recent closed Journey and hides its cart', async () => {
    h.db.journeys = [
      journey({
        id: 'j-a',
        state: 'lost',
        link_sent_at: '2026-04-01T10:00:00Z',
        deal_id: null,
        stage: 'lost',
      }),
      journey({ id: 'j-b', state: 'won', stage: 'won', deal_id: null }),
    ];
    const s = await loadJourneyHandoffState(db(), args);
    expect(s).toMatchObject({ state: 'won', stageName: 'Comprou', cart: null });
  });

  it("uses the contact's latest order when the Journey has none", async () => {
    h.db.journeys = [journey()];
    h.db.orders = [
      {
        account_id: 'acct-1',
        contact_id: 'ct-1',
        connection_id: 'conn-1',
        journey_id: 'j-prev',
        external_order_id: 'OLD',
        status: 'delivered',
        status_changed_at: null,
        placed_at: '2026-04-30T10:00:00Z',
      },
    ];
    const s = await loadJourneyHandoffState(db(), args);
    expect(s?.order).toEqual({
      externalOrderId: 'OLD',
      status: 'delivered',
      since: '2026-04-30T10:00:00Z',
    });
  });

  it("never reads another account's data", async () => {
    h.db.journeys = [journey({ account_id: 'acct-2' })];
    expect(await loadJourneyHandoffState(db(), args)).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeAdmin } from '@/lib/automations/engine.characterization.fake';
import {
  advanceJourneyStage,
  openDirectJourney,
  openOrRenewJourney,
} from './journeys';

type Row = Record<string, unknown>;
const h = { db: {} as Record<string, Row[]>, seq: 0, rpcCalls: [] as never[] };
const db = () => fakeAdmin(h).supabaseAdmin() as unknown as SupabaseClient;

const args = {
  accountId: 'acct-1',
  userId: 'user-1',
  contactId: 'ct-1',
  conversationId: 'cv-1',
  connectionId: 'conn-1',
};

beforeEach(() => {
  h.db = { contacts: [{ id: 'ct-1', account_id: 'acct-1', name: 'Maria' }] };
  h.seq = 0;
});

describe('advanceJourneyStage', () => {
  it('moves the Journey and its deal forward and never back', async () => {
    const journey = await openOrRenewJourney(db(), args);
    const stageId = (key: string) =>
      h.db.pipeline_stages.find((s) => s.system_key === key)!.id;

    expect(
      await advanceJourneyStage(db(), {
        ...args,
        journeyId: journey.id,
        stage: 'cart',
      })
    ).toBe(true);
    expect(h.db.journeys[0].stage).toBe('cart');
    expect(h.db.deals[0].stage_id).toBe(stageId('cart'));

    expect(
      await advanceJourneyStage(db(), {
        ...args,
        journeyId: journey.id,
        stage: 'browsing',
      })
    ).toBe(false);
    expect(h.db.deals[0].stage_id).toBe(stageId('cart'));
  });

  it('closes the Journey and the deal on a terminal stage; a new link then opens a new Journey', async () => {
    const journey = await openOrRenewJourney(db(), args);

    await advanceJourneyStage(db(), {
      ...args,
      journeyId: journey.id,
      stage: 'won',
    });

    expect(h.db.journeys[0]).toMatchObject({ state: 'won', stage: 'won' });
    expect(h.db.deals[0]).toMatchObject({ status: 'won' });

    await openOrRenewJourney(db(), args);
    expect(h.db.journeys).toHaveLength(2);
    expect(h.db.deals.filter((d) => d.status === 'open')).toHaveLength(1);
  });

  it('a slower concurrent advance cannot pull the Journey and the deal back', async () => {
    const journey = await openOrRenewJourney(db(), args);
    const stageId = (key: string) =>
      h.db.pipeline_stages.find((s) => s.system_key === key)!.id;

    // AddToCart read the Journey at `link_sent`; before it writes, an
    // InitiateCheckout completes on the same Journey and its deal.
    const real = db();
    const racing = {
      ...real,
      from: (table: string) => {
        const q = real.from(table) as unknown as {
          update: (p: Row) => unknown;
        };
        if (table === 'journeys') {
          const update = q.update.bind(q);
          q.update = (patch: Row) => {
            q.update = update;
            h.db.journeys[0].stage = 'checkout';
            h.db.deals[0].stage_id = stageId('checkout');
            return update(patch);
          };
        }
        return q;
      },
    } as unknown as SupabaseClient;

    const moved = await advanceJourneyStage(racing, {
      ...args,
      journeyId: journey.id,
      stage: 'cart',
    });

    expect(moved).toBe(false);
    expect(h.db.journeys[0].stage).toBe('checkout');
    expect(h.db.deals[0].stage_id).toBe(stageId('checkout'));
  });

  it('a deal already ahead of the target stage is not moved back', async () => {
    const journey = await openOrRenewJourney(db(), args);
    const stageId = (key: string) =>
      h.db.pipeline_stages.find((s) => s.system_key === key)!.id;
    h.db.deals[0].stage_id = stageId('checkout');

    await advanceJourneyStage(db(), {
      ...args,
      journeyId: journey.id,
      stage: 'cart',
    });
    expect(h.db.journeys[0].stage).toBe('cart');
    expect(h.db.deals[0].stage_id).toBe(stageId('checkout'));
  });
});

describe('a CRM link sent to a contact with an open DIRECT Journey', () => {
  const direct = {
    accountId: 'acct-1',
    userId: 'user-1',
    contactId: 'ct-1',
    connectionId: 'conn-1',
    storeId: 'store-1',
    conversationId: 'cv-1',
    stage: 'cart' as const,
  };

  it('turns it into a link Journey (origin crm_link) so resumptions and the funnel treat it as one; the stage never regresses', async () => {
    const before = await openDirectJourney(db(), direct);
    expect(before).toMatchObject({ origin: 'menu_direct', link_sent_at: null });

    const after = await openOrRenewJourney(db(), args);

    expect(after.id).toBe(before.id);
    expect(after.origin).toBe('crm_link');
    expect(after.link_sent_at).toBeTruthy();
    expect(h.db.journeys).toHaveLength(1);
    expect(h.db.journeys[0]).toMatchObject({
      origin: 'crm_link',
      link_count: 1,
      stage: 'cart',
      store_id: 'store-1',
    });
  });
});

describe('openDirectJourney when the store notice connection appears or changes', () => {
  const base = {
    accountId: 'acct-1',
    userId: 'user-1',
    contactId: 'ct-1',
    storeId: 'store-1',
    conversationId: null,
    stage: 'browsing' as const,
  };

  it('event 1 without a connection, event 2 with one: the SAME Journey, now anchored to the connection', async () => {
    const first = await openDirectJourney(db(), { ...base, connectionId: null });
    expect(first.connection_id).toBeNull();

    const second = await openDirectJourney(db(), {
      ...base,
      connectionId: 'conn-1',
      conversationId: 'cv-1',
    });

    expect(second.id).toBe(first.id);
    expect(h.db.journeys).toHaveLength(1);
    expect(h.db.journeys[0]).toMatchObject({
      connection_id: 'conn-1',
      conversation_id: 'cv-1',
      store_id: 'store-1',
    });
    expect(h.db.deals).toHaveLength(1);
  });

  it('the notice connection of the store changes: still the same open Journey (kept on its connection)', async () => {
    const first = await openDirectJourney(db(), { ...base, connectionId: 'conn-1' });
    const second = await openDirectJourney(db(), { ...base, connectionId: 'conn-2' });
    expect(second.id).toBe(first.id);
    expect(h.db.journeys).toHaveLength(1);
    expect(h.db.journeys[0].connection_id).toBe('conn-1');
  });

  it('the connection is disabled/removed (none now): still the same Journey', async () => {
    const first = await openDirectJourney(db(), { ...base, connectionId: 'conn-1' });
    const second = await openDirectJourney(db(), { ...base, connectionId: null });
    expect(second.id).toBe(first.id);
    expect(h.db.journeys).toHaveLength(1);
  });

  it('another store or another contact gets its own Journey', async () => {
    await openDirectJourney(db(), { ...base, connectionId: null });
    await openDirectJourney(db(), { ...base, storeId: 'store-2', connectionId: null });
    expect(h.db.journeys).toHaveLength(2);
  });
});

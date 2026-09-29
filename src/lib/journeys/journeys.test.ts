import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeAdmin } from '@/lib/automations/engine.characterization.fake';
import { advanceJourneyStage, openOrRenewJourney } from './journeys';

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
});

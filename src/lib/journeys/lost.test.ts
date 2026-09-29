import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeAdmin } from '@/lib/automations/engine.characterization.fake';
import { advanceJourneyStage, openOrRenewJourney } from './journeys';
import { closeAbandonedJourneys } from './lost';

type Row = Record<string, unknown>;
const h = { db: {} as Record<string, Row[]>, seq: 0, rpcCalls: [] as never[] };
const db = () => fakeAdmin(h).supabaseAdmin() as unknown as SupabaseClient;

const NOW = new Date('2026-06-10T12:00:00.000Z');
const ago = (hours: number) =>
  new Date(NOW.getTime() - hours * 3600_000).toISOString();

const args = {
  accountId: 'acct-1',
  userId: 'user-1',
  contactId: 'ct-1',
  conversationId: 'cv-1',
  connectionId: 'conn-1',
};

async function openJourney(linkSentHoursAgo: number, over: Row = {}) {
  const journey = await openOrRenewJourney(db(), {
    ...args,
    linkSentAt: new Date(NOW.getTime() - linkSentHoursAgo * 3600_000),
  });
  Object.assign(
    h.db.journeys.find((j) => j.id === journey.id)!,
    over
  );
  return journey;
}

const sweep = () => closeAbandonedJourneys(db(), { now: NOW });

beforeEach(() => {
  h.seq = 0;
  h.db = {
    contacts: [{ id: 'ct-1', account_id: 'acct-1', name: 'Maria' }],
    accounts: [{ id: 'acct-1', owner_user_id: 'user-1' }],
    messages: [],
    automation_pending_executions: [],
  };
});

describe('closeAbandonedJourneys', () => {
  it('closes a Journey quiet for 24 h: Journey lost, deal lost at "Perdido"', async () => {
    await openJourney(25);

    expect(await sweep()).toEqual({ checked: 1, lost: 1 });

    expect(h.db.journeys[0]).toMatchObject({ state: 'lost', stage: 'lost' });
    expect(h.db.journeys[0].closed_at).toBe(NOW.toISOString());
    const lostStage = h.db.pipeline_stages.find(
      (s) => s.system_key === 'lost'
    )!;
    expect(h.db.deals[0]).toMatchObject({
      status: 'lost',
      stage_id: lostStage.id,
    });
  });

  it('keeps the Journey open before 24 h', async () => {
    await openJourney(23.9);
    expect((await sweep()).lost).toBe(0);
    expect(h.db.journeys[0].state).toBe('open');
  });

  it('a recent behavior event keeps it open; 24 h after that event it closes', async () => {
    await openJourney(30, { last_event_at: ago(2) });
    expect((await sweep()).lost).toBe(0);

    h.db.journeys[0].last_event_at = ago(24.1);
    expect((await sweep()).lost).toBe(1);
  });

  it('a customer reply within 24 h keeps it open (only inbound counts)', async () => {
    await openJourney(30);
    h.db.messages.push({
      conversation_id: 'cv-1',
      sender_type: 'customer',
      created_at: ago(3),
    });
    expect((await sweep()).lost).toBe(0);
  });

  it('outbound messages do not count as engagement', async () => {
    await openJourney(30);
    h.db.messages.push({
      conversation_id: 'cv-1',
      sender_type: 'agent',
      created_at: ago(1),
    });
    expect((await sweep()).lost).toBe(1);
  });

  it('a Journey opened by an event (no link) is anchored on that event', async () => {
    await openJourney(26, { last_event_at: ago(26) });
    expect((await sweep()).lost).toBe(1);
  });

  it('waits for pending Resumption/abandoned-cart runs of the Journey', async () => {
    const journey = await openJourney(30);
    h.db.automation_pending_executions.push({
      id: 'p-1',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      status: 'pending',
      context: { journey_id: journey.id },
    });
    expect((await sweep()).lost).toBe(0);

    h.db.automation_pending_executions[0].status = 'done';
    expect((await sweep()).lost).toBe(1);
  });

  it('a run in progress also holds it; cancelled or unrelated waits do not', async () => {
    const journey = await openJourney(30);
    const pending = (status: string, journeyId?: string) => ({
      account_id: 'acct-1',
      contact_id: 'ct-1',
      status,
      context: journeyId ? { journey_id: journeyId } : {},
    });
    h.db.automation_pending_executions.push(
      pending('cancelled', journey.id),
      pending('pending')
    );
    h.db.automation_pending_executions.push(pending('running', journey.id));
    expect((await sweep()).lost).toBe(0);

    h.db.automation_pending_executions.pop();
    expect((await sweep()).lost).toBe(1);
  });

  it('never touches a won Journey', async () => {
    const journey = await openJourney(48);
    await advanceJourneyStage(db(), {
      ...args,
      journeyId: journey.id,
      stage: 'won',
    });

    expect(await sweep()).toEqual({ checked: 0, lost: 0 });
    expect(h.db.journeys[0]).toMatchObject({ state: 'won' });
    expect(h.db.deals[0].status).toBe('won');
  });

  it('two overlapping sweeps close it once', async () => {
    await openJourney(30);
    const [a, b] = await Promise.all([sweep(), sweep()]);

    expect(a.lost + b.lost).toBe(1);
    expect(h.db.journeys[0].state).toBe('lost');
    expect(h.db.deals).toHaveLength(1);
  });

  it('is idempotent: a second sweep finds nothing', async () => {
    await openJourney(30);
    await sweep();
    expect(await sweep()).toEqual({ checked: 0, lost: 0 });
  });

  it('a lost Journey is not reopened: the next link opens a new Journey', async () => {
    await openJourney(30);
    await sweep();

    const next = await openOrRenewJourney(db(), args);
    expect(h.db.journeys).toHaveLength(2);
    expect(next.id).not.toBe(h.db.journeys[0].id);
    expect(h.db.journeys[0].state).toBe('lost');
    expect(next.state).toBe('open');
  });
});

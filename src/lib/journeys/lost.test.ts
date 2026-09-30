import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fakeAdmin } from '@/lib/automations/engine.characterization.fake';
import {
  advanceJourneyStage,
  openDirectJourney,
  openOrRenewJourney,
} from './journeys';
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

  describe('candidates that are never eligible', () => {
    /** `n` old Journeys whose customer keeps writing, then one truly abandoned. */
    function seedBacklog(n: number) {
      h.db.accounts = [{ id: 'acct-1', owner_user_id: 'user-1' }];
      for (let i = 0; i < n; i++) {
        h.db.journeys ??= [];
        h.db.journeys.push({
          id: `j-chat-${String(i).padStart(3, '0')}`,
          account_id: 'acct-1',
          contact_id: `ct-chat-${i}`,
          conversation_id: `cv-chat-${i}`,
          connection_id: 'conn-1',
          state: 'open',
          stage: 'browsing',
          link_sent_at: ago(200 - i * 0.01),
          last_event_at: null,
        });
        h.db.messages.push({
          conversation_id: `cv-chat-${i}`,
          sender_type: 'customer',
          created_at: ago(1),
        });
      }
      h.db.journeys.push({
        id: 'j-abandoned',
        account_id: 'acct-1',
        contact_id: 'ct-x',
        conversation_id: 'cv-x',
        connection_id: 'conn-1',
        state: 'open',
        stage: 'cart',
        link_sent_at: ago(30),
        last_event_at: null,
      });
    }

    /** The shared fake ignores `limit()`; a real database honours it. */
    const limiting = () => {
      const real = db();
      return {
        ...real,
        from: (table: string) => {
          const q = real.from(table) as unknown as {
            limit: (n: number) => unknown;
            range: (a: number, b: number) => unknown;
          };
          const limit = q.limit.bind(q);
          q.limit = (n: number) =>
            table === 'journeys' ? q.range(0, n - 1) : limit(n);
          return q;
        },
      } as unknown as SupabaseClient;
    };

    it('does not let more than one page of them hide a newer abandoned Journey', async () => {
      seedBacklog(120);

      expect(await closeAbandonedJourneys(limiting(), { now: NOW })).toEqual({
        checked: 121,
        lost: 1,
      });
      expect(h.db.journeys.find((j) => j.id === 'j-abandoned')).toMatchObject({
        state: 'lost',
      });
      expect(h.db.journeys.filter((j) => j.state === 'open')).toHaveLength(120);
    });

    it('stops at the per-run budget', async () => {
      seedBacklog(120);

      const res = await closeAbandonedJourneys(db(), {
        now: NOW,
        maxExamined: 60,
      });
      expect(res).toEqual({ checked: 60, lost: 0 });
    });
  });
});

describe('direct Journeys (no link: link_sent_at is null)', () => {
  async function openDirect(createdHoursAgo: number, over: Row = {}) {
    const journey = await openDirectJourney(db(), {
      accountId: 'acct-1',
      userId: 'user-1',
      contactId: 'ct-1',
      connectionId: null,
      storeId: 'store-1',
      conversationId: null,
      stage: 'cart',
    });
    Object.assign(h.db.journeys.find((j) => j.id === journey.id)!, {
      created_at: ago(createdHoursAgo),
      ...over,
    });
    return journey;
  }

  it('is anchored on its creation: closed 24 h after it, even with no connection', async () => {
    const journey = await openDirect(25);
    expect(journey.link_sent_at).toBeNull();
    expect(await sweep()).toEqual({ checked: 1, lost: 1 });
    expect(h.db.journeys[0]).toMatchObject({ state: 'lost', stage: 'lost' });
  });

  it('stays open before 24 h, and a recent event keeps it open', async () => {
    await openDirect(23);
    expect((await sweep()).lost).toBe(0);

    h.db.journeys[0].created_at = ago(40);
    h.db.journeys[0].last_event_at = ago(2);
    expect((await sweep()).lost).toBe(0);

    h.db.journeys[0].last_event_at = ago(25);
    expect((await sweep()).lost).toBe(1);
  });

  it('a customer message on any conversation of the contact keeps it open', async () => {
    await openDirect(30);
    h.db.conversations = [
      { id: 'cv-9', account_id: 'acct-1', contact_id: 'ct-1', connection_id: 'c' },
    ];
    h.db.messages.push({
      conversation_id: 'cv-9',
      sender_type: 'customer',
      created_at: ago(3),
    });
    expect((await sweep()).lost).toBe(0);
  });
});

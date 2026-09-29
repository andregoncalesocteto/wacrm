import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: run }));

import { onJourneyEventAccepted, onOrderStatusChanged } from './event-hooks';

const db = {} as SupabaseClient;

beforeEach(() => run.mockReset());

describe('onJourneyEventAccepted', () => {
  it('dispatches the journey_event trigger with the event context', async () => {
    await onJourneyEventAccepted(db, {
      accountId: 'acct-1',
      eventId: 'ev-1',
      name: 'Purchase',
      occurredAt: new Date(),
      journeyId: 'jr-1',
      contactId: 'ct-1',
      conversationId: 'cv-1',
      connectionId: 'conn-1',
      stage: 'won',
      properties: { total: 10 },
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      accountId: 'acct-1',
      triggerType: 'journey_event',
      contactId: 'ct-1',
      context: {
        conversation_id: 'cv-1',
        connection_id: 'conn-1',
        journey_id: 'jr-1',
        journey_event_id: 'ev-1',
        journey_event_name: 'Purchase',
        journey_event_properties: { total: 10 },
        journey_stage: 'won',
      },
    });
  });

  it('defaults properties to an empty object', async () => {
    await onJourneyEventAccepted(db, {
      accountId: 'a',
      eventId: 'e',
      name: 'ViewContent',
      occurredAt: new Date(),
      journeyId: 'j',
      contactId: 'c',
      conversationId: 'v',
      connectionId: 'n',
      stage: 'browsing',
    });
    expect(run.mock.calls[0][0].context.journey_event_properties).toEqual({});
  });
});

describe('onJourneyEventAccepted order context', () => {
  it('a Purchase hands the order to the engine', async () => {
    await onJourneyEventAccepted(db, {
      accountId: 'acct-1',
      eventId: 'ev-1',
      name: 'Purchase',
      occurredAt: new Date(),
      journeyId: 'jr-1',
      contactId: 'ct-1',
      conversationId: 'cv-1',
      connectionId: 'conn-1',
      stage: 'won',
      properties: {
        orderId: 'PED-1',
        currency: 'BRL',
        value: 50,
        items: [{ id: 'a', quantity: 1 }],
      },
    });
    expect(run.mock.calls[0][0].context.order).toEqual({
      external_id: 'PED-1',
      status: 'placed',
      value: 50,
      currency: 'BRL',
      items: [{ id: 'a', quantity: 1 }],
    });
  });

  it('other events carry no order', async () => {
    await onJourneyEventAccepted(db, {
      accountId: 'a',
      eventId: 'e',
      name: 'AddToCart',
      occurredAt: new Date(),
      journeyId: 'j',
      contactId: 'c',
      conversationId: 'v',
      connectionId: 'n',
      stage: 'cart',
      properties: { orderId: 'x' },
    });
    expect(run.mock.calls[0][0].context).not.toHaveProperty('order');
  });
});

describe('onOrderStatusChanged', () => {
  const orderDb = (row: unknown, error: unknown = null) => {
    const eqs: [string, unknown][] = [];
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => (eqs.push([c, v]), q),
      maybeSingle: () => Promise.resolve({ data: row, error }),
    };
    return { db: { from: vi.fn(() => q) } as unknown as SupabaseClient, eqs };
  };
  const change = {
    accountId: 'acct-1',
    orderId: 'ord-1',
    externalOrderId: 'PED-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    connectionId: 'conn-1',
    journeyId: 'jr-1',
    dealId: null,
    previousStatus: 'received' as const,
    status: 'preparing' as const,
    occurredAt: new Date(),
    eventId: 'ev-9',
  };

  it('dispatches order_status_changed with the order, scoped by account', async () => {
    const { db: d, eqs } = orderDb({
      value: 89.8,
      currency: 'BRL',
      items: [{ id: 'a' }],
    });
    await onOrderStatusChanged(d, change);
    expect(eqs).toEqual([
      ['id', 'ord-1'],
      ['account_id', 'acct-1'],
    ]);
    expect(run).toHaveBeenCalledWith({
      accountId: 'acct-1',
      triggerType: 'order_status_changed',
      contactId: 'ct-1',
      context: {
        conversation_id: 'cv-1',
        connection_id: 'conn-1',
        journey_id: 'jr-1',
        order: {
          external_id: 'PED-1',
          status: 'preparing',
          previous_status: 'received',
          value: 89.8,
          currency: 'BRL',
          items: [{ id: 'a' }],
        },
      },
    });
  });

  it('still dispatches when the order read fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db: d } = orderDb(null, { message: 'boom' });
    await onOrderStatusChanged(d, { ...change, conversationId: null });
    expect(run.mock.calls[0][0].context).toEqual({
      connection_id: 'conn-1',
      journey_id: 'jr-1',
      order: expect.objectContaining({
        external_id: 'PED-1',
        value: null,
        items: [],
      }),
    });
    spy.mockRestore();
  });
});

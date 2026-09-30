import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepestStepReached, journeyFunnel } from './funnel';

type Row = Record<string, unknown>;

/** Minimal read-only fake: select / eq / order / range over in-memory tables. */
function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      const q = {
        select: () => q,
        eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
        order: () => q,
        range: (from: number, to: number) =>
          Promise.resolve({
            data: (tables[table] ?? [])
              .filter((r) => filters.every((f) => f(r)))
              .slice(from, to + 1),
            error: null,
          }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const T = '2026-06-01T10:00:00.000Z';
let n = 0;
const journey = (account: string, connection: string, over: Row = {}): Row => ({
  id: `j${++n}`,
  account_id: account,
  connection_id: connection,
  stage: 'link_sent',
  first_view_content_at: null,
  last_add_to_cart_at: null,
  checkout_started_at: null,
  purchased_at: null,
  ...over,
});
const times = (k: 'browsing' | 'cart' | 'checkout' | 'won'): Row => ({
  first_view_content_at: T,
  ...(k !== 'browsing' ? { last_add_to_cart_at: T } : {}),
  ...(k === 'checkout' || k === 'won' ? { checkout_started_at: T } : {}),
  ...(k === 'won' ? { purchased_at: T } : {}),
  stage: k,
});
const many = (count: number, make: () => Row) =>
  Array.from({ length: count }, make);

describe('deepestStepReached', () => {
  const base = journey('a', 'c') as never;
  it('a Purchase alone reaches every step', () => {
    expect(
      deepestStepReached({
        ...(base as object),
        purchased_at: T,
        stage: 'won',
      } as never)
    ).toBe(4);
  });
  it('a lost Journey keeps the deepest step it reached', () => {
    expect(
      deepestStepReached({
        ...(base as object),
        last_add_to_cart_at: T,
        stage: 'lost',
      } as never)
    ).toBe(2);
  });
  it('lost with no milestone only reached "link sent"', () => {
    expect(
      deepestStepReached({ ...(base as object), stage: 'lost' } as never)
    ).toBe(0);
  });
});

describe('journeyFunnel', () => {
  // WhatsApp @ Centro: 10 link_sent, 4 browsing, 3 cart, 2 checkout, 1 won
  //   plus 2 lost (one had reached cart, one only the link).
  // Telegram @ Centro: 2 link_sent, 2 won.
  // WhatsApp @ Praia: 5 link_sent, 1 browsing.
  // Another account: 3 won (must not leak in).
  const tables: Record<string, Row[]> = {
    stores: [
      { id: 's1', account_id: 'a', name: 'Centro' },
      { id: 's2', account_id: 'a', name: 'Praia' },
      { id: 's9', account_id: 'b', name: 'Other' },
    ],
    channel_connections: [
      {
        id: 'wa1',
        account_id: 'a',
        channel_type: 'whatsapp_cloud',
        store_id: 's1',
      },
      { id: 'tg1', account_id: 'a', channel_type: 'telegram', store_id: 's1' },
      {
        id: 'wa2',
        account_id: 'a',
        channel_type: 'whatsapp_cloud',
        store_id: 's2',
      },
      {
        id: 'x1',
        account_id: 'b',
        channel_type: 'whatsapp_cloud',
        store_id: 's9',
      },
    ],
    journeys: [
      ...many(10, () => journey('a', 'wa1')),
      ...many(4, () => journey('a', 'wa1', times('browsing'))),
      ...many(3, () => journey('a', 'wa1', times('cart'))),
      ...many(2, () => journey('a', 'wa1', times('checkout'))),
      journey('a', 'wa1', times('won')),
      journey('a', 'wa1', { ...times('cart'), stage: 'lost' }),
      journey('a', 'wa1', { stage: 'lost' }),
      ...many(2, () => journey('a', 'tg1', times('won'))),
      ...many(5, () => journey('a', 'wa2')),
      journey('a', 'wa2', times('browsing')),
      ...many(3, () => journey('b', 'x1', times('won'))),
    ],
  };

  it('counts each step as "in it or beyond" and the conversion to Bought', async () => {
    const f = await journeyFunnel(fakeDb(tables), { accountId: 'a' });

    expect(f.total.reached).toEqual({
      link_sent: 30,
      browsing: 4 + 3 + 2 + 1 + 1 + 2 + 1 + 0, // 14
      cart: 3 + 2 + 1 + 1 + 2, // 9
      checkout: 2 + 1 + 2, // 5
      won: 1 + 2, // 3
    });
    expect(f.total.reached.browsing).toBe(14);
    expect(f.total.lost).toBe(2);
    expect(f.total.conversion).toBeCloseTo(3 / 30);
  });

  it('groups by channel type', async () => {
    const f = await journeyFunnel(fakeDb(tables), { accountId: 'a' });
    const wa = f.byChannel.find((g) => g.key === 'whatsapp_cloud')!;
    const tg = f.byChannel.find((g) => g.key === 'telegram')!;

    expect(wa.reached).toEqual({
      link_sent: 28,
      browsing: 12,
      cart: 7,
      checkout: 3,
      won: 1,
    });
    expect(wa.lost).toBe(2);
    expect(wa.conversion).toBeCloseTo(1 / 28);
    expect(tg.reached).toEqual({
      link_sent: 2,
      browsing: 2,
      cart: 2,
      checkout: 2,
      won: 2,
    });
    expect(tg.conversion).toBe(1);
    expect(f.byChannel.map((g) => g.key)).toEqual([
      'whatsapp_cloud',
      'telegram',
    ]);
  });

  it('groups by store, across channels, with the store name', async () => {
    const f = await journeyFunnel(fakeDb(tables), { accountId: 'a' });
    const centro = f.byStore.find((g) => g.label === 'Centro')!;
    const praia = f.byStore.find((g) => g.label === 'Praia')!;

    expect(centro.key).toBe('s1');
    expect(centro.reached.link_sent).toBe(24);
    expect(centro.reached.won).toBe(3);
    expect(centro.conversion).toBeCloseTo(3 / 24);
    expect(praia.reached).toEqual({
      link_sent: 6,
      browsing: 1,
      cart: 0,
      checkout: 0,
      won: 0,
    });
    expect(praia.conversion).toBe(0);
    expect(f.byStore.some((g) => g.label === 'Other')).toBe(false);
  });

  it('has no conversion without Journeys', async () => {
    const f = await journeyFunnel(fakeDb({}), { accountId: 'a' });
    expect(f.total.conversion).toBeNull();
    expect(f.byChannel).toEqual([]);
  });

  it('pages past 1000 rows', async () => {
    const big = { journeys: many(2100, () => journey('a', 'wa1')) };
    const f = await journeyFunnel(fakeDb({ ...tables, ...big }), {
      accountId: 'a',
    });
    expect(f.total.reached.link_sent).toBe(2100);
  });
});

describe('journeyFunnel with a direct Journey that has no connection', () => {
  it('counts it in the total and in its store, without breaking the channel groups', async () => {
    const db = fakeDb({
      journeys: [
        journey('a', 'c1', times('won')),
        journey('a', null as never, {
          ...times('cart'),
          store_id: 's1',
          link_sent_at: null,
        }),
      ],
      channel_connections: [
        { id: 'c1', account_id: 'a', channel_type: 'whatsapp_cloud', store_id: 's1' },
      ],
      stores: [{ id: 's1', account_id: 'a', name: 'Centro' }],
    });
    const funnel = await journeyFunnel(db, { accountId: 'a' });
    expect(funnel.total.reached.cart).toBe(2);
    expect(funnel.byChannel).toHaveLength(1);
    expect(funnel.byChannel[0].reached.cart).toBe(1);
    expect(funnel.byStore).toHaveLength(1);
    expect(funnel.byStore[0]).toMatchObject({ key: 's1', label: 'Centro' });
    expect(funnel.byStore[0].reached.cart).toBe(2);
  });
});

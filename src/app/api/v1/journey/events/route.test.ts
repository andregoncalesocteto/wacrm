/**
 * HTTP-level tests for POST /api/v1/journey/events (ticket #5). The key store
 * and the service-role client are stubbed; requireApiKey (scope + rate limit),
 * the route and the whole journeys module are real over the in-memory world.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { db, resetWorld, world } from '@/lib/channels/crm-world.fake';
import { generateApiKey } from '@/lib/api-keys/keys';
import type { ApiKeyRow } from '@/lib/api-keys/store';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const h = vi.hoisted(() => ({ key: null as unknown }));

vi.mock('@/lib/api-keys/store', () => ({
  findActiveKeyByHash: async () => h.key,
  touchLastUsed: () => {},
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => db }));

const hook = vi.hoisted(() => vi.fn());
vi.mock('@/lib/journeys/event-hooks', () => ({
  onJourneyEventAccepted: hook,
}));

const { POST } = await import('./route');

const KEY = generateApiKey().plaintext;
const DAY = 86_400_000;

function keyRow(scopes: string[], account = 'acct-1'): ApiKeyRow {
  return {
    id: 'key-1',
    account_id: account,
    created_by: 'user-1',
    name: 'k',
    scopes,
    expires_at: null,
    revoked_at: null,
  };
}

function send(body: unknown, opts: { raw?: string; auth?: boolean } = {}) {
  return POST(
    new Request('https://crm.example.com/api/v1/journey/events', {
      method: 'POST',
      headers: opts.auth === false ? {} : { authorization: `Bearer ${KEY}` },
      body: opts.raw ?? JSON.stringify(body),
    })
  );
}

let n = 0;
const ev = (name: string, extra: Record<string, unknown> = {}) => ({
  event_id: `evt-${++n}`,
  name,
  idtrack: 'tok-live',
  occurred_at: '2026-10-02T21:14:05Z',
  ...extra,
});
const item = (id: string, quantity = 1, unit_price = 10) => ({
  id,
  name: id,
  quantity,
  unit_price,
});
const cart = (value: number, items = [item('a')], at?: string) => ({
  ...(at ? { occurred_at: at } : {}),
  properties: { currency: 'BRL', cart: { value, items } },
});
const journeys = () => world.tables.journeys ?? [];
const deals = () => world.tables.deals ?? [];
const stageKey = (id: unknown) =>
  world.tables.pipeline_stages.find((s) => s.id === id)?.system_key;

beforeEach(() => {
  resetWorld();
  n = 0;
  hook.mockReset();
  __resetRateLimitForTests();
  h.key = keyRow(['events:write']);
  const future = new Date(Date.now() + DAY).toISOString();
  world.tables.accounts = [
    { id: 'acct-1', owner_user_id: 'owner-1', default_currency: 'BRL' },
  ];
  world.tables.contacts = [
    { id: 'ct-1', account_id: 'acct-1', name: 'Maria', phone: '5511' },
  ];
  world.tables.tracking_tokens = [
    {
      id: 't1',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      conversation_id: 'cv-1',
      connection_id: 'conn-1',
      token: 'tok-live',
      expires_at: future,
    },
    {
      id: 't2',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      conversation_id: 'cv-1',
      connection_id: 'conn-1',
      token: 'tok-old',
      expires_at: '2020-01-01T00:00:00Z',
    },
    {
      id: 't3',
      account_id: 'acct-2',
      contact_id: 'ct-9',
      conversation_id: 'cv-9',
      connection_id: 'conn-9',
      token: 'tok-other',
      expires_at: future,
    },
  ];
});

describe('happy path: the deal only moves forward', () => {
  it('ViewContent -> Navegando, AddToCart -> Carrinho, InitiateCheckout -> Checkout', async () => {
    let res = await send(ev('ViewContent'));
    expect(res.status).toBe(200);
    let { data } = await res.json();
    expect(data).toMatchObject({ stage: 'browsing', duplicate: false });
    expect(stageKey(deals()[0].stage_id)).toBe('browsing');

    res = await send(ev('AddToCart', cart(20, [item('a', 2)])));
    ({ data } = await res.json());
    expect(data.stage).toBe('cart');
    expect(stageKey(deals()[0].stage_id)).toBe('cart');

    res = await send(ev('InitiateCheckout', cart(20, [item('a', 2)])));
    ({ data } = await res.json());
    expect(data.stage).toBe('checkout');
    expect(stageKey(deals()[0].stage_id)).toBe('checkout');
    expect(journeys()).toHaveLength(1);
    expect(deals()).toHaveLength(1);
    expect(data.journey_id).toBe(journeys()[0].id);
  });

  it('ViewContent marks Navegando once; the rest only count', async () => {
    await send(ev('ViewContent', { occurred_at: '2026-10-02T21:00:00Z' }));
    await send(ev('ViewContent', { occurred_at: '2026-10-02T21:05:00Z' }));
    expect(journeys()[0].view_content_count).toBe(2);
    expect(journeys()[0].first_view_content_at).toBe(
      '2026-10-02T21:00:00.000Z'
    );
    expect(journeys()[0].stage).toBe('browsing');
  });

  it('several AddToCart with different ids replace the cart snapshot', async () => {
    await send(ev('AddToCart', cart(10, [item('a')], '2026-10-02T21:00:00Z')));
    await send(
      ev(
        'AddToCart',
        cart(45, [item('a'), item('b', 3, 10)], '2026-10-02T21:01:00Z')
      )
    );
    expect(journeys()[0]).toMatchObject({
      cart_value: 45,
      cart_items_count: 4,
      cart_currency: 'BRL',
      stage: 'cart',
    });
    expect(journeys()[0].cart_items).toHaveLength(2);
    expect(deals()[0]).toMatchObject({ value: 45, currency: 'BRL' });
  });

  it('AddToCart after InitiateCheckout updates the cart without stepping back', async () => {
    await send(
      ev('InitiateCheckout', cart(10, [item('a')], '2026-10-02T21:00:00Z'))
    );
    const res = await send(
      ev(
        'AddToCart',
        cart(30, [item('a'), item('b', 2)], '2026-10-02T21:02:00Z')
      )
    );
    expect((await res.json()).data.stage).toBe('checkout');
    expect(journeys()[0].cart_value).toBe(30);
    expect(deals()[0].value).toBe(30);
    expect(stageKey(deals()[0].stage_id)).toBe('checkout');
  });

  it('an out-of-order event neither steps back nor overwrites a newer cart', async () => {
    await send(ev('AddToCart', cart(50, [item('a')], '2026-10-02T21:10:00Z')));
    await send(ev('AddToCart', cart(5, [item('a')], '2026-10-02T21:00:00Z')));
    await send(
      ev('InitiateCheckout', cart(60, [item('a')], '2026-10-02T21:20:00Z'))
    );
    const res = await send(
      ev('ViewContent', { occurred_at: '2026-10-02T20:00:00Z' })
    );
    expect((await res.json()).data.stage).toBe('checkout');
    expect(journeys()[0].cart_value).toBe(60);
  });

  it('stamps last_event_at on every accepted event', async () => {
    await send(ev('ViewContent'));
    const first = journeys()[0].last_event_at;
    expect(first).toBeTruthy();
    journeys()[0].last_event_at = '2000-01-01T00:00:00.000Z';
    await send(ev('ViewContent'));
    expect(journeys()[0].last_event_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('an event on a token whose Journey is closed opens a new Journey and deal', async () => {
    await send(ev('ViewContent'));
    journeys()[0].state = 'won';
    deals()[0].status = 'won';
    const res = await send(ev('ViewContent'));
    expect(res.status).toBe(200);
    expect(journeys()).toHaveLength(2);
    expect(deals()).toHaveLength(2);
    expect((await res.json()).data.journey_id).toBe(journeys()[1].id);
    expect(journeys()[1]).toMatchObject({ state: 'open', stage: 'browsing' });
  });

  it('an event never counts as a link sent on an open Journey', async () => {
    await send(ev('ViewContent'));
    await send(ev('AddToCart', cart(10)));
    expect(journeys()[0].link_count).toBe(1);
  });

  it('calls the accepted-event hook once per new event', async () => {
    const body = ev('ViewContent');
    await send(body);
    await send(body);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][1]).toMatchObject({
      accountId: 'acct-1',
      name: 'ViewContent',
      stage: 'browsing',
      contactId: 'ct-1',
    });
  });

  it('a failing hook does not fail the accepted event', async () => {
    hook.mockRejectedValueOnce(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await send(ev('ViewContent'))).status).toBe(200);
    spy.mockRestore();
  });
});

const purchaseProps = (order_id = 'PED-1', extra = {}) => ({
  properties: {
    order_id,
    currency: 'BRL',
    value: 89.8,
    items: [item('pizza', 1, 59.9), item('refri', 1, 29.9)],
    ...extra,
  },
});
const orders = () => world.tables.orders ?? [];

describe('Purchase', () => {
  it('creates the order, closes the Journey as won and moves the deal to Comprou', async () => {
    await send(ev('AddToCart', cart(89.8)));
    const res = await send(
      ev('Purchase', {
        occurred_at: '2026-10-02T21:22:11Z',
        ...purchaseProps(),
      })
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({ stage: 'won', duplicate: false });

    expect(orders()).toHaveLength(1);
    expect(orders()[0]).toMatchObject({
      account_id: 'acct-1',
      external_order_id: 'PED-1',
      contact_id: 'ct-1',
      conversation_id: 'cv-1',
      connection_id: 'conn-1',
      journey_id: journeys()[0].id,
      deal_id: deals()[0].id,
      idtrack: 'tok-live',
      status: 'placed',
      value: 89.8,
      currency: 'BRL',
      placed_at: '2026-10-02T21:22:11.000Z',
    });
    expect(orders()[0].items).toHaveLength(2);

    expect(journeys()).toHaveLength(1);
    expect(journeys()[0]).toMatchObject({
      state: 'won',
      stage: 'won',
      purchased_at: '2026-10-02T21:22:11.000Z',
    });
    expect(journeys()[0].closed_at).toBeTruthy();
    expect(deals()[0]).toMatchObject({
      status: 'won',
      value: 89.8,
      currency: 'BRL',
    });
    expect(stageKey(deals()[0].stage_id)).toBe('won');
    expect(
      world.tables.pipeline_stages.find((st) => st.id === deals()[0].stage_id)
        ?.name
    ).toBe('Comprou');
  });

  it('records the contact last purchase date and never moves it back', async () => {
    await send(
      ev('Purchase', {
        occurred_at: '2026-10-02T21:22:11Z',
        ...purchaseProps('A'),
      })
    );
    expect(world.tables.contacts[0].last_purchase_at).toBe(
      '2026-10-02T21:22:11.000Z'
    );
    await send(
      ev('Purchase', {
        occurred_at: '2026-10-01T10:00:00Z',
        ...purchaseProps('B'),
      })
    );
    expect(world.tables.contacts[0].last_purchase_at).toBe(
      '2026-10-02T21:22:11.000Z'
    );
  });

  it('a Purchase with no prior events opens a Journey and closes it as won', async () => {
    const res = await send(ev('Purchase', purchaseProps()));
    expect(res.status).toBe(200);
    expect(journeys()).toHaveLength(1);
    expect(journeys()[0].state).toBe('won');
    expect(deals()).toHaveLength(1);
    expect(deals()[0].status).toBe('won');
    expect(orders()).toHaveLength(1);
  });

  it('repeating the same event_id replays and creates nothing again', async () => {
    const body = ev('Purchase', purchaseProps());
    await send(body);
    const again = await send(body);
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect(orders()).toHaveLength(1);
    expect(journeys()).toHaveLength(1);
    expect(deals()).toHaveLength(1);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('a second Purchase with the same order_id and another event_id is a duplicate', async () => {
    const first = await send(ev('Purchase', purchaseProps('PED-1')));
    const firstData = (await first.json()).data;
    const res = await send(ev('Purchase', purchaseProps('PED-1')));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      journey_id: firstData.journey_id,
      stage: 'won',
      duplicate: true,
    });
    expect(orders()).toHaveLength(1);
    expect(journeys()).toHaveLength(1);
    expect(deals()).toHaveLength(1);
    expect(hook).toHaveBeenCalledTimes(1);
    // the duplicate event_id is itself idempotent afterwards
    expect(world.tables.journey_events).toHaveLength(2);
  });

  it('the same order_id is unique per account, not global', async () => {
    world.tables.orders = [
      {
        id: 'o-x',
        account_id: 'acct-2',
        external_order_id: 'PED-1',
        journey_id: 'j-x',
      },
    ];
    const res = await send(ev('Purchase', purchaseProps('PED-1')));
    expect(res.status).toBe(200);
    expect((await res.json()).data.duplicate).toBe(false);
    expect(orders()).toHaveLength(2);
  });

  it('a new event on the same token after the Purchase opens a new Journey and deal', async () => {
    await send(ev('Purchase', purchaseProps()));
    const res = await send(ev('ViewContent'));
    expect(res.status).toBe(200);
    expect(journeys()).toHaveLength(2);
    expect(deals()).toHaveLength(2);
    expect(journeys()[1]).toMatchObject({ state: 'open', stage: 'browsing' });
    expect(deals()[1].status).toBe('open');
    expect(deals()[0].status).toBe('won');
    expect(orders()).toHaveLength(1);
  });

  it('a Purchase on a lost Journey opens a new one and wins it, leaving the lost one alone', async () => {
    await send(ev('ViewContent'));
    journeys()[0].state = 'lost';
    journeys()[0].stage = 'lost';
    deals()[0].status = 'lost';
    const res = await send(ev('Purchase', purchaseProps()));
    expect(res.status).toBe(200);
    expect(journeys()).toHaveLength(2);
    expect(journeys()[0]).toMatchObject({ state: 'lost', stage: 'lost' });
    expect(deals()[0].status).toBe('lost');
    expect(journeys()[1]).toMatchObject({ state: 'won', stage: 'won' });
    expect(deals()[1].status).toBe('won');
    expect(orders()[0].journey_id).toBe(journeys()[1].id);
  });

  it('a failure before the Journey closes is finished by the retry, once', async () => {
    const body = ev('Purchase', purchaseProps());
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realUpdate = db.from.bind(db);
    // Fail the deal update once, after the order was inserted.
    let failed = false;
    const fromSpy = vi.spyOn(db, 'from').mockImplementation(((t: string) => {
      const q = realUpdate(t);
      if (t === 'deals' && !failed) {
        const update = q.update.bind(q);
        q.update = ((p: Record<string, unknown>) => {
          if ('value' in p && !failed) {
            failed = true;
            throw new Error('boom');
          }
          return update(p);
        }) as typeof q.update;
      }
      return q;
    }) as typeof db.from);
    expect((await send(body)).status).toBe(500);
    fromSpy.mockRestore();
    spy.mockRestore();
    expect(orders()).toHaveLength(1);
    expect(journeys()[0].state).toBe('open');

    const res = await send(body);
    expect(res.status).toBe(200);
    expect(orders()).toHaveLength(1);
    expect(journeys()).toHaveLength(1);
    expect(journeys()[0].state).toBe('won');
    expect(deals()[0]).toMatchObject({ status: 'won', value: 89.8 });
  });

  it('calls the accepted-event hook with the order properties', async () => {
    await send(ev('Purchase', purchaseProps()));
    expect(hook.mock.calls[0][1]).toMatchObject({
      name: 'Purchase',
      stage: 'won',
    });
  });

  it.each([
    ['no properties', ev('Purchase'), 'properties'],
    [
      'missing order_id',
      ev('Purchase', purchaseProps('', {})),
      'properties.order_id',
    ],
    [
      'bad currency',
      ev('Purchase', purchaseProps('P', { currency: 'REAL' })),
      'properties.currency',
    ],
    [
      'string value',
      ev('Purchase', purchaseProps('P', { value: '9' })),
      'properties.value',
    ],
    [
      'negative value',
      ev('Purchase', purchaseProps('P', { value: -1 })),
      'properties.value',
    ],
    [
      'no items',
      ev('Purchase', purchaseProps('P', { items: [] })),
      'properties.items',
    ],
    [
      'bad item quantity',
      ev('Purchase', purchaseProps('P', { items: [item('a', 0)] })),
      'properties.items[0].quantity',
    ],
  ])('400 with a clear message: %s', async (_l, body, field) => {
    const res = await send(body);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('bad_request');
    expect(error.message).toContain(field);
    expect(orders()).toHaveLength(0);
    expect(journeys()).toHaveLength(0);
  });
});

describe('idempotency by event_id', () => {
  it('replays the original response without repeating effects', async () => {
    await send(ev('ViewContent'));
    const body = ev('AddToCart', cart(20, [item('a', 2)]));
    const first = await send(body);
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();
    const original = (await first.json()).data;

    // The cart changes, then the same event is re-sent: it must not undo it.
    await send(ev('AddToCart', cart(99, [item('z')], '2026-10-02T22:00:00Z')));
    const second = await send(body);
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replayed')).toBe('true');
    expect((await second.json()).data).toEqual({
      ...original,
      duplicate: true,
    });
    expect(journeys()[0].cart_value).toBe(99);
    expect(world.tables.journey_events).toHaveLength(3);
  });

  it('replays even after the idtrack has expired', async () => {
    const body = ev('ViewContent');
    await send(body);
    world.tables.tracking_tokens[0].expires_at = '2020-01-01T00:00:00Z';
    const res = await send(body);
    expect(res.status).toBe(200);
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
  });

  it('two simultaneous requests with the same event_id apply the effects once', async () => {
    const body = ev('ViewContent');
    const [a, b] = await Promise.all([send(body), send(body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const replays = [a, b].filter(
      (r) => r.headers.get('Idempotent-Replayed') === 'true'
    );
    expect(replays).toHaveLength(1);
    expect(journeys()).toHaveLength(1);
    expect(journeys()[0].view_content_count).toBe(1);
    expect(world.tables.journey_events).toHaveLength(1);
  });

  it('is scoped by account: the same event_id in another account is a new event', async () => {
    const body = ev('ViewContent', { idtrack: 'tok-other' });
    world.tables.journey_events = [
      {
        id: 'x',
        account_id: 'acct-2',
        event_id: body.event_id,
        name: 'ViewContent',
        response: { event_id: body.event_id, journey_id: 'j', stage: 'cart' },
      },
    ];
    // acct-1 key with acct-2's token: invalid, and acct-2's event is not replayed.
    const res = await send(body);
    expect(res.status).toBe(404);
  });

  it('releases the event_id when processing fails, so a retry is processed', async () => {
    world.tables.accounts = []; // the audit user cannot be resolved
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = ev('ViewContent');
    expect((await send(body)).status).toBe(500);
    expect(world.tables.journey_events).toHaveLength(0);
    world.tables.accounts = [{ id: 'acct-1', owner_user_id: 'owner-1' }];
    expect((await send(body)).status).toBe(200);
    spy.mockRestore();
  });
});

describe('errors', () => {
  it("404 idtrack_not_found for an unknown token and for another account's token", async () => {
    for (const idtrack of ['nope', 'tok-other']) {
      const res = await send(ev('ViewContent', { idtrack }));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('idtrack_not_found');
    }
    expect(journeys()).toHaveLength(0);
  });

  it('410 idtrack_expired for an expired token', async () => {
    const res = await send(ev('ViewContent', { idtrack: 'tok-old' }));
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe('idtrack_expired');
    expect(journeys()).toHaveLength(0);
    expect(world.tables.journey_events ?? []).toHaveLength(0);
  });

  it('400 for an unknown name, and for names not supported yet', async () => {
    for (const name of ['Bogus', 'OrderStatusChanged']) {
      const res = await send(ev(name));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    }
    expect(journeys()).toHaveLength(0);
  });

  it.each([
    ['not JSON', undefined, '{oops'],
    ['array body', [], undefined],
    [
      'missing event_id',
      { ...ev('ViewContent'), event_id: undefined },
      undefined,
    ],
    ['missing idtrack', { ...ev('ViewContent'), idtrack: '' }, undefined],
    [
      'occurred_at not UTC',
      ev('ViewContent', { occurred_at: '2026-10-02T21:14:05-03:00' }),
      undefined,
    ],
    [
      'occurred_at garbage',
      ev('ViewContent', { occurred_at: 'yesterday' }),
      undefined,
    ],
    ['AddToCart without properties', ev('AddToCart'), undefined],
    [
      'bad currency',
      ev('AddToCart', {
        properties: {
          currency: 'REAL',
          cart: { value: 1, items: [item('a')] },
        },
      }),
      undefined,
    ],
    ['empty items', ev('AddToCart', cart(0, [])), undefined],
    ['negative value', ev('InitiateCheckout', cart(-1)), undefined],
    ['zero quantity', ev('AddToCart', cart(1, [item('a', 0)])), undefined],
    [
      'string value',
      ev('AddToCart', {
        properties: {
          currency: 'BRL',
          cart: { value: '9', items: [item('a')] },
        },
      }),
      undefined,
    ],
  ])('400 bad_request: %s', async (_label, body, raw) => {
    const res = await send(body, { raw });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('bad_request');
    expect(error.message.length).toBeGreaterThan(10);
    expect(journeys()).toHaveLength(0);
  });

  it('names the offending field', async () => {
    const res = await send(ev('AddToCart', cart(1, [item('a', 1.5)])));
    expect((await res.json()).error.message).toContain(
      'properties.cart.items[0].quantity'
    );
  });
});

describe('authorization', () => {
  it('401 without a key, and nothing is written', async () => {
    const res = await send(ev('ViewContent'), { auth: false });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
    expect(journeys()).toHaveLength(0);
  });

  it('401 for an unknown/revoked key', async () => {
    h.key = null;
    expect((await send(ev('ViewContent'))).status).toBe(401);
  });

  it('403 for a key without events:write, and nothing is written', async () => {
    h.key = keyRow(['contacts:read', 'messages:read', 'conversations:read']);
    const res = await send(ev('ViewContent'));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(journeys()).toHaveLength(0);
    expect(world.tables.journey_events ?? []).toHaveLength(0);
  });

  it("a key of another account cannot use this account's token", async () => {
    h.key = keyRow(['events:write'], 'acct-2');
    const res = await send(ev('ViewContent'));
    expect(res.status).toBe(404);
    expect(journeys()).toHaveLength(0);
  });

  it('429 after the per-key rate limit (120/min)', async () => {
    let last = 200;
    for (let i = 0; i < 121; i++) {
      last = (await send(ev('ViewContent'))).status;
    }
    expect(last).toBe(429);
  });
});

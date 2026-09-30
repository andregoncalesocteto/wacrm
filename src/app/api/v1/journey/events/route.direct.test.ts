/**
 * HTTP-level tests for the DIRECT events of POST /api/v1/journey/events
 * (direct-order-events, ticket #18): no `idtrack`, the customer is identified
 * by `store_key` + `customer.phone`. Same harness as route.test.ts: the key
 * store and the service-role client are stubbed, everything else is real over
 * the in-memory world.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
const statusHook = vi.hoisted(() => vi.fn());
vi.mock('@/lib/journeys/event-hooks', () => ({
  onJourneyEventAccepted: hook,
  onOrderStatusChanged: statusHook,
}));

const { POST } = await import('./route');

const KEY = generateApiKey().plaintext;
const PHONE = '+5511999998888';
const DIGITS = '5511999998888';

const keyRow: ApiKeyRow = {
  id: 'key-1',
  account_id: 'acct-1',
  created_by: 'user-1',
  name: 'k',
  scopes: ['events:write'],
  expires_at: null,
  revoked_at: null,
};

const send = (body: unknown) =>
  POST(
    new Request('https://crm.example.com/api/v1/journey/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    })
  );

let n = 0;
const direct = (name: string, extra: Record<string, unknown> = {}) => ({
  event_id: `evt-${++n}`,
  name,
  store_key: '89/RPA/BLC',
  customer: { phone: PHONE },
  occurred_at: '2026-10-02T21:14:05Z',
  ...extra,
});
const item = { id: 'pizza', name: 'Pizza', quantity: 1, unit_price: 59.9 };
const purchase = (orderId = 'PED-1', extra: Record<string, unknown> = {}) =>
  direct('Purchase', {
    properties: {
      order_id: orderId,
      currency: 'BRL',
      value: 59.9,
      items: [item],
    },
    ...extra,
  });
const cart = {
  properties: { currency: 'BRL', cart: { value: 59.9, items: [item] } },
};

const t = (name: string) => world.tables[name] ?? [];
const stageKey = (id: unknown) =>
  t('pipeline_stages').find((s) => s.id === id)?.system_key;

function seedConnection(connected = true) {
  world.tables.channel_connections = connected
    ? [
        {
          id: 'conn-1',
          account_id: 'acct-1',
          store_id: 'store-1',
          channel_type: 'whatsapp_cloud',
          external_id: 'pn-1',
          status: 'connected',
          disabled_at: null,
        },
      ]
    : [];
}

/** The customer already wrote to the CRM (implicit consent). */
function seedInbound() {
  world.tables.contacts = [
    { id: 'ct-1', account_id: 'acct-1', name: 'Maria', phone: DIGITS },
  ];
  world.tables.contact_identities = [
    {
      account_id: 'acct-1',
      contact_id: 'ct-1',
      kind: 'whatsapp:phone',
      external_id: DIGITS,
    },
  ];
  world.tables.conversations = [
    {
      id: 'cv-1',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      connection_id: 'conn-1',
    },
  ];
  world.tables.messages = [
    {
      id: 'm-1',
      conversation_id: 'cv-1',
      sender_type: 'customer',
      content_text: 'oi',
    },
  ];
}

beforeEach(() => {
  // The consents below are dated up to 2026-10-09; `given_at` may not be in the future.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-10T00:00:00Z'));
  resetWorld();
  n = 0;
  hook.mockReset();
  statusHook.mockReset();
  __resetRateLimitForTests();
  h.key = keyRow;
  world.tables.accounts = [
    { id: 'acct-1', owner_user_id: 'owner-1', default_currency: 'BRL' },
    { id: 'acct-2', owner_user_id: 'owner-2', default_currency: 'BRL' },
  ];
  world.tables.stores = [
    {
      id: 'store-1',
      account_id: 'acct-1',
      name: 'Bella Capri Centro',
      store_key_normalized: '89/rpa/blc',
      notification_connection_id: null,
    },
    {
      id: 'store-9',
      account_id: 'acct-2',
      name: 'Other account',
      store_key_normalized: '77/oth/xyz',
      notification_connection_id: null,
    },
  ];
  seedConnection();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('identification', () => {
  it('Purchase with store_key + phone creates contact, direct Journey and order', async () => {
    const res = await send(
      purchase('PED-1', { customer: { phone: PHONE, name: 'Maria Souza' } })
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toMatchObject({
      stage: 'won',
      duplicate: false,
      messaging: 'no_consent',
    });

    const contacts = t('contacts');
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      account_id: 'acct-1',
      name: 'Maria Souza',
      phone: DIGITS,
      source: 'menu',
    });
    expect(t('contact_identities')).toContainEqual(
      expect.objectContaining({
        contact_id: contacts[0].id,
        kind: 'whatsapp:phone',
        external_id: DIGITS,
      })
    );

    const [journey] = t('journeys');
    expect(journey).toMatchObject({
      id: data.journey_id,
      origin: 'menu_direct',
      link_sent_at: null,
      contact_id: contacts[0].id,
      connection_id: 'conn-1',
      store_id: 'store-1',
      state: 'won',
      stage: 'won',
    });
    expect(t('orders')).toHaveLength(1);
    expect(t('orders')[0]).toMatchObject({
      external_order_id: 'PED-1',
      contact_id: contacts[0].id,
      journey_id: journey.id,
      idtrack: null,
    });
    expect(stageKey(t('deals')[0].stage_id)).toBe('won');
  });

  it('reuses the contact of the same phone and never overwrites its name', async () => {
    seedInbound();
    const res = await send(
      purchase('PED-1', { customer: { phone: PHONE, name: 'Another Name' } })
    );
    expect(res.status).toBe(200);
    expect(t('contacts')).toHaveLength(1);
    expect(t('contacts')[0].name).toBe('Maria');
    expect(t('journeys')[0].contact_id).toBe('ct-1');
    expect((await res.json()).data.messaging).toBe('eligible');
  });

  it('finds the contact by a differently formatted stored phone', async () => {
    world.tables.contacts = [
      { id: 'ct-1', account_id: 'acct-1', name: 'Maria', phone: DIGITS },
    ];
    const res = await send(direct('ViewContent'));
    expect(res.status).toBe(200);
    expect(t('contacts')).toHaveLength(1);
    expect(t('journeys')[0].contact_id).toBe('ct-1');
  });

  it('answers 400 without idtrack and without store_key + phone', async () => {
    const bodies = [
      {
        event_id: 'e1',
        name: 'ViewContent',
        occurred_at: '2026-10-02T21:14:05Z',
      },
      direct('ViewContent', { customer: undefined }),
      direct('ViewContent', { store_key: undefined }),
      direct('ViewContent', { customer: { name: 'Only a name' } }),
    ];
    for (const body of bodies) {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('bad_request');
    }
    expect(t('contacts')).toHaveLength(0);
    expect(t('journey_events')).toHaveLength(0);
  });

  it.each([
    '11999998888',
    '5511999998888',
    '+0511999998888',
    '+55 11 99999-8888',
    '+123',
  ])('rejects the phone %s (not E.164)', async (phone) => {
    const res = await send(direct('ViewContent', { customer: { phone } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('customer.phone');
    expect(t('contacts')).toHaveLength(0);
  });

  it('answers 404 store_not_found for an unknown key and leaves nothing behind', async () => {
    const res = await send(direct('ViewContent', { store_key: '1/X/Y' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('store_not_found');
    expect(t('contacts')).toHaveLength(0);
    expect(t('journey_events')).toHaveLength(0);
  });

  it('does not see the store of another account', async () => {
    const res = await send(direct('ViewContent', { store_key: '77/OTH/XYZ' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('store_not_found');
  });

  it('matches the key ignoring case and edge spaces', async () => {
    const res = await send(
      direct('ViewContent', { store_key: ' 89/rpa/BLC ' })
    );
    expect(res.status).toBe(200);
  });

  it('validates the format of consent', async () => {
    const bad = [
      { notifications: 'yes', given_at: '2026-10-02T21:10:00Z' },
      { marketing: 1, given_at: '2026-10-02T21:10:00Z' },
      { notifications: true, given_at: '2026-10-02 21:10' },
      { notifications: true, given_at: '2026-10-02T21:10:00-03:00' },
      'true',
    ];
    for (const consent of bad) {
      const res = await send(direct('ViewContent', { consent }));
      expect(res.status).toBe(400);
    }
    expect(t('contact_consents')).toHaveLength(0);
  });

  it('rejects a given_at more than 5 minutes in the future and accepts a small skew', async () => {
    const now = Date.now();
    const future = new Date(now + 6 * 60_000).toISOString();
    const res = await send(
      direct('ViewContent', {
        consent: { notifications: true, given_at: future },
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('consent.given_at');
    expect(body.error.message).toContain('future');
    expect(t('contact_consents')).toHaveLength(0);
    expect(t('contacts')).toHaveLength(0);

    const skew = new Date(now + 4 * 60_000).toISOString();
    const ok = await send(
      direct('ViewContent', {
        consent: { notifications: true, given_at: skew },
      })
    );
    expect(ok.status).toBe(200);
  });
});

describe('consent stored on the contact', () => {
  const T1 = '2026-10-02T21:10:00Z';
  const consentOf = (purpose: string) =>
    t('contact_consents').find((r) => r.purpose === purpose);

  it('notifications: true with given_at activates it, stores date and source menu, and answers eligible', async () => {
    const res = await send(
      purchase('PED-1', {
        consent: { notifications: true, given_at: T1 },
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data.messaging).toBe('eligible');
    expect(consentOf('notifications')).toMatchObject({
      account_id: 'acct-1',
      contact_id: t('contacts')[0].id,
      granted: true,
      given_at: '2026-10-02T21:10:00.000Z',
      revoked_at: null,
      source: 'menu',
    });
    expect(consentOf('marketing')).toBeUndefined();
  });

  it('a given_at that is not newer changes nothing', async () => {
    await send(
      direct('ViewContent', { consent: { notifications: true, given_at: T1 } })
    );
    for (const given_at of ['2026-10-02T21:10:00Z', '2026-10-01T00:00:00Z']) {
      const res = await send(
        direct('ViewContent', { consent: { notifications: false, given_at } })
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.messaging).toBe('eligible');
    }
    expect(consentOf('notifications')).toMatchObject({
      granted: true,
      given_at: '2026-10-02T21:10:00.000Z',
      revoked_at: null,
    });
  });

  it('an explicit false revokes only that purpose (revoked_at = given_at)', async () => {
    await send(
      direct('ViewContent', {
        consent: { notifications: true, marketing: true, given_at: T1 },
      })
    );
    const res = await send(
      direct('ViewContent', {
        consent: { marketing: false, given_at: '2026-10-03T08:00:00Z' },
      })
    );
    expect(res.status).toBe(200);
    expect(consentOf('marketing')).toMatchObject({
      granted: false,
      given_at: '2026-10-02T21:10:00.000Z',
      revoked_at: '2026-10-03T08:00:00.000Z',
      source: 'menu',
    });
    expect(consentOf('notifications')).toMatchObject({ granted: true });
    expect((await res.json()).data.messaging).toBe('eligible');
  });

  it('revoking notifications answers no_consent, even for someone who wrote', async () => {
    seedInbound();
    const res = await send(
      direct('ViewContent', {
        consent: { notifications: false, given_at: T1 },
      })
    );
    expect((await res.json()).data.messaging).toBe('no_consent');
    // and the revocation holds for the next event, which carries no consent
    const next = await send(direct('ViewContent'));
    expect((await next.json()).data.messaging).toBe('no_consent');
  });

  it('an event without consent, or without a purpose, changes nothing', async () => {
    await send(
      direct('ViewContent', {
        consent: { notifications: true, marketing: true, given_at: T1 },
      })
    );
    const before = JSON.stringify(t('contact_consents'));
    for (const consent of [
      undefined,
      null,
      {},
      { given_at: '2026-10-09T00:00:00Z' },
    ]) {
      const res = await send(direct('ViewContent', { consent }));
      expect(res.status).toBe(200);
    }
    const res = await send(
      direct('ViewContent', {
        consent: { notifications: true, given_at: '2026-10-09T00:00:00Z' },
      })
    );
    expect(res.status).toBe(200);
    expect(consentOf('marketing')).toMatchObject({ granted: true });
    expect(JSON.stringify(consentOf('marketing'))).toBe(
      JSON.stringify(
        JSON.parse(before).find(
          (r: { purpose: string }) => r.purpose === 'marketing'
        )
      )
    );
  });

  it('answers 400 when a purpose comes without given_at, and stores nothing', async () => {
    for (const consent of [{ notifications: true }, { marketing: false }]) {
      const res = await send(direct('ViewContent', { consent }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain('consent.given_at');
    }
    expect(t('contact_consents')).toHaveLength(0);
    expect(t('journey_events')).toHaveLength(0);
  });

  it('someone who wrote is eligible without explicit consent; someone who never did is not', async () => {
    const never = await send(direct('ViewContent'));
    expect((await never.json()).data.messaging).toBe('no_consent');
    expect(t('contact_consents')).toHaveLength(0);

    resetWorld();
    // (re-seed the account fixtures cleared by resetWorld)
    world.tables.accounts = [
      { id: 'acct-1', owner_user_id: 'owner-1', default_currency: 'BRL' },
    ];
    world.tables.stores = [
      {
        id: 'store-1',
        account_id: 'acct-1',
        name: 'Bella Capri Centro',
        store_key_normalized: '89/rpa/blc',
        notification_connection_id: null,
      },
    ];
    seedConnection();
    seedInbound();
    const wrote = await send(direct('ViewContent'));
    expect((await wrote.json()).data.messaging).toBe('eligible');
    expect(t('contact_consents')).toHaveLength(0);
  });

  it('ignores the consent when idtrack and phone resolve different contacts', async () => {
    // contact B owns the phone, contact A owns the token
    world.tables.contacts = [
      { id: 'ct-a', account_id: 'acct-1', name: 'A', phone: '5511000000001' },
      { id: 'ct-b', account_id: 'acct-1', name: 'B', phone: DIGITS },
    ];
    world.tables.contact_identities = [
      {
        account_id: 'acct-1',
        contact_id: 'ct-b',
        kind: 'whatsapp:phone',
        external_id: DIGITS,
      },
    ];
    world.tables.conversations = [
      {
        id: 'cv-a',
        account_id: 'acct-1',
        contact_id: 'ct-a',
        connection_id: 'conn-1',
      },
    ];
    const { issueTrackingToken } = await import('@/lib/journeys/tokens');
    const { token } = await issueTrackingToken(db, {
      accountId: 'acct-1',
      contactId: 'ct-a',
      conversationId: 'cv-a',
      connectionId: 'conn-1',
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await send({
      event_id: 'evt-conflict',
      name: 'ViewContent',
      idtrack: token,
      customer: { phone: PHONE },
      consent: { notifications: true, marketing: true, given_at: T1 },
      occurred_at: '2026-10-02T21:14:05Z',
    });
    expect(res.status).toBe(200);
    expect(t('contact_consents')).toHaveLength(0);
  });

  it('applies the consent of an idtrack event to the contact of the token', async () => {
    world.tables.contacts = [
      { id: 'ct-a', account_id: 'acct-1', name: 'A', phone: '5511000000001' },
    ];
    world.tables.conversations = [
      {
        id: 'cv-a',
        account_id: 'acct-1',
        contact_id: 'ct-a',
        connection_id: 'conn-1',
      },
    ];
    const { issueTrackingToken } = await import('@/lib/journeys/tokens');
    const { token } = await issueTrackingToken(db, {
      accountId: 'acct-1',
      contactId: 'ct-a',
      conversationId: 'cv-a',
      connectionId: 'conn-1',
    });
    const res = await send({
      event_id: 'evt-token',
      name: 'ViewContent',
      idtrack: token,
      consent: { marketing: true, given_at: T1 },
      occurred_at: '2026-10-02T21:14:05Z',
    });
    expect(res.status).toBe(200);
    expect(consentOf('marketing')).toMatchObject({
      contact_id: 'ct-a',
      granted: true,
      source: 'menu',
    });
  });

  it('a replay of the same event_id does not apply the consent again', async () => {
    const body = direct('ViewContent', {
      consent: { notifications: true, given_at: T1 },
    });
    expect((await send(body)).status).toBe(200);
    expect(t('contact_consents')).toHaveLength(1);
    // wipe the stored consent: only a re-application could bring it back
    world.tables.contact_consents = [];
    const again = await send(body);
    expect(again.status).toBe(200);
    expect((await again.json()).data.duplicate).toBe(true);
    expect(t('contact_consents')).toHaveLength(0);
  });

  it('isolates consents by account', async () => {
    await send(
      direct('ViewContent', { consent: { notifications: true, given_at: T1 } })
    );
    expect(t('contact_consents').every((r) => r.account_id === 'acct-1')).toBe(
      true
    );
  });
});

describe('the direct Journey', () => {
  it.each([
    ['ViewContent', {}, 'browsing'],
    ['AddToCart', cart, 'cart'],
    ['InitiateCheckout', cart, 'checkout'],
  ])(
    '%s opens it already at %s, never at link_sent',
    async (name, extra, stage) => {
      const res = await send(direct(name, extra));
      expect(res.status).toBe(200);
      expect((await res.json()).data.stage).toBe(stage);
      expect(t('journeys')).toHaveLength(1);
      expect(t('journeys')[0]).toMatchObject({
        origin: 'menu_direct',
        stage,
        state: 'open',
        link_sent_at: null,
        link_count: 0,
      });
      expect(stageKey(t('deals')[0].stage_id)).toBe(stage);
    }
  );

  it('keeps ONE open Journey per contact and moves it forward', async () => {
    await send(direct('ViewContent'));
    await send(direct('AddToCart', cart));
    await send(direct('ViewContent'));
    expect(t('journeys')).toHaveLength(1);
    expect(t('journeys')[0]).toMatchObject({
      stage: 'cart',
      view_content_count: 2,
    });
    expect(t('deals')).toHaveLength(1);
  });

  it('a store without a WhatsApp connection still gets its Journey', async () => {
    seedConnection(false);
    const first = await send(direct('ViewContent'));
    const second = await send(direct('AddToCart', cart));
    expect(first.status).toBe(200);
    const { data } = await second.json();
    expect(data).toMatchObject({ stage: 'cart', messaging: 'no_connection' });
    expect(t('journeys')).toHaveLength(1);
    expect(t('journeys')[0]).toMatchObject({
      connection_id: null,
      store_id: 'store-1',
      origin: 'menu_direct',
    });
    expect(t('deals')[0].connection_id ?? null).toBeNull();
  });

  it('a store with several WhatsApp connections and no default sends nothing but accepts', async () => {
    world.tables.channel_connections = ['a', 'b'].map((id) => ({
      id: `conn-${id}`,
      account_id: 'acct-1',
      store_id: 'store-1',
      channel_type: 'whatsapp_cloud',
      external_id: id,
      status: 'connected',
      disabled_at: null,
    }));
    const res = await send(direct('ViewContent'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.messaging).toBe('no_connection');
  });

  it('two simultaneous events for the same unknown phone create ONE contact', async () => {
    const [a, b] = await Promise.all([
      send(direct('ViewContent')),
      send(direct('ViewContent')),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(t('contacts')).toHaveLength(1);
    expect(
      t('contact_identities').filter((i) => i.kind === 'whatsapp:phone')
    ).toHaveLength(1);
  });

  it('a replayed event_id answers the stored response, messaging included', async () => {
    const body = purchase('PED-1');
    const first = await (await send(body)).json();
    const res = await send(body);
    expect(res.headers.get('Idempotent-Replayed')).toBe('true');
    const again = await res.json();
    expect(again.data).toEqual({ ...first.data, duplicate: true });
    expect(t('orders')).toHaveLength(1);
  });
});

describe('messaging and automations', () => {
  it('the hook fires for every direct event with a contact (even with no conversation or consent); the step decides', async () => {
    await send(direct('ViewContent'));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][1]).toMatchObject({
      conversationId: null,
      storeId: 'store-1',
    });
    hook.mockReset();

    resetWorld();
    world.tables.accounts = [
      { id: 'acct-1', owner_user_id: 'owner-1', default_currency: 'BRL' },
    ];
    world.tables.stores = [
      {
        id: 'store-1',
        account_id: 'acct-1',
        name: 'Centro',
        store_key_normalized: '89/rpa/blc',
      },
    ];
    seedConnection();
    seedInbound();
    await send(direct('ViewContent'));
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][1]).toMatchObject({
      contactId: 'ct-1',
      conversationId: 'cv-1',
      connectionId: 'conn-1',
      storeId: 'store-1',
    });
  });

  it('OrderStatusChanged by phone finds the order; an unknown phone creates nothing', async () => {
    seedInbound();
    await send(purchase('PED-1'));
    const ok = await send(
      direct('OrderStatusChanged', {
        properties: { order_id: 'PED-1', status: 'preparing' },
      })
    );
    expect(ok.status).toBe(200);
    expect(t('orders')[0].status).toBe('preparing');

    const other = await send(
      direct('OrderStatusChanged', {
        customer: { phone: '+5511888887777' },
        properties: { order_id: 'PED-1', status: 'delivered' },
      })
    );
    expect(other.status).toBe(400);
    expect((await other.json()).error.code).toBe('order_not_found');
    expect(t('contacts')).toHaveLength(1);
  });
});

describe('idtrack with direct fields', () => {
  beforeEach(() => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    world.tables.contacts = [
      { id: 'ct-1', account_id: 'acct-1', name: 'Maria', phone: '5511' },
      { id: 'ct-2', account_id: 'acct-1', name: 'Joao', phone: DIGITS },
    ];
    world.tables.contact_identities = [
      {
        account_id: 'acct-1',
        contact_id: 'ct-2',
        kind: 'whatsapp:phone',
        external_id: DIGITS,
      },
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
    ];
  });

  it('a conflict: the idtrack wins, nothing of the phone contact changes and the log masks the phone', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await send(
      direct('ViewContent', {
        idtrack: 'tok-live',
        consent: { notifications: true, given_at: '2026-10-02T21:10:00Z' },
        customer: { phone: PHONE, name: 'Hijack' },
      })
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(t('journeys')).toHaveLength(1);
    expect(t('journeys')[0]).toMatchObject({
      id: data.journey_id,
      contact_id: 'ct-1',
      origin: 'crm_link',
    });
    expect(t('contacts').find((c) => c.id === 'ct-2')?.name).toBe('Joao');
    expect(t('contacts')).toHaveLength(2);
    expect(t('contact_consents')).toHaveLength(0);

    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('conflict');
    expect(logged).toContain('8888');
    expect(logged).not.toContain(DIGITS);
    expect(logged).not.toContain(PHONE);
  });

  it('with an unknown store_key the idtrack still attributes the event', async () => {
    const res = await send(
      direct('ViewContent', { idtrack: 'tok-live', store_key: '1/X/Y' })
    );
    expect(res.status).toBe(200);
  });

  it('messaging is part of the response of a plain idtrack event', async () => {
    const res = await send({
      event_id: 'e-x',
      name: 'ViewContent',
      idtrack: 'tok-live',
      occurred_at: '2026-10-02T21:14:05Z',
    });
    const { data } = await res.json();
    expect(data.messaging).toBe('no_consent');
  });
});

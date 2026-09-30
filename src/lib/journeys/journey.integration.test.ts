/**
 * End-to-end journey tests at the HTTP + engine level, on ONE in-memory
 * database (`crm-world.fake`), once per channel (WhatsApp Cloud and Telegram):
 *
 *   menu link sent by an automation (`{{menu_link}}`) -> ViewContent -> AddToCart
 *   -> InitiateCheckout -> Purchase -> received ... delivered, through the real
 *   `POST /api/v1/journey/events` route, the real journeys module, the real
 *   automations engine with the real "Jornada de pedido" preset, the real
 *   `sendOutbound` and the real channel providers.
 *
 * And the abandonment path: link sent -> Resumptions at 10 and 30 minutes ->
 * "Perdido" after 24 h, driven through the real cron route.
 *
 * Only the edges are stubbed: the Meta send helper, the Telegram Bot API
 * (`fetch`), the credentials lookup, the API-key store and outbound webhooks.
 * The journeys module never imports a channel module (see
 * `no-channel-imports.test.ts`); here the same code runs unchanged on both.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db, resetWorld, world, type Row } from '@/lib/channels/crm-world.fake';
import { generateApiKey } from '@/lib/api-keys/keys';
import type { ApiKeyRow } from '@/lib/api-keys/store';
import { __resetRateLimitForTests } from '@/lib/rate-limit';

const h = vi.hoisted(() => ({
  key: null as unknown,
  waSends: [] as { to: string; text: string }[],
  waTemplates: [] as { to: string; name: string }[],
  tgSends: [] as { chat_id: number; text: string }[],
}));

vi.mock('@/lib/api-keys/store', () => ({
  findActiveKeyByHash: async () => h.key,
  touchLastUsed: () => {},
}));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConnectionCredentials: async () => ({
    access_token: 'wa-token',
    bot_token: '123456:BOT-token_XYZ',
  }),
}));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: async (a: { to: string; text: string }) => {
    h.waSends.push({ to: a.to, text: a.text });
    return { messageId: `wamid.${h.waSends.length}` };
  },
  sendTemplateMessage: async (a: { to: string; template: { name: string } }) => {
    h.waTemplates.push({ to: a.to, name: a.template.name });
    return { messageId: `wamid.tpl.${h.waTemplates.length}` };
  },
}));
const fakeAdmin = vi.hoisted(() => async () => {
  const { db } = await import('@/lib/channels/crm-world.fake');
  return { supabaseAdmin: () => db };
});
vi.mock('@/lib/channels/admin-client', fakeAdmin);
vi.mock('@/lib/automations/admin-client', fakeAdmin);
vi.mock('@/lib/flows/admin-client', fakeAdmin);

const { POST } = await import('@/app/api/v1/journey/events/route');
const { GET: cron } = await import('@/app/api/automations/cron/route');
const { runAutomationsForTrigger } = await import('@/lib/automations/engine');
const { installJourneyPreset, loadJourneyPresetCatalog } =
  await import('@/lib/automations/journey-preset');

const KEY = generateApiKey().plaintext;
const ACCOUNT = 'acct-1';
const MIN = 60_000;
const T0 = Date.parse('2026-10-02T21:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const t = (name: string): Row[] => world.tables[name] ?? [];

const key: ApiKeyRow = {
  id: 'key-1',
  account_id: ACCOUNT,
  created_by: 'user-1',
  name: 'menu',
  scopes: ['events:write'],
  expires_at: null,
  revoked_at: null,
};

let n = 0;
function post(
  name: string,
  idtrack: string,
  extra: Row = {},
  eventId?: string
) {
  return POST(
    new Request('https://crm.example.com/api/v1/journey/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        event_id: eventId ?? `evt-${++n}`,
        name,
        idtrack,
        occurred_at: iso(Date.now()),
        ...extra,
      }),
    })
  );
}
const items = [
  { id: 'pizza', name: 'Pizza', quantity: 2, unit_price: 45 },
  { id: 'soda', name: 'Soda', quantity: 1, unit_price: 10 },
];
const cart = {
  properties: { currency: 'BRL', cart: { value: 100, items } },
};
const purchase = (orderId: string) => ({
  properties: { order_id: orderId, currency: 'BRL', value: 100, items },
});
const status = (orderId: string, s: string) => ({
  properties: { order_id: orderId, status: s },
});

const CHANNELS = [
  {
    label: 'WhatsApp Cloud',
    type: 'whatsapp_cloud',
    identity: { kind: 'whatsapp:phone', external_id: '15551234567' },
    sent: () => h.waSends.map((s) => s.text),
  },
  {
    label: 'Telegram',
    type: 'telegram',
    identity: { kind: 'telegram:chat_id', external_id: '555000111' },
    sent: () => h.tgSends.map((s) => s.text),
  },
] as const;

let catalog: Awaited<ReturnType<typeof loadJourneyPresetCatalog>>;

function seed(channel: (typeof CHANNELS)[number]) {
  resetWorld();
  const telegram = channel.type === 'telegram';
  world.tables = {
    accounts: [
      { id: ACCOUNT, owner_user_id: 'owner-1', default_currency: 'BRL' },
    ],
    stores: [
      {
        id: 'store-1',
        account_id: ACCOUNT,
        name: 'Centro',
        menu_url: 'https://menu.example.com/centro?utm=crm',
      },
    ],
    channel_connections: [
      {
        id: 'conn-1',
        account_id: ACCOUNT,
        store_id: 'store-1',
        channel_type: channel.type,
        external_id: telegram ? 'bot-1' : 'pn-1',
        status: 'connected',
        disabled_at: null,
        config: {},
      },
    ],
    contacts: [
      {
        id: 'ct-1',
        account_id: ACCOUNT,
        name: 'Maria',
        phone: telegram ? null : '+15551234567',
      },
    ],
    contact_identities: [
      { account_id: ACCOUNT, contact_id: 'ct-1', ...channel.identity },
    ],
    conversations: [
      {
        id: 'cv-1',
        account_id: ACCOUNT,
        contact_id: 'ct-1',
        connection_id: 'conn-1',
      },
    ],
    // The customer wrote 5 minutes before the link (reply window open).
    messages: [
      {
        id: 'm-0',
        conversation_id: 'cv-1',
        sender_type: 'customer',
        content_type: 'text',
        content_text: 'I want to order',
        created_at: iso(T0 - 5 * MIN),
      },
    ],
    automations: [
      {
        id: 'au-link',
        account_id: ACCOUNT,
        user_id: 'owner-1',
        name: 'Send the menu',
        trigger_type: 'new_contact_created',
        trigger_config: {},
        is_active: true,
      },
    ],
    automation_steps: [
      {
        id: 'st-link',
        automation_id: 'au-link',
        position: 0,
        parent_step_id: null,
        branch: null,
        step_type: 'send_message',
        step_config: { text: 'Order here: {{menu_link}}' },
      },
    ],
  };
}

/** The real preset, activated (it installs inactive on purpose). */
async function installAndActivatePreset() {
  const res = await installJourneyPreset(db, {
    accountId: ACCOUNT,
    userId: 'owner-1',
    catalog,
  });
  expect(res.created).toHaveLength(10);
  for (const a of t('automations')) a.is_active = true;
}

/** The automation sends the link; returns the `idtrack` the customer received. */
async function sendMenuLink(): Promise<string> {
  await runAutomationsForTrigger({
    accountId: ACCOUNT,
    triggerType: 'new_contact_created',
    contactId: 'ct-1',
    context: { conversation_id: 'cv-1' },
  });
  const link = t('messages').find((m) =>
    String(m.content_text).startsWith('Order here: ')
  );
  expect(link, 'the menu link message was persisted').toBeDefined();
  const url = new URL(String(link!.content_text).replace('Order here: ', ''));
  expect(url.origin + url.pathname).toBe('https://menu.example.com/centro');
  expect(url.searchParams.get('utm')).toBe('crm');
  return url.searchParams.get('idtrack')!;
}

const journeys = () => t('journeys');
const deal = () => t('deals')[0];
const stageOf = (d: Row) =>
  t('pipeline_stages').find((s) => s.id === d.stage_id)?.system_key;
const order = (id: string) =>
  t('orders').find((o) => o.external_order_id === id)!;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  n = 0;
  h.key = key;
  h.waSends = [];
  h.waTemplates = [];
  h.tgSends = [];
  __resetRateLimitForTests();
  process.env.AUTOMATION_CRON_SECRET = 'cron-secret';
  catalog ??= await loadJourneyPresetCatalog('en');
  let tgId = 100;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}');
      h.tgSends.push({ chat_id: body.chat_id, text: body.text });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: ++tgId, chat: { id: 555000111 } },
        })
      );
    })
  );
  for (const m of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, m).mockImplementation(() => {});
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const runCron = () =>
  cron(
    new Request('https://crm.example.com/api/automations/cron', {
      headers: { 'x-cron-secret': 'cron-secret' },
    })
  );
const at = (minutes: number) => vi.setSystemTime(T0 + minutes * MIN);

describe.each(CHANNELS)('order journey on $label', (channel) => {
  beforeEach(async () => {
    seed(channel);
    await installAndActivatePreset();
  });

  it('link -> ViewContent -> AddToCart -> InitiateCheckout -> Purchase -> received..delivered', async () => {
    const idtrack = await sendMenuLink();
    expect(journeys()).toHaveLength(1);
    expect(journeys()[0]).toMatchObject({ state: 'open', stage: 'link_sent' });
    expect(stageOf(deal())).toBe('link_sent');

    const res = (r: Response) => r.json().then((b) => b.data);
    expect(await res(await post('ViewContent', idtrack))).toMatchObject({
      stage: 'browsing',
    });
    expect(stageOf(deal())).toBe('browsing');
    expect(await res(await post('AddToCart', idtrack, cart))).toMatchObject({
      stage: 'cart',
    });
    expect(journeys()[0]).toMatchObject({
      cart_items_count: 3,
      cart_value: 100,
    });
    expect(
      await res(await post('InitiateCheckout', idtrack, cart))
    ).toMatchObject({ stage: 'checkout' });

    const before = channel.sent().length;
    const bought = await post('Purchase', idtrack, purchase('PED-1'));
    expect(bought.status).toBe(200);
    expect(journeys()[0]).toMatchObject({ state: 'won', stage: 'won' });
    expect(deal().status).toBe('won');
    expect(order('PED-1')).toMatchObject({ status: 'placed', idtrack });
    // The thank-you leaves on the channel of origin, with the order id.
    expect(channel.sent().slice(before)).toEqual([
      "Thank you for your order PED-1! We'll keep you posted on every step.",
    ]);

    for (const s of [
      'received',
      'preparing',
      'finished',
      'out_for_delivery',
      'delivered',
    ]) {
      const sentBefore = channel.sent().length;
      const r = await post('OrderStatusChanged', idtrack, status('PED-1', s));
      expect(r.status).toBe(200);
      expect(order('PED-1').status).toBe(s);
      expect(channel.sent().slice(sentBefore)).toEqual([
        catalog.texts[`status_${s}`].replace('{{order_id}}', 'PED-1'),
      ]);
    }
    // Every notification went through this channel and only this one.
    const other = channel.type === 'telegram' ? h.waSends : h.tgSends;
    expect(other).toHaveLength(0);
    // Retrying a status, even a stale one, sends nothing more.
    const total = channel.sent().length;
    await post('OrderStatusChanged', idtrack, status('PED-1', 'preparing'));
    expect(channel.sent()).toHaveLength(total);
  });

  it('repeating an event_id answers Idempotent-Replayed and sends nothing twice', async () => {
    const idtrack = await sendMenuLink();
    const first = await post('Purchase', idtrack, purchase('PED-2'), 'evt-p');
    expect(first.headers.get('Idempotent-Replayed')).toBeNull();
    const sent = channel.sent().length;

    const again = await post('Purchase', idtrack, purchase('PED-2'), 'evt-p');
    expect(again.status).toBe(200);
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
    expect((await again.json()).data.duplicate).toBe(true);
    expect(channel.sent()).toHaveLength(sent);
    expect(t('orders')).toHaveLength(1);
  });

  describe('two Purchases racing for the same order_id', () => {
    /** The winner inserted the order and has not closed the Journey yet. */
    async function winnerInsertedOrder(idtrack: string, originEventId: string) {
      await post('ViewContent', idtrack);
      (world.tables.orders ??= []).push({
        id: 'ord-race',
        account_id: ACCOUNT,
        external_order_id: 'PED-RACE',
        contact_id: 'ct-1',
        journey_id: journeys()[0].id,
        idtrack,
        origin_event_id: originEventId,
        status: 'placed',
      });
    }

    it('the loser (other event_id) answers duplicate: no close, no thank-you', async () => {
      const idtrack = await sendMenuLink();
      await winnerInsertedOrder(idtrack, 'evt-winner');
      const sent = channel.sent().length;

      const res = await post(
        'Purchase',
        idtrack,
        purchase('PED-RACE'),
        'evt-loser'
      );
      expect(res.status).toBe(200);
      expect((await res.json()).data.duplicate).toBe(true);
      expect(journeys()[0].state).toBe('open');
      expect(t('orders')).toHaveLength(1);
      expect(channel.sent()).toHaveLength(sent);
    });

    it('a retry of the SAME event_id finishes the pending work', async () => {
      const idtrack = await sendMenuLink();
      await winnerInsertedOrder(idtrack, 'evt-winner');

      const res = await post(
        'Purchase',
        idtrack,
        purchase('PED-RACE'),
        'evt-winner'
      );
      expect((await res.json()).data.duplicate).toBe(false);
      expect(journeys()[0].state).toBe('won');
    });
  });

  it('concurrent ViewContent events do not lose increments', async () => {
    const idtrack = await sendMenuLink();
    await post('ViewContent', idtrack);
    expect(journeys()[0].view_content_count).toBe(1);

    // Another ViewContent lands between this one's read and its write.
    const realFrom = db.from.bind(db);
    let raced = false;
    vi.spyOn(db, 'from').mockImplementation((table: string) => {
      const q = realFrom(table) as unknown as {
        update: (p: Row) => unknown;
      };
      if (table === 'journeys' && !raced) {
        const update = q.update.bind(q);
        q.update = (patch: Row) => {
          if ('view_content_count' in patch) {
            raced = true;
            journeys()[0].view_content_count = 2;
          }
          return update(patch);
        };
      }
      return q as never;
    });

    const res = await post('ViewContent', idtrack);
    expect(res.status).toBe(200);
    expect(raced).toBe(true);
    expect(journeys()[0].view_content_count).toBe(3);
  });

  it('a failure saving the response after the effects keeps the claim: the retry never re-applies them', async () => {
    const idtrack = await sendMenuLink();
    const failing = { error: { message: 'db down' } };
    const dead: unknown = new Proxy(
      {},
      {
        get: (_t, prop) =>
          prop === 'then'
            ? (resolve: (v: unknown) => unknown) => resolve(failing)
            : () => dead,
      }
    );
    const realFrom = db.from.bind(db);
    let failSave = true;
    vi.spyOn(db, 'from').mockImplementation((table: string) => {
      const q = realFrom(table) as unknown as { update: (p: Row) => unknown };
      if (table === 'journey_events') {
        const update = q.update.bind(q);
        q.update = (patch: Row) =>
          failSave && 'response' in patch ? dead : update(patch);
      }
      return q as never;
    });

    const first = await post('ViewContent', idtrack, {}, 'evt-view');
    expect(first.status).toBe(500);
    expect(journeys()[0].view_content_count).toBe(1);
    const claimRow = t('journey_events').find((e) => e.event_id === 'evt-view');
    expect(claimRow?.response ?? null).toBeNull();
    expect(claimRow?.journey_id).toBe(journeys()[0].id);
    failSave = false;

    // Still fresh: the retry is told to come back, and applies nothing.
    const soon = await post('ViewContent', idtrack, {}, 'evt-view');
    expect(soon.status).toBe(500);
    expect(journeys()[0].view_content_count).toBe(1);

    // Stale: the claim is taken over and only answered.
    at(2);
    const later = await post('ViewContent', idtrack, {}, 'evt-view');
    expect(later.status).toBe(200);
    expect((await later.json()).data.duplicate).toBe(false);
    expect(journeys()[0].view_content_count).toBe(1);
    const again = await post('ViewContent', idtrack, {}, 'evt-view');
    expect(again.headers.get('Idempotent-Replayed')).toBe('true');
  });

  it('an unknown idtrack is 404 and an expired one is 410', async () => {
    const idtrack = await sendMenuLink();
    const notFound = await post('ViewContent', 'nope');
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error.code).toBe('idtrack_not_found');

    at(31 * 24 * 60); // 31 days later
    const expired = await post('ViewContent', idtrack);
    expect(expired.status).toBe(410);
    expect((await expired.json()).error.code).toBe('idtrack_expired');
  });

  it('a second order with the same idtrack opens a new Journey and is attributed', async () => {
    const idtrack = await sendMenuLink();
    await post('Purchase', idtrack, purchase('PED-A'));
    expect(journeys()).toHaveLength(1);

    const again = await post('AddToCart', idtrack, cart);
    expect(again.status).toBe(200);
    expect(journeys()).toHaveLength(2);
    const second = await post('Purchase', idtrack, purchase('PED-B'));
    expect(second.status).toBe(200);
    expect(journeys().map((j) => j.state)).toEqual(['won', 'won']);
    expect(order('PED-B').journey_id).toBe(journeys()[1].id);
    expect(t('contacts')[0].last_purchase_at).toBeTruthy();
  });

  it('abandonment: link -> Resumptions at 10 and 30 min -> Perdido after 24 h', async () => {
    const idtrack = await sendMenuLink();
    const linkMessages = channel.sent().length;
    expect(idtrack).toBeTruthy();

    at(9);
    await runCron();
    expect(channel.sent()).toHaveLength(linkMessages);

    at(10);
    await runCron();
    expect(channel.sent().slice(linkMessages)).toEqual([
      catalog.texts.resumption1,
    ]);

    at(29);
    await runCron();
    expect(channel.sent()).toHaveLength(linkMessages + 1);
    at(30);
    await runCron();
    expect(channel.sent().slice(linkMessages)).toEqual([
      catalog.texts.resumption1,
      catalog.texts.resumption2,
    ]);
    expect(journeys()[0].state).toBe('open');

    at(23 * 60);
    expect(await (await runCron()).json()).toMatchObject({ journeys_lost: 0 });
    at(25 * 60);
    expect(await (await runCron()).json()).toMatchObject({ journeys_lost: 1 });
    expect(journeys()[0]).toMatchObject({ state: 'lost', stage: 'lost' });
    expect(deal().status).toBe('lost');
    expect(stageOf(deal())).toBe('lost');
    // No third message, and a repeated sweep changes nothing.
    expect(channel.sent()).toHaveLength(linkMessages + 2);
    expect(await (await runCron()).json()).toMatchObject({ journeys_lost: 0 });
  });

  it('a customer reply before 10 min suppresses the Resumptions', async () => {
    await sendMenuLink();
    const linkMessages = channel.sent().length;
    at(3);
    t('messages').push({
      id: 'm-reply',
      conversation_id: 'cv-1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'one sec',
      created_at: iso(Date.now()),
    });
    at(10);
    await runCron();
    at(30);
    await runCron();
    expect(channel.sent()).toHaveLength(linkMessages);
  });

  it('a Purchase before the Resumptions suppresses them', async () => {
    const idtrack = await sendMenuLink();
    at(5);
    await post('Purchase', idtrack, purchase('PED-Q'));
    const after = channel.sent().length; // includes the thank-you
    at(10);
    await runCron();
    at(30);
    await runCron();
    expect(channel.sent()).toHaveLength(after);
  });
});

describe('direct events to a customer who never wrote (consent, closed conversation, template)', () => {
  const PHONE = '+5511999998888';
  const DIGITS = '5511999998888';
  const direct = (name: string, extra: Row = {}) =>
    POST(
      new Request('https://crm.example.com/api/v1/journey/events', {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          event_id: `evt-${++n}`,
          name,
          store_key: '89/RPA/BLC',
          customer: { phone: PHONE, name: 'Ana' },
          occurred_at: iso(Date.now()),
          ...extra,
        }),
      })
    );
  const consent = { notifications: true, given_at: '2026-10-02T20:00:00Z' };

  beforeEach(async () => {
    resetWorld();
    world.tables = {
      accounts: [{ id: ACCOUNT, owner_user_id: 'owner-1', default_currency: 'BRL' }],
      stores: [
        {
          id: 'store-1',
          account_id: ACCOUNT,
          name: 'Centro',
          store_key_normalized: '89/rpa/blc',
        },
      ],
      channel_connections: [
        {
          id: 'conn-1',
          account_id: ACCOUNT,
          store_id: 'store-1',
          channel_type: 'whatsapp_cloud',
          external_id: 'pn-1',
          status: 'connected',
          disabled_at: null,
          config: {},
        },
      ],
      message_templates: [
        {
          id: 'tpl-1',
          account_id: ACCOUNT,
          user_id: 'owner-1',
          name: 'order_update',
          category: 'Utility',
          language: 'en',
          body_text: 'Your order is moving',
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    await installAndActivatePreset();
    // The operator configured the first-contact template on the notices.
    for (const step of t('automation_steps')) {
      if (
        step.step_type === 'send_message' &&
        (step.step_config as Row).consent_purpose === 'notifications'
      ) {
        step.step_config = {
          ...(step.step_config as Row),
          fallback_template: { name: 'order_update', language: 'en' },
        };
      }
    }
  });

  const conversations = () => t('conversations');
  const logs = () => t('automation_logs');

  it('consent -> contact created -> thank-you and status by template -> closed conversation -> customer reply reopens it', async () => {
    const res = await direct('Purchase', {
      consent,
      ...purchase('PED-1'),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.messaging).toBe('eligible');

    // Contact created from the menu; no text message ever left: the first
    // contact is a template, on a conversation born closed.
    expect(t('contacts')).toHaveLength(1);
    expect(t('contacts')[0]).toMatchObject({ source: 'menu', name: 'Ana' });
    expect(conversations()).toHaveLength(1);
    expect(conversations()[0]).toMatchObject({
      status: 'closed',
      connection_id: 'conn-1',
    });
    expect(h.waSends).toEqual([]);
    expect(h.waTemplates).toEqual([{ to: DIGITS, name: 'order_update' }]);

    // A status notice goes out on the same conversation, still by template.
    const sr = await direct('OrderStatusChanged', status('PED-1', 'preparing'));
    expect(sr.status).toBe(200);
    expect(h.waTemplates).toHaveLength(2);
    expect(conversations()).toHaveLength(1);
    expect(conversations()[0].status).toBe('closed');

    // The customer answers: the existing mechanism reopens the conversation.
    const { ingestInbound } = await import('@/lib/channels/ingest');
    const [r] = await ingestInbound(
      db as never,
      { id: 'conn-1', account_id: ACCOUNT, channel_type: 'whatsapp_cloud' } as never,
      [
        {
          kind: 'message',
          externalId: 'wamid.in.1',
          sender: [{ kind: 'whatsapp:phone', externalId: DIGITS }],
          at: new Date(),
          content: { type: 'text', text: 'Thanks!' },
          senderName: 'Ana',
        },
      ],
      { auditUserId: 'owner-1' }
    );
    expect(r.status).toBe('stored');
    expect(conversations()).toHaveLength(1);
    expect(conversations()[0].status).toBe('open');
  });

  it('without consent the order is recorded, the step is skipped with the reason and nothing is created or sent', async () => {
    const res = await direct('Purchase', purchase('PED-2'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.messaging).toBe('no_consent');

    expect(t('orders')).toHaveLength(1);
    expect(conversations()).toHaveLength(0);
    expect(h.waTemplates).toEqual([]);
    expect(h.waSends).toEqual([]);
    const skipped = logs().flatMap((l) => l.steps_executed as Row[]);
    expect(skipped).toEqual([
      expect.objectContaining({
        status: 'skipped',
        detail: 'ignored: sem consentimento: notifications',
      }),
    ]);
    expect(JSON.stringify(logs())).not.toContain('99999');
  });

  it('consent given only for marketing does not release the order notices', async () => {
    await direct('Purchase', {
      consent: { marketing: true, given_at: '2026-10-02T20:00:00Z' },
      ...purchase('PED-3'),
    });
    expect(h.waTemplates).toEqual([]);
    expect(conversations()).toHaveLength(0);
  });

  it('without a configured template the first contact fails visibly', async () => {
    for (const step of t('automation_steps')) {
      const cfg = step.step_config as Row;
      if (cfg.consent_purpose === 'notifications') delete cfg.fallback_template;
    }
    await direct('Purchase', { consent, ...purchase('PED-4') });
    expect(h.waTemplates).toEqual([]);
    expect(h.waSends).toEqual([]);
    expect(logs().some((l) => l.status === 'failed')).toBe(true);
  });
});

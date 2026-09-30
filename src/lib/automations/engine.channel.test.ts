/**
 * US-028: the automations engine sends through the core (`sendOutbound`, actor
 * `automation`), a `wait` step saves the conversation/connection it runs on,
 * the resume sends through THAT conversation, and triggers without a
 * conversation pick the contact's most recent conversation on a connection
 * that supports the step, or the execution is recorded as ignored with the
 * reason. Only the Meta HTTP senders are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';
import { registerBuiltinProviders } from '@/lib/channels/providers';
import {
  hasProvider,
  registerProvider,
  resetRegistryForTests,
} from '@/lib/channels/registry';
import type { ChannelProvider } from '@/lib/channels/types';
import { resolveTrackingToken } from '@/lib/journeys';
import { supabaseAdmin as automationsDb } from './admin-client';
import { resumePendingExecution, runAutomationsForTrigger } from './engine';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  rpcCalls: [] as { name: string; args: unknown }[],
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: h.sendTextMessage,
  sendTemplateMessage: h.sendTemplateMessage,
}));

vi.mock('@/lib/channels/admin-client', async () => {
  const { fakeCredentialsAdmin } =
    await import('@/lib/channels/credentials-admin.fake');
  return {
    supabaseAdmin: () =>
      fakeCredentialsAdmin(
        () =>
          (h.db.channel_connection_credentials?.[0] as {
            secrets_encrypted: string;
            secrets_format: string;
          }) ?? null
      ),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `dec:${v}`,
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}));

vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: async () => true }));

vi.mock('@/lib/automations/admin-client', async () => {
  const { fakeAdmin } = await import('./engine.characterization.fake');
  return fakeAdmin(h);
});
vi.mock('@/lib/flows/admin-client', async () => {
  const { fakeAdmin } = await import('./engine.characterization.fake');
  return fakeAdmin(h);
});

const WA_CONN = 'conn-acct-1';
const TG_CONN = 'conn-tg';

/** A second channel with no templates (stand-in until the Telegram provider lands). */
function registerNoTemplateChannel() {
  if (hasProvider('telegram')) return;
  registerProvider({
    type: 'telegram',
    capabilities: {
      templates: false,
      interactiveButtons: true,
      interactiveList: false,
    },
  } as unknown as ChannelProvider);
}

const sent = () => h.db.messages.filter((m) => m.sender_type !== 'customer');

function seed() {
  h.db = {
    contacts: [{ id: 'ct-1', account_id: 'acct-1', phone: '+15551234567' }],
    conversations: [
      {
        id: 'cv-old-wa',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        connection_id: WA_CONN,
        last_message_text: 'old',
        last_message_at: '2020-01-01T00:00:00Z',
      },
      {
        id: 'cv-new-wa',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        connection_id: WA_CONN,
        last_message_text: 'new',
        last_message_at: '2024-01-01T00:00:00Z',
      },
    ],
    channel_connections: [
      whatsappConnectionRow('acct-1', 'pn-1'),
      {
        id: TG_CONN,
        account_id: 'acct-1',
        channel_type: 'telegram',
        external_id: 'bot-1',
        status: 'connected',
        config: {},
        disabled_at: null,
      },
    ],
    channel_connection_credentials: [
      { secrets_encrypted: 'cipher', secrets_format: 'wa_token_v0' },
    ],
    message_templates: [],
    messages: [
      // Reply window open (automation texts are window-aware): one recent
      // customer message per conversation. Assertions use the sent-only view.
      ...['cv-old-wa', 'cv-new-wa'].map((id) => ({
        conversation_id: id,
        sender_type: 'customer',
        created_at: new Date().toISOString(),
      })),
    ],
    contact_identities: [],
    automations: [
      {
        id: 'au-1',
        account_id: 'acct-1',
        user_id: 'user-1',
        trigger_type: 'tag_added',
        trigger_config: { tag_id: 'tag-1' },
        is_active: true,
      },
    ],
    automation_steps: [],
    automation_logs: [],
    automation_pending_executions: [],
  };
}

function steps(...list: Row[]) {
  h.db.automation_steps = list.map((s, i) => ({
    id: `st-${i + 1}`,
    automation_id: 'au-1',
    position: i,
    parent_step_id: null,
    branch: null,
    ...s,
  }));
}

const fire = (context: Row = {}) =>
  runAutomationsForTrigger({
    accountId: 'acct-1',
    triggerType: 'tag_added',
    contactId: 'ct-1',
    context: { tag_id: 'tag-1', ...context },
  });

const conv = (id: string) => h.db.conversations.find((c) => c.id === id)!;
const log = () => h.db.automation_logs[0];

beforeEach(() => {
  h.seq = 0;
  h.rpcCalls = [];
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' });
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.tpl' });
  registerNoTemplateChannel();
  seed();
});

describe('wait step saves the conversation', () => {
  it('stores conversation_id and connection_id of the run in the pending row', async () => {
    steps({ step_type: 'wait', step_config: { amount: 1, unit: 'hours' } });

    await fire({ conversation_id: 'cv-old-wa' });

    expect(h.db.automation_pending_executions[0]).toMatchObject({
      conversation_id: 'cv-old-wa',
      connection_id: WA_CONN,
      status: 'pending',
    });
  });

  it("resolves the contact's most recent conversation when the trigger has none in context", async () => {
    steps({ step_type: 'wait', step_config: { amount: 1, unit: 'hours' } });

    await fire();

    expect(h.db.automation_pending_executions[0]).toMatchObject({
      conversation_id: 'cv-new-wa',
      connection_id: WA_CONN,
    });
  });

  it('is ignored, with the reason, when the contact has no conversation at all', async () => {
    h.db.conversations = [];
    steps({ step_type: 'wait', step_config: { amount: 1, unit: 'hours' } });

    await fire();

    expect(h.db.automation_pending_executions).toHaveLength(0);
    const steps_executed = log().steps_executed as {
      status: string;
      detail: string;
    }[];
    expect(steps_executed[0]).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining('no existing conversation'),
    });
  });

  it('the resume sends through the saved conversation, not the context or the most recent one', async () => {
    steps(
      { step_type: 'wait', step_config: { amount: 1, unit: 'minutes' } },
      { step_type: 'send_message', step_config: { text: 'Later' } }
    );
    await fire({ conversation_id: 'cv-old-wa' });
    const pending = h.db.automation_pending_executions[0];
    // The saved conversation is the source of truth on resume.
    pending.conversation_id = 'cv-new-wa';
    pending.context = { tag_id: 'tag-1', conversation_id: 'cv-old-wa' };

    await resumePendingExecution(
      pending as unknown as Parameters<typeof resumePendingExecution>[0]
    );

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      conversation_id: 'cv-new-wa',
      sender_type: 'bot',
      content_text: 'Later',
    });
    expect(conv('cv-new-wa').last_message_text).toBe('Later');
    expect(conv('cv-old-wa').last_message_text).toBe('old');
    expect(pending.status).toBe('done');
  });
});

describe('triggers without a conversation', () => {
  it('sends through the most recent conversation of the contact', async () => {
    steps({ step_type: 'send_message', step_config: { text: 'Hello' } });

    await fire();

    expect(sent()).toHaveLength(1);
    expect(sent()[0].conversation_id).toBe('cv-new-wa');
    expect(conv('cv-old-wa').last_message_text).toBe('old');
    expect(log().status).toBe('success');
  });

  it('skips the most recent conversation when its connection cannot send templates', async () => {
    // The newest thread is on a channel without templates: the template step
    // goes through the newest thread that supports it.
    conv('cv-new-wa').connection_id = TG_CONN;
    steps({
      step_type: 'send_template',
      step_config: { template_name: 'order_update', language: 'en' },
    });

    await fire();

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sent()[0].conversation_id).toBe('cv-old-wa');
    expect(log().status).toBe('success');
  });

  it('is ignored, with the reason, when no conversation is on a connection that supports the step', async () => {
    conv('cv-new-wa').connection_id = TG_CONN;
    conv('cv-old-wa').connection_id = TG_CONN;
    steps(
      {
        step_type: 'send_template',
        step_config: { template_name: 'order_update', language: 'en' },
      },
      { step_type: 'send_message', step_config: { text: 'Never' } }
    );

    await fire();

    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    // Not a failure and not silent: the log says it was ignored, and why.
    expect(log().status).toBe('success');
    expect(log().steps_executed).toEqual([
      expect.objectContaining({
        step_type: 'send_template',
        status: 'skipped',
        detail:
          'ignored: contact has no conversation on a connection that supports templates',
      }),
    ]);
  });
});

describe('disabled connection (US-078)', () => {
  it('fails the step visibly, never calls the provider and stores no message', async () => {
    const wa = h.db.channel_connections.find((c) => c.id === WA_CONN)!;
    wa.disabled_at = '2026-09-01T00:00:00Z';
    steps({ step_type: 'send_message', step_config: { text: 'Hi' } });

    await fire({ conversation_id: 'cv-old-wa' });

    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    expect(conv('cv-old-wa').last_message_text).toBe('old');
    expect(log().status).toBe('failed');
    expect(String(log().error_message)).toMatch(/disabled/i);
  });
});

describe('channel capabilities (US-051, real telegram provider)', () => {
  beforeEach(() => {
    // Replace the stand-in channel with the real providers' capabilities.
    resetRegistryForTests();
    registerBuiltinProviders();
  });

  it('send_template on a telegram conversation logs the step failed with the unsupported message', async () => {
    conv('cv-new-wa').connection_id = TG_CONN;
    h.db.contact_identities = [
      {
        account_id: 'acct-1',
        contact_id: 'ct-1',
        kind: 'telegram:chat_id',
        external_id: '555',
      },
    ];
    steps({
      step_type: 'send_template',
      step_config: { template_name: 'order_update', language: 'en' },
    });

    await fire({ conversation_id: 'cv-new-wa' });

    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    expect(log().status).toBe('failed');
    expect(log().steps_executed).toEqual([
      expect.objectContaining({
        step_type: 'send_template',
        status: 'failed',
        detail: expect.stringMatching(/template/i),
      }),
    ]);
    expect(String(log().error_message)).toMatch(/template/i);
  });

  it('a scheduled send to a contact whose only conversation is on telegram is ignored, with the reason', async () => {
    conv('cv-new-wa').connection_id = TG_CONN;
    conv('cv-old-wa').connection_id = TG_CONN;
    steps({
      step_type: 'send_template',
      step_config: { template_name: 'order_update', language: 'en' },
    });

    await fire();

    expect(sent()).toHaveLength(0);
    expect(log().steps_executed).toEqual([
      expect.objectContaining({
        status: 'skipped',
        detail: expect.stringContaining('supports templates'),
      }),
    ]);
  });

  it('never picks a conversation on a disabled connection (US-051 notes)', async () => {
    // Newest thread: WhatsApp connection disabled. Older thread: enabled one.
    h.db.channel_connections.push({
      ...whatsappConnectionRow('acct-1', 'pn-2'),
      id: 'conn-wa-2',
    });
    conv('cv-old-wa').connection_id = 'conn-wa-2';
    h.db.channel_connections.find((c) => c.id === WA_CONN)!.disabled_at =
      '2026-09-01T00:00:00Z';
    steps({ step_type: 'send_message', step_config: { text: 'Hello' } });

    await fire();

    expect(sent()).toHaveLength(1);
    expect(sent()[0].conversation_id).toBe('cv-old-wa');
    expect(log().status).toBe('success');
  });

  it('all conversations on disabled connections: ignored, no send', async () => {
    h.db.channel_connections.find((c) => c.id === WA_CONN)!.disabled_at =
      '2026-09-01T00:00:00Z';
    steps({ step_type: 'send_message', step_config: { text: 'Hello' } });

    await fire();

    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    expect(log().steps_executed).toEqual([
      expect.objectContaining({ status: 'skipped' }),
    ]);
  });
});

describe('{{menu_link}} (order journey, ticket #3)', () => {
  const STORE_1_URL = 'https://loja1.example.com/cardapio?utm=wa';
  const STORE_2_URL = 'https://loja2.example.org/menu';

  beforeEach(() => {
    h.db.stores = [
      {
        id: 'store-1',
        account_id: 'acct-1',
        name: 'Loja 1',
        menu_url: STORE_1_URL,
      },
      {
        id: 'store-2',
        account_id: 'acct-1',
        name: 'Loja 2',
        menu_url: STORE_2_URL,
      },
    ];
    h.db.channel_connections.find((c) => c.id === WA_CONN)!.store_id =
      'store-1';
    h.db.channel_connections.find((c) => c.id === TG_CONN)!.store_id =
      'store-1';
    h.db.channel_connections.push({
      ...whatsappConnectionRow('acct-1', 'pn-2'),
      id: 'conn-wa-2',
      store_id: 'store-2',
    });
    h.db.conversations.push({
      id: 'cv-store2',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      connection_id: 'conn-wa-2',
      last_message_text: 'hi',
      last_message_at: '2024-02-01T00:00:00Z',
    });
    h.db.messages.push({
      conversation_id: 'cv-store2',
      sender_type: 'customer',
      created_at: new Date().toISOString(),
    });
    h.db.accounts = [{ id: 'acct-1', default_currency: 'BRL' }];
    h.db.pipelines = [];
    h.db.pipeline_stages = [];
    h.db.deals = [];
    h.db.journeys = [];
    h.db.tracking_tokens = [];
    steps({
      step_type: 'send_message',
      step_config: { text: 'Peça aqui: {{menu_link}}' },
    });
  });

  const linkIn = (text: unknown) =>
    new URL(String(text).replace('Peça aqui: ', ''));

  it('sends each store its own address, with an opaque idtrack and the other params kept', async () => {
    await fire({ conversation_id: 'cv-new-wa' });
    await fire({ conversation_id: 'cv-store2' });

    expect(log().status).toBe('success');
    const [first, second] = sent().map((m) => linkIn(m.content_text));
    expect(first.origin + first.pathname).toBe(
      'https://loja1.example.com/cardapio'
    );
    expect(first.searchParams.get('utm')).toBe('wa');
    expect(second.origin + second.pathname).toBe(
      'https://loja2.example.org/menu'
    );
    const t1 = first.searchParams.get('idtrack')!;
    const t2 = second.searchParams.get('idtrack')!;
    expect(t1).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(t1).not.toBe(t2);
    // Opaque: not derived from any id or phone of the contact/conversation.
    for (const t of [t1, t2]) {
      expect(t).not.toContain('ct-1');
      expect(t).not.toContain('cv-');
      expect(t).not.toContain('5551234567');
    }
  });

  it('creates a token that resolves contact, conversation and connection, and mirrors it as an idtrack identity', async () => {
    await fire({ conversation_id: 'cv-store2' });

    const token = linkIn(sent()[0].content_text).searchParams.get('idtrack')!;
    const resolved = await resolveTrackingToken(automationsDb() as never, {
      accountId: 'acct-1',
      token,
    });
    expect(resolved).toMatchObject({
      ok: true,
      contactId: 'ct-1',
      conversationId: 'cv-store2',
      connectionId: 'conn-wa-2',
    });
    expect(
      await resolveTrackingToken(automationsDb() as never, {
        accountId: 'acct-other',
        token,
      })
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(h.db.contact_identities).toEqual([
      expect.objectContaining({
        account_id: 'acct-1',
        contact_id: 'ct-1',
        kind: 'idtrack',
        external_id: token,
      }),
    ]);
  });

  it('a resend renews the same token for 30 days instead of creating a second one', async () => {
    await fire({ conversation_id: 'cv-new-wa' });
    const row = h.db.tracking_tokens[0];
    const token = row.token;
    row.expires_at = new Date(Date.now() + 1000).toISOString();

    await fire({ conversation_id: 'cv-new-wa' });

    expect(h.db.tracking_tokens).toHaveLength(1);
    expect(h.db.tracking_tokens[0].token).toBe(token);
    const days =
      (new Date(String(h.db.tracking_tokens[0].expires_at)).getTime() -
        Date.now()) /
      86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(
      h.db.contact_identities.filter((i) => i.kind === 'idtrack')
    ).toHaveLength(1);
    expect(
      sent().map((m) => linkIn(m.content_text).searchParams.get('idtrack'))
    ).toEqual([token, token]);
  });

  it('an expired token is replaced by a new value (the old link never revives)', async () => {
    await fire({ conversation_id: 'cv-new-wa' });
    const old = String(h.db.tracking_tokens[0].token);
    h.db.tracking_tokens[0].expires_at = '2020-01-01T00:00:00Z';

    await fire({ conversation_id: 'cv-new-wa' });

    expect(h.db.tracking_tokens).toHaveLength(1);
    expect(h.db.tracking_tokens[0].token).not.toBe(old);
    expect(h.db.contact_identities.map((i) => i.external_id)).toEqual([
      h.db.tracking_tokens[0].token,
    ]);
    expect(
      await resolveTrackingToken(automationsDb() as never, {
        accountId: 'acct-1',
        token: old,
      })
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('opens the Journey with its deal at "Link enviado" and reuses both on resend', async () => {
    await fire({ conversation_id: 'cv-new-wa' });

    const [pipeline] = h.db.pipelines;
    expect(pipeline).toMatchObject({
      account_id: 'acct-1',
      name: 'Jornada de Pedido',
    });
    expect(
      [...h.db.pipeline_stages]
        .sort((a, b) => Number(a.position) - Number(b.position))
        .map((s) => s.name)
    ).toEqual([
      'Link enviado',
      'Navegando',
      'Carrinho',
      'Checkout',
      'Comprou',
      'Perdido',
    ]);
    const [journey] = h.db.journeys;
    expect(journey).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'ct-1',
      conversation_id: 'cv-new-wa',
      connection_id: WA_CONN,
      state: 'open',
      stage: 'link_sent',
      link_count: 1,
    });
    expect(typeof journey.link_sent_at).toBe('string');
    const linkSentStage = h.db.pipeline_stages.find(
      (s) => s.name === 'Link enviado'
    )!;
    expect(h.db.deals).toEqual([
      expect.objectContaining({
        id: journey.deal_id,
        journey_id: journey.id,
        pipeline_id: pipeline.id,
        stage_id: linkSentStage.id,
        contact_id: 'ct-1',
        conversation_id: 'cv-new-wa',
        connection_id: WA_CONN,
        status: 'open',
        currency: 'BRL',
      }),
    ]);

    await fire({ conversation_id: 'cv-new-wa' });

    expect(h.db.journeys).toHaveLength(1);
    expect(h.db.journeys[0].link_count).toBe(2);
    expect(h.db.deals).toHaveLength(1);
    expect(h.db.pipelines).toHaveLength(1);
    expect(h.db.pipeline_stages).toHaveLength(6);
  });

  it('a second store opens its own Journey in the same pipeline', async () => {
    await fire({ conversation_id: 'cv-new-wa' });
    await fire({ conversation_id: 'cv-store2' });

    expect(h.db.pipelines).toHaveLength(1);
    expect(h.db.journeys.map((j) => j.connection_id)).toEqual([
      WA_CONN,
      'conn-wa-2',
    ]);
    expect(h.db.deals).toHaveLength(2);
  });

  it('a store without a menu URL fails the step visibly and sends nothing', async () => {
    h.db.stores.find((s) => s.id === 'store-2')!.menu_url = null;

    await fire({ conversation_id: 'cv-store2' });

    expect(log().status).toBe('failed');
    expect(String(log().error_message)).toMatch(/Loja 2.*no menu URL/);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(sent()).toHaveLength(0);
    expect(h.db.tracking_tokens).toHaveLength(0);
    expect(h.db.journeys).toHaveLength(0);
    expect(h.db.deals).toHaveLength(0);
  });

  it('a failed send (window closed) leaves no Journey, and a link never falls back to a template', async () => {
    h.db.messages = h.db.messages.filter(
      (m) => m.conversation_id !== 'cv-store2'
    );
    // Implicit consent is scoped to the connection, and the customer only wrote
    // on another one: an explicit grant keeps this test about the closed window.
    h.db.contact_consents = ['notifications', 'marketing'].map((purpose) => ({
      id: `cc-${purpose}`,
      account_id: 'acct-1',
      contact_id: 'ct-1',
      purpose,
      granted: true,
      given_at: '2026-01-01T00:00:00Z',
      revoked_at: null,
      updated_at: '2026-01-01T00:00:00Z',
    }));
    steps({
      step_type: 'send_message',
      step_config: {
        text: 'Peça aqui: {{menu_link}}',
        fallback_template: { name: 'order_link' },
      },
    });

    await fire({ conversation_id: 'cv-store2' });

    expect(log().status).toBe('failed');
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    expect(h.db.journeys).toHaveLength(0);
    expect(h.db.deals).toHaveLength(0);
  });

  it('works on a Telegram connection through the same chain (no channel-specific code)', async () => {
    // The stand-in channel has no sender; the chain is what is under test.
    const { resolveMenuLink } = await import('@/lib/journeys');
    h.db.conversations.push({
      id: 'cv-tg',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      connection_id: TG_CONN,
      last_message_text: 'oi',
      last_message_at: '2024-03-01T00:00:00Z',
    });
    const link = await resolveMenuLink(automationsDb() as never, {
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'cv-tg',
      contactId: 'ct-1',
    });
    expect(link.connectionId).toBe(TG_CONN);
    expect(new URL(link.url).origin).toBe('https://loja1.example.com');
  });
});

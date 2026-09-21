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
    messages: [],
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

  it('stores nulls when the run has no conversation yet', async () => {
    steps({ step_type: 'wait', step_config: { amount: 1, unit: 'hours' } });

    await fire();

    expect(h.db.automation_pending_executions[0]).toMatchObject({
      conversation_id: null,
      connection_id: null,
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

    expect(h.db.messages).toHaveLength(1);
    expect(h.db.messages[0]).toMatchObject({
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

    expect(h.db.messages).toHaveLength(1);
    expect(h.db.messages[0].conversation_id).toBe('cv-new-wa');
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
    expect(h.db.messages[0].conversation_id).toBe('cv-old-wa');
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
    expect(h.db.messages).toHaveLength(0);
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
    expect(h.db.messages).toHaveLength(0);
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
    expect(h.db.messages).toHaveLength(0);
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

    expect(h.db.messages).toHaveLength(0);
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

    expect(h.db.messages).toHaveLength(1);
    expect(h.db.messages[0].conversation_id).toBe('cv-old-wa');
    expect(log().status).toBe('success');
  });

  it('all conversations on disabled connections: ignored, no send', async () => {
    h.db.channel_connections.find((c) => c.id === WA_CONN)!.disabled_at =
      '2026-09-01T00:00:00Z';
    steps({ step_type: 'send_message', step_config: { text: 'Hello' } });

    await fire();

    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(h.db.messages).toHaveLength(0);
    expect(log().steps_executed).toEqual([
      expect.objectContaining({ status: 'skipped' }),
    ]);
  });
});

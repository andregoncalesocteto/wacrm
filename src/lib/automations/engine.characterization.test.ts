/**
 * Characterization tests for what the Automations engine SENDS (US-004,
 * channel-abstraction). They pin the CURRENT behaviour of the real engine
 * (`runAutomationsForTrigger`, `resumePendingExecution`) driving the real
 * `./send` senders: text, template and interactive steps persist a bot
 * message and update the conversation they were sent through, a wait step
 * parks the run, and the resume after the wait sends through the
 * contact's conversation. Only the Meta HTTP senders are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';

import { phoneVariants } from '@/lib/whatsapp/phone-utils';
import { resumePendingExecution, runAutomationsForTrigger } from './engine';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  rpcCalls: [] as { name: string; args: unknown }[],
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: h.sendTextMessage,
  sendTemplateMessage: h.sendTemplateMessage,
  sendInteractiveButtons: h.sendInteractiveButtons,
  sendInteractiveList: h.sendInteractiveList,
}));

vi.mock('@/lib/channels/admin-client', async () => {
  const { fakeCredentialsAdmin } = await import(
    '@/lib/channels/credentials-admin.fake'
  );
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

const PHONE = '+15551234567';
const FIRST_VARIANT = '15551234567';

function seed() {
  h.db = {
    contacts: [{ id: 'ct-1', account_id: 'acct-1', phone: PHONE }],
    conversations: [
      {
        id: 'cv-1',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        last_message_text: 'old',
        last_message_at: '2020-01-01T00:00:00Z',
      },
      {
        id: 'cv-other',
        account_id: 'acct-1',
        contact_id: 'ct-other',
        last_message_text: 'other-old',
        last_message_at: '2020-01-01T00:00:00Z',
      },
    ],
    channel_connections: [whatsappConnectionRow('acct-1', 'pn-1')],
    channel_connection_credentials: [
      { secrets_encrypted: 'cipher', secrets_format: 'wa_token_v0' },
    ],
    message_templates: [],
    messages: [],
    automations: [
      {
        id: 'au-1',
        account_id: 'acct-1',
        user_id: 'user-1',
        trigger_type: 'new_contact_created',
        trigger_config: {},
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

const fire = (context: Row = { conversation_id: 'cv-1' }) =>
  runAutomationsForTrigger({
    accountId: 'acct-1',
    triggerType: 'new_contact_created',
    contactId: 'ct-1',
    context,
  });

const messages = () => h.db.messages;
const conv = (id = 'cv-1') => h.db.conversations.find((c) => c.id === id)!;
const log = () => h.db.automation_logs[0];

beforeEach(() => {
  h.seq = 0;
  h.rpcCalls = [];
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' });
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.tpl' });
  h.sendInteractiveButtons.mockResolvedValue({ messageId: 'wamid.btn' });
  h.sendInteractiveList.mockResolvedValue({ messageId: 'wamid.list' });
  seed();
});

describe('automation send_message step', () => {
  it('sends the interpolated text through the conversation of the trigger and persists it', async () => {
    steps({
      step_type: 'send_message',
      step_config: { text: 'Hi {{message.text}}' },
    });

    await fire({ conversation_id: 'cv-1', message_text: 'there' });

    expect(h.sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'dec:cipher',
      to: FIRST_VARIANT,
      text: 'Hi there',
    });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      content_type: 'text',
      content_text: 'Hi there',
      template_name: null,
      message_id: 'wamid.text',
      status: 'sent',
    });
    expect(conv().last_message_text).toBe('Hi there');
    expect(conv().last_message_at).not.toBe('2020-01-01T00:00:00Z');
    // The other conversation of the account is untouched.
    expect(conv('cv-other').last_message_text).toBe('other-old');
    expect(log()).toMatchObject({ status: 'success' });
    expect(log().steps_executed).toEqual([
      expect.objectContaining({
        step_type: 'send_message',
        status: 'success',
        detail: 'sent via Meta (wamid.text)',
      }),
    ]);
    expect(h.rpcCalls.map((c) => c.name)).toContain(
      'increment_automation_execution_count'
    );
  });

  it('without a conversation in the context it falls back to the contact conversation', async () => {
    steps({ step_type: 'send_message', step_config: { text: 'Hello' } });

    await fire({});

    expect(messages()[0].conversation_id).toBe('cv-1');
    expect(conv().last_message_text).toBe('Hello');
  });

  it('fails the step when the contact has no conversation and sends nothing', async () => {
    h.db.conversations = [];
    steps({ step_type: 'send_message', step_config: { text: 'Hello' } });

    await fire({});

    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(log().status).toBe('failed');
    expect(log().error_message).toBe(
      'cannot send: contact has no existing conversation'
    );
  });

  it('a Meta failure fails the step and the run, persisting no message', async () => {
    h.sendTextMessage.mockRejectedValue(new Error('(#100) boom'));
    steps(
      { step_type: 'send_message', step_config: { text: 'One' } },
      { step_type: 'send_message', step_config: { text: 'Two' } }
    );

    await fire();

    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(messages()).toHaveLength(0);
    expect(conv().last_message_text).toBe('old');
    expect(log()).toMatchObject({
      status: 'failed',
      error_message: '(#100) boom',
    });
    expect(log().steps_executed).toHaveLength(1);
  });

  it('rejects empty text before calling Meta', async () => {
    steps({ step_type: 'send_message', step_config: { text: '   ' } });
    await fire();
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(log().error_message).toBe('send_message has empty text');
  });
});

describe('automation send_template step', () => {
  beforeEach(() => {
    h.db.message_templates = [
      {
        id: 'tpl-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        name: 'order_update',
        category: 'Utility',
        language: 'en',
        body_text: 'Order {{1}} ships {{2}}',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
  });

  it('sends the template with params in numeric order and persists the rendered body', async () => {
    steps({
      step_type: 'send_template',
      step_config: {
        template_name: 'order_update',
        language: 'en',
        variables: { '2': 'today', '10': 'ten', '1': 'A1' },
      },
    });

    await fire();

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      phoneNumberId: 'pn-1',
      accessToken: 'dec:cipher',
      to: FIRST_VARIANT,
      templateName: 'order_update',
      language: 'en',
      params: ['A1', 'today', 'ten'],
    });
    expect(messages()[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      content_type: 'template',
      content_text: 'Order A1 ships today',
      template_name: 'order_update',
      message_id: 'wamid.tpl',
      status: 'sent',
    });
    expect(conv().last_message_text).toBe('Order A1 ships today');
    expect(log().steps_executed).toEqual([
      expect.objectContaining({ detail: 'template sent via Meta (wamid.tpl)' }),
    ]);
  });

  it('without a local template row the send still goes out and the preview is "[template:name]"', async () => {
    h.db.message_templates = [];
    steps({
      step_type: 'send_template',
      step_config: { template_name: 'unknown_tpl' },
    });

    await fire();

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(messages()[0]).toMatchObject({
      content_type: 'template',
      content_text: null,
      template_name: 'unknown_tpl',
    });
    expect(conv().last_message_text).toBe('[template:unknown_tpl]');
  });

  it('requires a template_name', async () => {
    steps({ step_type: 'send_template', step_config: {} });
    await fire();
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    expect(log().error_message).toBe('send_template needs template_name');
  });
});

describe('automation interactive steps', () => {
  it('send_buttons goes through the flows interactive sender and persists the payload', async () => {
    const buttons = [
      { id: 'yes', title: 'Yes' },
      { id: 'no', title: 'No' },
    ];
    steps({
      step_type: 'send_buttons',
      step_config: { kind: 'buttons', body: 'Confirm?', buttons },
    });

    await fire();

    expect(h.sendInteractiveButtons).toHaveBeenCalledTimes(1);
    expect(messages()[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      content_type: 'interactive',
      content_text: 'Confirm?',
      message_id: 'wamid.btn',
      interactive_payload: { kind: 'buttons', body: 'Confirm?', buttons },
    });
    expect(conv().last_message_text).toBe('Confirm?');
    expect(log().steps_executed).toEqual([
      expect.objectContaining({
        detail: 'interactive sent via Meta (wamid.btn)',
      }),
    ]);
  });

  it('send_list persists a list payload', async () => {
    steps({
      step_type: 'send_list',
      step_config: {
        kind: 'list',
        body: 'Menu',
        button_label: 'Open',
        sections: [{ rows: [{ id: 'r1', title: 'One' }] }],
      },
    });

    await fire();

    expect(h.sendInteractiveList).toHaveBeenCalledTimes(1);
    expect(messages()[0]).toMatchObject({
      content_type: 'interactive',
      message_id: 'wamid.list',
      interactive_payload: { kind: 'list', body: 'Menu', button_label: 'Open' },
    });
  });

  it('an invalid payload fails the step before Meta is called', async () => {
    steps({
      step_type: 'send_buttons',
      step_config: { kind: 'buttons', body: 'Only', buttons: [] },
    });
    await fire();
    expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(log().status).toBe('failed');
  });
});

describe('wait step and resume', () => {
  it('a wait step parks the run (status partial) and later steps do not send yet', async () => {
    steps(
      { step_type: 'send_message', step_config: { text: 'Before' } },
      { step_type: 'wait', step_config: { amount: 2, unit: 'hours' } },
      { step_type: 'send_message', step_config: { text: 'After' } }
    );

    await fire({ conversation_id: 'cv-1', message_text: 'x' });

    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(messages().map((m) => m.content_text)).toEqual(['Before']);
    expect(log().status).toBe('partial');
    const pending = h.db.automation_pending_executions;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      automation_id: 'au-1',
      account_id: 'acct-1',
      user_id: 'user-1',
      contact_id: 'ct-1',
      log_id: log().id,
      next_step_position: 2,
      status: 'pending',
      context: { conversation_id: 'cv-1', message_text: 'x' },
    });
    const dueIn = Date.parse(pending[0].run_at as string) - Date.now();
    expect(dueIn).toBeGreaterThan(2 * 3_600_000 - 60_000);
    expect(dueIn).toBeLessThanOrEqual(2 * 3_600_000);
  });

  it('resuming sends the remaining steps through the right conversation and marks the row done', async () => {
    steps(
      { step_type: 'send_message', step_config: { text: 'Before' } },
      { step_type: 'wait', step_config: { amount: 1, unit: 'minutes' } },
      {
        step_type: 'send_message',
        step_config: { text: 'After {{message.text}}' },
      }
    );
    await fire({ conversation_id: 'cv-1', message_text: 'x' });
    const pending = h.db.automation_pending_executions[0] as Row;

    await resumePendingExecution(
      pending as unknown as Parameters<typeof resumePendingExecution>[0]
    );

    expect(h.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(messages().map((m) => [m.conversation_id, m.content_text])).toEqual([
      ['cv-1', 'Before'],
      ['cv-1', 'After x'],
    ]);
    expect(conv().last_message_text).toBe('After x');
    expect(conv('cv-other').last_message_text).toBe('other-old');
    expect(pending.status).toBe('done');
    // The resumed pass adds its result to the SAME log.
    expect(log().steps_executed).toHaveLength(3);
    expect(log().status).toBe('success');
  });

  it('resuming without a conversation in the saved context uses the contact conversation', async () => {
    steps(
      { step_type: 'wait', step_config: { amount: 1, unit: 'minutes' } },
      { step_type: 'send_message', step_config: { text: 'Later' } }
    );
    await fire({});
    const pending = h.db.automation_pending_executions[0] as Row;

    await resumePendingExecution(
      pending as unknown as Parameters<typeof resumePendingExecution>[0]
    );

    expect(messages()[0]).toMatchObject({
      conversation_id: 'cv-1',
      content_text: 'Later',
    });
    expect(pending.status).toBe('done');
  });

  it('resuming marks the row failed when the automation no longer exists', async () => {
    steps({ step_type: 'wait', step_config: { amount: 1, unit: 'minutes' } });
    await fire();
    h.db.automations = [];
    const pending = h.db.automation_pending_executions[0] as Row;

    await resumePendingExecution(
      pending as unknown as Parameters<typeof resumePendingExecution>[0]
    );

    expect(pending.status).toBe('failed');
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('a resumed send that fails leaves the run failed but the pending row done', async () => {
    steps(
      { step_type: 'wait', step_config: { amount: 1, unit: 'minutes' } },
      { step_type: 'send_message', step_config: { text: 'Later' } }
    );
    await fire();
    const pending = h.db.automation_pending_executions[0] as Row;
    h.sendTextMessage.mockRejectedValue(new Error('(#100) boom'));

    await resumePendingExecution(
      pending as unknown as Parameters<typeof resumePendingExecution>[0]
    );

    expect(messages()).toHaveLength(0);
    // executeStepsFrom swallows step errors into the log, so the wait row
    // is still closed as done.
    expect(pending.status).toBe('done');
    expect(log().status).toBe('failed');
    expect(log().error_message).toBe('(#100) boom');
  });
});

describe('phone-variant retry in automation sends', () => {
  it('tries the next variant on "recipient not allowed" and corrects the contact phone', async () => {
    const variants = phoneVariants(FIRST_VARIANT);
    h.sendTextMessage
      .mockRejectedValueOnce(
        new Error('(#131030) Recipient phone number not in allowed list')
      )
      .mockResolvedValueOnce({ messageId: 'wamid.v2' });
    steps({ step_type: 'send_message', step_config: { text: 'Hi' } });

    await fire();

    expect(h.sendTextMessage.mock.calls.map((c) => c[0].to)).toEqual(
      variants.slice(0, 2)
    );
    expect(h.db.contacts[0].phone).toBe(variants[1]);
    expect(messages()[0].message_id).toBe('wamid.v2');
  });
});

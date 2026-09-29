/**
 * Characterization tests for what the Automations engine SENDS (US-004,
 * channel-abstraction). They pin the CURRENT behaviour of the real engine
 * (`runAutomationsForTrigger`, `resumePendingExecution`) driving the real
 * `./send` senders: text, template and interactive steps persist a bot
 * message and update the conversation they were sent through, a wait step
 * parks the run, and the resume after the wait sends through the
 * contact's conversation. Only the Meta HTTP senders are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    messages: [
      // Reply window open (automation texts are window-aware): one recent
      // customer message per conversation. Assertions use the sent-only view.
      ...['cv-1', 'cv-other'].map((id) => ({
        conversation_id: id,
        sender_type: 'customer',
        created_at: new Date().toISOString(),
      })),
    ],
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

const messages = () =>
  h.db.messages.filter((m) => m.sender_type !== 'customer');
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

describe('journey_event trigger and journey conditions', () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const HOUR = 3_600_000;

  /** cv-1 on the WhatsApp connection, its last customer message 2 h ago. */
  function journeySeed(journey: Row | null = {}) {
    conv().connection_id = 'conn-acct-1';
    for (const m of h.db.messages) m.created_at = ago(2 * HOUR);
    h.db.journeys = journey
      ? [
          {
            id: 'jr-1',
            account_id: 'acct-1',
            contact_id: 'ct-1',
            connection_id: 'conn-acct-1',
            state: 'open',
            link_sent_at: ago(HOUR),
            ...journey,
          },
        ]
      : [];
  }

  /** condition -> 'Yes' / 'No' text, so the sent message names the branch. */
  function conditionSteps(cfg: Row, ...before: Row[]) {
    const n = before.length;
    steps(
      ...before,
      { step_type: 'condition', step_config: cfg },
      {
        id: 'st-yes',
        parent_step_id: `st-${n + 1}`,
        branch: 'yes',
        step_type: 'send_message',
        step_config: { text: 'Yes' },
      },
      {
        id: 'st-no',
        parent_step_id: `st-${n + 1}`,
        branch: 'no',
        step_type: 'send_message',
        step_config: { text: 'No' },
      }
    );
    // helper numbered by index: the two branch rows sit at position 0 of
    // their own scope.
    for (const s of h.db.automation_steps)
      if (s.parent_step_id) s.position = 0;
  }
  const sent = () => messages().map((m) => m.content_text);
  const customerSays = (atMs: number) =>
    h.db.messages.push({
      conversation_id: 'cv-1',
      sender_type: 'customer',
      created_at: new Date(atMs).toISOString(),
    });
  const resume = () =>
    resumePendingExecution(
      h.db.automation_pending_executions[0] as unknown as Parameters<
        typeof resumePendingExecution
      >[0]
    );

  describe('trigger', () => {
    const fireJourney = (name: string) =>
      runAutomationsForTrigger({
        accountId: 'acct-1',
        triggerType: 'journey_event',
        contactId: 'ct-1',
        context: {
          conversation_id: 'cv-1',
          journey_id: 'jr-1',
          journey_event_name: name,
        },
      });

    beforeEach(() => {
      journeySeed();
      h.db.automations[0].trigger_type = 'journey_event';
      h.db.automations[0].trigger_config = {
        event_names: ['AddToCart', 'Purchase'],
      };
      steps({ step_type: 'send_message', step_config: { text: 'Hi' } });
    });

    it('fires for a configured event name', async () => {
      await fireJourney('Purchase');
      expect(sent()).toEqual(['Hi']);
      expect(log().trigger_event).toBe('journey_event');
    });

    it('does not fire for another event name', async () => {
      await fireJourney('ViewContent');
      expect(sent()).toEqual([]);
      expect(h.db.automation_logs).toHaveLength(0);
    });
  });

  describe('journey_open', () => {
    it('reads the open Journey as true and a closed one as false', async () => {
      journeySeed({ state: 'open' });
      conditionSteps({ subject: 'journey_open' });
      await fire();
      expect(sent()).toEqual(['Yes']);
    });

    it('is false once the Journey is won', async () => {
      journeySeed({ state: 'won' });
      conditionSteps({ subject: 'journey_open' });
      await fire();
      expect(sent()).toEqual(['No']);
    });

    it('is false when the contact has no Journey', async () => {
      journeySeed(null);
      conditionSteps({ subject: 'journey_open' });
      await fire();
      expect(sent()).toEqual(['No']);
    });

    it('looks at the Journey named by the trigger, so a just-closed one is closed', async () => {
      journeySeed({ state: 'won' });
      conditionSteps({ subject: 'journey_open' });
      await fire({ conversation_id: 'cv-1', journey_id: 'jr-1' });
      expect(sent()).toEqual(['No']);
    });

    it('is re-read on resume: the Journey closing during the wait flips the branch', async () => {
      journeySeed({ state: 'open' });
      conditionSteps(
        { subject: 'journey_open' },
        { step_type: 'wait', step_config: { amount: 1, unit: 'minutes' } }
      );
      await fire();
      expect(sent()).toEqual([]);

      h.db.journeys[0].state = 'won';
      await resume();

      expect(sent()).toEqual(['No']);
    });
  });

  describe('customer_replied_since', () => {
    it('link_sent: false when the last customer message predates the link', async () => {
      journeySeed({ link_sent_at: ago(HOUR) });
      conditionSteps({ subject: 'customer_replied_since', operand: 'link_sent' });
      await fire();
      expect(sent()).toEqual(['No']);
    });

    it('link_sent: true when the customer wrote after the link', async () => {
      journeySeed({ link_sent_at: ago(HOUR) });
      customerSays(Date.now() - 60_000);
      conditionSteps({ subject: 'customer_replied_since', operand: 'link_sent' });
      await fire();
      expect(sent()).toEqual(['Yes']);
    });

    it('link_sent: ignores the bot and agent messages', async () => {
      journeySeed({ link_sent_at: ago(HOUR) });
      h.db.messages.push({
        conversation_id: 'cv-1',
        sender_type: 'bot',
        created_at: ago(60_000),
      });
      conditionSteps({ subject: 'customer_replied_since', operand: 'link_sent' });
      await fire();
      expect(sent().filter((t) => t === 'Yes' || t === 'No')).toEqual(['No']);
    });

    it('link_sent: false without a Journey', async () => {
      journeySeed(null);
      customerSays(Date.now() - 60_000);
      conditionSteps({ subject: 'customer_replied_since', operand: 'link_sent' });
      await fire();
      expect(sent()).toEqual(['No']);
    });

    it('run_start: is re-evaluated on resume, so a reply DURING the wait counts', async () => {
      journeySeed();
      conditionSteps(
        { subject: 'customer_replied_since', operand: 'run_start' },
        { step_type: 'wait', step_config: { amount: 1, unit: 'minutes' } }
      );
      await fire();
      expect(sent()).toEqual([]);

      customerSays(Date.now() + 5_000);
      await resume();

      expect(sent()).toEqual(['Yes']);
    });

    it('run_start: no reply during the wait takes the no branch', async () => {
      journeySeed();
      conditionSteps(
        { subject: 'customer_replied_since', operand: 'run_start' },
        { step_type: 'wait', step_config: { amount: 1, unit: 'minutes' } }
      );
      await fire();
      await resume();
      expect(sent()).toEqual(['No']);
    });

    it('an unknown reference is false', async () => {
      journeySeed();
      customerSays(Date.now() + 5_000);
      conditionSteps({ subject: 'customer_replied_since', operand: 'bogus' });
      await fire();
      expect(sent()).toEqual(['No']);
    });
  });
});

function customerSays(atMs: number) {
  h.db.messages.push({
    conversation_id: 'cv-1',
    sender_type: 'customer',
    created_at: new Date(atMs).toISOString(),
  });
}

describe('menu_link_sent Resumption chain (wait 10 -> checks -> R1 -> wait 20 -> checks -> R2)', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-09-29T12:00:00Z');
  const at = (ms: number) => new Date(ms).toISOString();

  /** The three checks every Resumption re-evaluates when it is due. */
  function checks(startId: number, position: number, send: Row): Row[] {
    const a = startId; // unattended
    const b = startId + 1; // stage before cart
    const c = startId + 2; // replied since the link (the "no" branch sends)
    return [
      {
        id: `st-${a}`,
        position,
        step_type: 'condition',
        step_config: { subject: 'conversation_unattended' },
      },
      {
        id: `st-${b}`,
        parent_step_id: `st-${a}`,
        branch: 'yes',
        position: 0,
        step_type: 'condition',
        step_config: { subject: 'journey_stage', operand: 'cart', value: 'before' },
      },
      {
        id: `st-${c}`,
        parent_step_id: `st-${b}`,
        branch: 'yes',
        position: 0,
        step_type: 'condition',
        step_config: { subject: 'customer_replied_since', operand: 'link_sent' },
      },
      {
        ...send,
        parent_step_id: `st-${c}`,
        branch: 'no',
        position: 0,
      },
    ];
  }

  function chain(r1: Row = { text: 'R1' }, r2: Row = { text: 'R2' }) {
    // st-1 wait 10 | st-2..st-5 checks + R1 (st-5) | R1's scope continues with
    // wait 20 (st-6) and the second round of checks + R2.
    const round1 = checks(2, 1, {
      id: 'st-5',
      step_type: 'send_message',
      step_config: r1,
    });
    const rest: Row[] = [
      {
        id: 'st-6',
        parent_step_id: 'st-4',
        branch: 'no',
        position: 1,
        step_type: 'wait',
        step_config: { amount: 20, unit: 'minutes' },
      },
      ...checks(7, 2, {
        id: 'st-10',
        step_type: 'send_message',
        step_config: r2,
      }).map((st) =>
        // the second round lives in the same scope as the wait (st-4 / no)
        st.id === 'st-7' ? { ...st, parent_step_id: 'st-4', branch: 'no' } : st
      ),
    ];
    h.db.automation_steps = [
      {
        id: 'st-1',
        position: 0,
        parent_step_id: null,
        branch: null,
        step_type: 'wait',
        step_config: { amount: 10, unit: 'minutes' },
      },
      ...round1,
      ...rest,
    ].map((st) => ({ automation_id: 'au-1', parent_step_id: null, branch: null, ...st }));
  }

  const pending = () =>
    h.db.automation_pending_executions.filter((p) => p.status === 'pending');
  const sent = () => messages().map((m) => m.content_text);

  /** Link sent at `T0`: journey open, customer last wrote before it. */
  async function linkSent(journey: Row = {}, context: Row = {}) {
    vi.setSystemTime(T0);
    h.db.automations[0].trigger_type = 'menu_link_sent';
    h.db.automations[0].trigger_config = {};
    conv().connection_id = 'conn-acct-1';
    for (const m of h.db.messages) m.created_at = at(T0 - 5 * MIN);
    h.db.journeys = [
      {
        id: 'jr-1',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        connection_id: 'conn-acct-1',
        state: 'open',
        stage: 'link_sent',
        link_sent_at: at(T0),
        ...journey,
      },
    ];
    await runAutomationsForTrigger({
      accountId: 'acct-1',
      triggerType: 'menu_link_sent',
      contactId: 'ct-1',
      context: {
        conversation_id: 'cv-1',
        connection_id: 'conn-acct-1',
        journey_id: 'jr-1',
        menu_link_sent_at: at(T0),
        ...context,
      },
    });
  }

  /** Advance the clock and run the parked step, as the cron would. */
  async function tick(minutes: number) {
    vi.setSystemTime(T0 + minutes * MIN);
    const due = pending().filter((p) => Date.parse(p.run_at as string) <= Date.now());
    for (const p of due) {
      await resumePendingExecution(
        p as unknown as Parameters<typeof resumePendingExecution>[0]
      );
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    chain();
  });
  afterEach(() => vi.useRealTimers());

  it('parks the first Resumption 10 minutes after the link', async () => {
    await linkSent();
    expect(sent()).toEqual([]);
    expect(pending()).toHaveLength(1);
    expect(Date.parse(pending()[0].run_at as string) - T0).toBe(10 * MIN);
    await tick(9);
    expect(sent()).toEqual([]);
  });

  it('without a reply, sends R1 at 10 min and R2 at 30 min', async () => {
    await linkSent();
    await tick(10);
    expect(sent()).toEqual(['R1']);
    expect(pending()).toHaveLength(1);
    expect(Date.parse(pending()[0].run_at as string) - T0).toBe(30 * MIN);

    await tick(29);
    expect(sent()).toEqual(['R1']);
    await tick(30);
    expect(sent()).toEqual(['R1', 'R2']);
    expect(pending()).toHaveLength(0);
  });

  it('a reply before 10 min suppresses both', async () => {
    await linkSent();
    customerSays(T0 + 4 * MIN);
    await tick(10);
    expect(sent()).toEqual([]);
    expect(pending()).toHaveLength(0);
  });

  it('a reply between R1 and 30 min suppresses only R2', async () => {
    await linkSent();
    await tick(10);
    customerSays(T0 + 15 * MIN);
    await tick(30);
    expect(sent()).toEqual(['R1']);
  });

  it.each(['cart', 'checkout'])(
    'reaching %s before the due time suppresses the Resumption',
    async (stage) => {
      await linkSent();
      h.db.journeys[0].stage = stage;
      await tick(10);
      expect(sent()).toEqual([]);
    }
  );

  it('browsing (ViewContent) does not interrupt', async () => {
    await linkSent();
    h.db.journeys[0].stage = 'browsing';
    await tick(10);
    expect(sent()).toEqual(['R1']);
  });

  it('reaching the cart after R1 suppresses R2', async () => {
    await linkSent();
    await tick(10);
    h.db.journeys[0].stage = 'cart';
    await tick(30);
    expect(sent()).toEqual(['R1']);
  });

  it('a Purchase (Journey won) during the wait suppresses both', async () => {
    await linkSent();
    Object.assign(h.db.journeys[0], { state: 'won', stage: 'won' });
    await tick(10);
    expect(sent()).toEqual([]);
  });

  it('an agent assigned during the wait suppresses the Resumption', async () => {
    await linkSent();
    conv().assigned_agent_id = 'agent-1';
    await tick(10);
    expect(sent()).toEqual([]);
  });

  it('an AI handoff during the wait suppresses the Resumption', async () => {
    await linkSent();
    conv().ai_autoreply_disabled = true;
    await tick(10);
    expect(sent()).toEqual([]);
  });

  it('a handoff after R1 suppresses R2 (checked again at 30 min)', async () => {
    await linkSent();
    await tick(10);
    conv().ai_autoreply_disabled = true;
    await tick(30);
    expect(sent()).toEqual(['R1']);
  });

  it('a renewed link supersedes the parked run of the previous link', async () => {
    await linkSent();
    const first = pending()[0];
    vi.setSystemTime(T0 + 3 * MIN);
    h.db.journeys[0].link_sent_at = at(T0 + 3 * MIN);
    await runAutomationsForTrigger({
      accountId: 'acct-1',
      triggerType: 'menu_link_sent',
      contactId: 'ct-1',
      context: {
        conversation_id: 'cv-1',
        journey_id: 'jr-1',
        menu_link_sent_at: at(T0 + 3 * MIN),
      },
    });
    expect(first.status).toBe('cancelled');
    expect(pending()).toHaveLength(1);
    await tick(10);
    expect(sent()).toEqual([]);
    await tick(13);
    expect(sent()).toEqual(['R1']);
  });

  it('outside the 24 h window, sends the fallback template', async () => {
    chain({
      text: 'R1',
      fallback_template: { name: 'resume_tpl', language: 'en_US', variables: { '1': 'x' } },
    });
    h.db.message_templates = [
      {
        id: 'tpl-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        name: 'resume_tpl',
        category: 'Utility',
        language: 'en_US',
        body_text: 'Still there? {{1}}',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    await linkSent();
    for (const m of h.db.messages) m.created_at = at(T0 - 30 * 60 * MIN);
    await tick(10);
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('outside the 24 h window without a template, fails visibly', async () => {
    await linkSent();
    for (const m of h.db.messages) m.created_at = at(T0 - 30 * 60 * MIN);
    await tick(10);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(log().status).toBe('failed');
    expect(String(log().error_message)).toMatch(/window/i);
  });

  it('refuses {{menu_link}} inside a menu_link_sent run (it would loop)', async () => {
    h.db.automation_steps = [
      {
        id: 'st-1',
        automation_id: 'au-1',
        position: 0,
        parent_step_id: null,
        branch: null,
        step_type: 'send_message',
        step_config: { text: 'Again {{menu_link}}' },
      },
    ];
    await linkSent();
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(log().status).toBe('failed');
  });
});

describe('journey_stage and conversation_unattended conditions', () => {
  function stageCase(stage: string, cfg: Row) {
    conv().connection_id = 'conn-acct-1';
    h.db.journeys = [
      {
        id: 'jr-1',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        connection_id: 'conn-acct-1',
        state: 'open',
        stage,
      },
    ];
    h.db.automation_steps = [
      { id: 'st-1', position: 0, step_type: 'condition', step_config: cfg },
      { id: 'st-y', position: 0, parent_step_id: 'st-1', branch: 'yes', step_type: 'send_message', step_config: { text: 'Yes' } },
      { id: 'st-n', position: 0, parent_step_id: 'st-1', branch: 'no', step_type: 'send_message', step_config: { text: 'No' } },
    ].map((st) => ({ automation_id: 'au-1', parent_step_id: null, branch: null, ...st }));
  }
  const out = () => messages().map((m) => m.content_text);

  it.each([
    ['link_sent', 'before', 'cart', 'Yes'],
    ['browsing', 'before', 'cart', 'Yes'],
    ['cart', 'before', 'cart', 'No'],
    ['checkout', 'before', 'cart', 'No'],
    ['lost', 'before', 'cart', 'No'],
    ['cart', 'is', 'cart', 'Yes'],
    ['browsing', 'is', 'cart', 'No'],
    ['browsing', 'bogus', 'cart', 'No'],
    ['browsing', 'before', 'bogus', 'No'],
  ])('stage %s %s %s -> %s', async (stage, value, operand, expected) => {
    stageCase(stage, { subject: 'journey_stage', operand, value });
    await fire();
    expect(out()).toEqual([expected]);
  });

  it('journey_stage is false without a Journey', async () => {
    stageCase('browsing', { subject: 'journey_stage', operand: 'cart', value: 'before' });
    h.db.journeys = [];
    await fire();
    expect(out()).toEqual(['No']);
  });

  it('conversation_unattended: true with no agent and no handoff', async () => {
    stageCase('link_sent', { subject: 'conversation_unattended' });
    await fire();
    expect(out()).toEqual(['Yes']);
  });

  it('conversation_unattended: false with an agent', async () => {
    stageCase('link_sent', { subject: 'conversation_unattended' });
    conv().assigned_agent_id = 'agent-1';
    await fire();
    expect(out()).toEqual(['No']);
  });

  it('conversation_unattended: false after an AI handoff', async () => {
    stageCase('link_sent', { subject: 'conversation_unattended' });
    conv().ai_autoreply_disabled = true;
    await fire();
    expect(out()).toEqual(['No']);
  });
});

describe('Abandoned cart chain (journey_event AddToCart/InitiateCheckout -> wait 10 -> checks -> message, once)', () => {
  const MIN = 60_000;
  const T0 = Date.parse('2026-09-29T12:00:00Z');
  const at = (ms: number) => new Date(ms).toISOString();
  const CART_EVENTS = ['AddToCart', 'InitiateCheckout'];

  const step = (automation: string, id: string, st: Row): Row => ({
    automation_id: automation,
    parent_step_id: null,
    branch: null,
    position: 0,
    id: `${automation}-${id}`,
    ...st,
  });
  const child = (automation: string, id: string, parent: string, branch: 'yes' | 'no', st: Row) =>
    step(automation, id, { ...st, parent_step_id: `${automation}-${parent}`, branch });

  /** The pattern the abandoned-cart preset is made of, as data. */
  function cartChain(text = 'Cart?', extra: Row = {}) {
    return [
      step('au-1', 'wait', { step_type: 'wait', step_config: { amount: 10, unit: 'minutes' } }),
      step('au-1', 'unattended', {
        position: 1,
        step_type: 'condition',
        step_config: { subject: 'conversation_unattended' },
      }),
      child('au-1', 'open', 'unattended', 'yes', {
        step_type: 'condition',
        step_config: { subject: 'journey_open' },
      }),
      child('au-1', 'replied', 'open', 'yes', {
        step_type: 'condition',
        step_config: { subject: 'customer_replied_since', operand: 'run_start' },
      }),
      child('au-1', 'flag', 'replied', 'no', {
        step_type: 'condition',
        step_config: { subject: 'journey_flag', operand: 'abandoned_cart_sent' },
      }),
      child('au-1', 'send', 'flag', 'no', {
        step_type: 'send_message',
        step_config: { text, mark_journey_flag: 'abandoned_cart_sent', ...extra },
      }),
    ];
  }

  /** The generic Resumption (#9): wait 10 -> unattended -> before cart -> no reply -> send. */
  function genericChain() {
    return [
      step('au-2', 'wait', { step_type: 'wait', step_config: { amount: 10, unit: 'minutes' } }),
      step('au-2', 'unattended', {
        position: 1,
        step_type: 'condition',
        step_config: { subject: 'conversation_unattended' },
      }),
      child('au-2', 'stage', 'unattended', 'yes', {
        step_type: 'condition',
        step_config: { subject: 'journey_stage', operand: 'cart', value: 'before' },
      }),
      child('au-2', 'replied', 'stage', 'yes', {
        step_type: 'condition',
        step_config: { subject: 'customer_replied_since', operand: 'link_sent' },
      }),
      child('au-2', 'send', 'replied', 'no', {
        step_type: 'send_message',
        step_config: { text: 'Generic' },
      }),
    ];
  }

  const pending = () => h.db.automation_pending_executions.filter((p) => p.status === 'pending');
  const sent = () => messages().map((m) => m.content_text);
  const journey = () => h.db.journeys[0];

  /** A cart / checkout event accepted for the Journey at `minute`. */
  async function event(name: string, minute: number) {
    vi.setSystemTime(T0 + minute * MIN);
    await runAutomationsForTrigger({
      accountId: 'acct-1',
      triggerType: 'journey_event',
      contactId: 'ct-1',
      context: {
        conversation_id: 'cv-1',
        connection_id: 'conn-acct-1',
        journey_id: 'jr-1',
        journey_event_name: name,
        journey_stage: name === 'InitiateCheckout' ? 'checkout' : 'cart',
      },
    });
  }

  async function tick(minute: number) {
    vi.setSystemTime(T0 + minute * MIN);
    const due = pending().filter((p) => Date.parse(p.run_at as string) <= Date.now());
    for (const p of due) {
      await resumePendingExecution(p as unknown as Parameters<typeof resumePendingExecution>[0]);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    conv().connection_id = 'conn-acct-1';
    for (const m of h.db.messages) m.created_at = at(T0 - 5 * MIN);
    Object.assign(h.db.automations[0], {
      trigger_type: 'journey_event',
      trigger_config: { event_names: CART_EVENTS },
    });
    h.db.journeys = [
      {
        id: 'jr-1',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        connection_id: 'conn-acct-1',
        state: 'open',
        stage: 'cart',
        link_sent_at: at(T0 - 30 * MIN),
        abandoned_cart_sent_at: null,
      },
    ];
    h.db.automation_steps = cartChain();
  });
  afterEach(() => vi.useRealTimers());

  it('sends 10 minutes after the AddToCart, not before', async () => {
    await event('AddToCart', 0);
    expect(pending()).toHaveLength(1);
    expect(Date.parse(pending()[0].run_at as string) - T0).toBe(10 * MIN);
    await tick(9);
    expect(sent()).toEqual([]);
    await tick(10);
    expect(sent()).toEqual(['Cart?']);
    expect(journey().abandoned_cart_sent_at).toBe(at(T0 + 10 * MIN));
  });

  it('InitiateCheckout arms the same message', async () => {
    await event('InitiateCheckout', 0);
    await tick(10);
    expect(sent()).toEqual(['Cart?']);
  });

  it('ignores other events (ViewContent does not arm the wait)', async () => {
    await event('ViewContent', 0);
    expect(pending()).toHaveLength(0);
  });

  it('a new AddToCart restarts the count: only one message, 10 min after the last', async () => {
    await event('AddToCart', 0);
    const first = pending()[0];
    await event('AddToCart', 6);
    expect(first.status).toBe('cancelled');
    expect(pending()).toHaveLength(1);
    await tick(10);
    expect(sent()).toEqual([]);
    await tick(15);
    expect(sent()).toEqual([]);
    await tick(16);
    expect(sent()).toEqual(['Cart?']);
  });

  it('a burst of cart and checkout events leaves one wait and sends once', async () => {
    const names = ['AddToCart', 'AddToCart', 'InitiateCheckout', 'AddToCart', 'AddToCart'];
    for (const [i, n] of names.entries()) await event(n, i * 2);
    expect(h.db.automation_pending_executions).toHaveLength(names.length);
    expect(pending()).toHaveLength(1);
    // last event at minute 8 -> due at minute 18
    await tick(17);
    expect(sent()).toEqual([]);
    await tick(18);
    expect(sent()).toEqual(['Cart?']);
    await tick(60);
    expect(sent()).toEqual(['Cart?']);
  });

  it('a Purchase (Journey won) before the due time suppresses it', async () => {
    await event('AddToCart', 0);
    Object.assign(journey(), { state: 'won', stage: 'won' });
    await tick(10);
    expect(sent()).toEqual([]);
    expect(journey().abandoned_cart_sent_at).toBeNull();
  });

  it('a customer reply after the event suppresses it', async () => {
    await event('AddToCart', 0);
    customerSays(T0 + 4 * MIN);
    await tick(10);
    expect(sent()).toEqual([]);
  });

  it('an agent assigned during the wait suppresses it (checked at fire time)', async () => {
    await event('AddToCart', 0);
    conv().assigned_agent_id = 'agent-1';
    await tick(10);
    expect(sent()).toEqual([]);
  });

  it('an AI handoff during the wait suppresses it (checked at fire time)', async () => {
    await event('AddToCart', 0);
    conv().ai_autoreply_disabled = true;
    await tick(10);
    expect(sent()).toEqual([]);
  });

  it('is sent once per Journey: a later AddToCart re-arms but the mark blocks the send', async () => {
    await event('AddToCart', 0);
    await tick(10);
    expect(sent()).toEqual(['Cart?']);
    await event('AddToCart', 30);
    await tick(40);
    expect(sent()).toEqual(['Cart?']);
  });

  it('a new Journey (after a purchase) may get its own message', async () => {
    await event('AddToCart', 0);
    await tick(10);
    Object.assign(journey(), { state: 'won', stage: 'won' });
    h.db.journeys.push({
      id: 'jr-2',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      connection_id: 'conn-acct-1',
      state: 'open',
      stage: 'cart',
      abandoned_cart_sent_at: null,
    });
    vi.setSystemTime(T0 + 60 * MIN);
    await runAutomationsForTrigger({
      accountId: 'acct-1',
      triggerType: 'journey_event',
      contactId: 'ct-1',
      context: {
        conversation_id: 'cv-1',
        journey_id: 'jr-2',
        journey_event_name: 'AddToCart',
      },
    });
    await tick(70);
    expect(sent()).toEqual(['Cart?', 'Cart?']);
    expect(h.db.journeys[1].abandoned_cart_sent_at).toBeTruthy();
  });

  it('the step itself claims the mark: two runs racing to send produce one message', async () => {
    h.db.automation_steps = [
      step('au-1', 'send', {
        step_type: 'send_message',
        step_config: { text: 'Once', mark_journey_flag: 'abandoned_cart_sent' },
      }),
    ];
    await event('AddToCart', 0);
    await event('AddToCart', 1);
    expect(sent()).toEqual(['Once']);
    expect(log().steps_executed).toEqual([
      expect.objectContaining({ status: 'success', detail: expect.stringContaining('sent via') }),
    ]);
    expect(h.db.automation_logs[1].steps_executed).toEqual([
      expect.objectContaining({ status: 'success', detail: expect.stringContaining('skipped') }),
    ]);
  });

  it('a failed send gives the mark back so a later event can retry', async () => {
    for (const m of h.db.messages) m.created_at = at(T0 - 30 * 60 * MIN); // window closed
    await event('AddToCart', 0);
    await tick(10);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(journey().abandoned_cart_sent_at).toBeNull();
    expect(h.db.automation_logs[0].status).toBe('failed');
  });

  it('outside the 24 h window sends the fallback template and marks the Journey', async () => {
    h.db.automation_steps = cartChain('Cart?', {
      fallback_template: { name: 'cart_tpl', language: 'en_US' },
    });
    h.db.message_templates = [
      {
        id: 'tpl-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        name: 'cart_tpl',
        category: 'Utility',
        language: 'en_US',
        body_text: 'You left something',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    for (const m of h.db.messages) m.created_at = at(T0 - 30 * 60 * MIN);
    await event('AddToCart', 0);
    await tick(10);
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(journey().abandoned_cart_sent_at).toBeTruthy();
  });

  describe('with the generic Resumption chain active too', () => {
    beforeEach(() => {
      h.db.automations.push({
        id: 'au-2',
        account_id: 'acct-1',
        user_id: 'user-1',
        trigger_type: 'menu_link_sent',
        trigger_config: {},
        is_active: true,
      });
      h.db.automation_steps = [...cartChain(), ...genericChain()];
      Object.assign(journey(), { stage: 'link_sent', link_sent_at: at(T0) });
    });

    const linkSent = () =>
      runAutomationsForTrigger({
        accountId: 'acct-1',
        triggerType: 'menu_link_sent',
        contactId: 'ct-1',
        context: {
          conversation_id: 'cv-1',
          journey_id: 'jr-1',
          menu_link_sent_at: at(T0),
        },
      });

    it('a customer who reached the cart gets only the cart message', async () => {
      await linkSent();
      vi.setSystemTime(T0 + 2 * MIN);
      journey().stage = 'cart';
      await event('AddToCart', 2);
      await tick(12);
      expect(sent()).toEqual(['Cart?']);
    });

    it('a customer who only browsed gets only the generic Resumption', async () => {
      await linkSent();
      journey().stage = 'browsing';
      await tick(10);
      expect(sent()).toEqual(['Generic']);
    });
  });
});

describe('Order notifications (order_status_changed and the Purchase thank-you)', () => {
  const order = (status: string, extra: Row = {}) => ({
    external_id: 'PED-1042',
    status,
    previous_status: 'placed',
    value: 89.8,
    currency: 'BRL',
    items: [{ id: 'sku-1', name: 'Pizza', quantity: 2, unit_price: 44.9 }],
    ...extra,
  });

  /** One automation per status, as the preset (#14) will create them. */
  function statusAutomation(id: string, statuses: string[], text: string, account = 'acct-1', cfg: Row = {}) {
    h.db.automations.push({
      id,
      account_id: account,
      user_id: 'user-1',
      trigger_type: 'order_status_changed',
      trigger_config: { statuses },
      is_active: true,
    });
    h.db.automation_steps.push({
      id: `${id}-send`,
      automation_id: id,
      parent_step_id: null,
      branch: null,
      position: 0,
      step_type: 'send_message',
      step_config: { text, ...cfg },
    });
  }

  const changed = (status: string, account = 'acct-1', extra: Row = {}) =>
    runAutomationsForTrigger({
      accountId: account,
      triggerType: 'order_status_changed',
      contactId: 'ct-1',
      context: { conversation_id: 'cv-1', connection_id: 'conn-acct-1', order: order(status), ...extra },
    });
  const sent = () => messages().map((m) => m.content_text);

  beforeEach(() => {
    h.db.automations = [];
    h.db.automation_steps = [];
  });

  it.each([
    ['received', 'Recebemos'],
    ['preparing', 'Preparando'],
    ['finished', 'Pronto'],
    ['out_for_delivery', 'Saiu'],
    ['ready_for_pickup', 'Retire'],
    ['delivered', 'Entregue'],
    ['cancelled', 'Cancelado'],
  ])('%s fires only the message configured for it, on the conversation channel', async (status, text) => {
    for (const [s, t] of [
      ['received', 'Recebemos'],
      ['preparing', 'Preparando'],
      ['finished', 'Pronto'],
      ['out_for_delivery', 'Saiu'],
      ['ready_for_pickup', 'Retire'],
      ['delivered', 'Entregue'],
      ['cancelled', 'Cancelado'],
    ]) {
      statusAutomation(`au-${s}`, [s], t);
    }
    await changed(status);
    expect(sent()).toEqual([text]);
    expect(messages()[0]).toMatchObject({ conversation_id: 'cv-1', sender_type: 'bot' });
    expect(h.sendTextMessage).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: 'pn-1', text }));
  });

  it('a status with no automation configured sends nothing', async () => {
    statusAutomation('au-a', ['preparing'], 'Preparando');
    await changed('delivered');
    expect(sent()).toEqual([]);
    expect(h.db.automation_logs).toHaveLength(0);
  });

  it('an inactive automation sends nothing', async () => {
    statusAutomation('au-a', ['preparing'], 'Preparando');
    h.db.automations[0].is_active = false;
    await changed('preparing');
    expect(sent()).toEqual([]);
  });

  it('one automation can cover several statuses', async () => {
    statusAutomation('au-a', ['received', 'preparing'], 'Andamento');
    await changed('preparing');
    await changed('delivered');
    expect(sent()).toEqual(['Andamento']);
  });

  it('interpolates {{order_id}}, {{order_status}} and {{order_value}} (locale-formatted, account currency of the order)', async () => {
    statusAutomation('au-a', ['preparing'], 'Pedido {{order_id}} está {{ order_status }}: {{order_value}}');
    await changed('preparing');
    expect(sent()).toEqual([expect.stringMatching(/^Pedido PED-1042 está preparing: R\$\s?89\.80$/)]);
  });

  it('formats the value with the app locale', async () => {
    const prev = process.env.NEXT_PUBLIC_APP_LOCALE;
    process.env.NEXT_PUBLIC_APP_LOCALE = 'pt';
    try {
      statusAutomation('au-a', ['preparing'], 'Total {{order_value}}');
      await changed('preparing');
      expect(sent()[0]).toMatch(/R\$\s89,80/);
    } finally {
      if (prev === undefined) delete process.env.NEXT_PUBLIC_APP_LOCALE;
      else process.env.NEXT_PUBLIC_APP_LOCALE = prev;
    }
  });

  it('order variables are empty outside an order run', async () => {
    h.db.automations.push({
      id: 'au-n',
      account_id: 'acct-1',
      user_id: 'user-1',
      trigger_type: 'new_contact_created',
      trigger_config: {},
      is_active: true,
    });
    h.db.automation_steps.push({
      id: 'n1',
      automation_id: 'au-n',
      parent_step_id: null,
      branch: null,
      position: 0,
      step_type: 'send_message',
      step_config: { text: 'Pedido [{{order_id}}]' },
    });
    await fire();
    expect(sent()).toEqual(['Pedido []']);
  });

  it('only runs the automations of the order account', async () => {
    statusAutomation('au-mine', ['preparing'], 'Minha');
    statusAutomation('au-theirs', ['preparing'], 'Alheia', 'acct-2');
    await changed('preparing');
    expect(sent()).toEqual(['Minha']);
    // A forged account: the contact is not theirs, so nothing runs at all.
    h.db.messages = h.db.messages.filter((m) => m.sender_type === 'customer');
    await changed('preparing', 'acct-2');
    expect(sent()).toEqual([]);
  });

  it('outside the 24 h window sends the status template', async () => {
    statusAutomation('au-a', ['out_for_delivery'], 'Saiu {{order_id}}', 'acct-1', {
      fallback_template: { name: 'order_out', language: 'pt_BR', variables: { '1': 'PED' } },
    });
    h.db.message_templates = [
      {
        id: 'tpl-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        name: 'order_out',
        category: 'Utility',
        language: 'pt_BR',
        body_text: 'Seu pedido saiu {{1}}',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    for (const m of h.db.messages) m.created_at = '2020-01-01T00:00:00Z';
    await changed('out_for_delivery');
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('outside the 24 h window without a template fails visibly', async () => {
    statusAutomation('au-a', ['out_for_delivery'], 'Saiu');
    for (const m of h.db.messages) m.created_at = '2020-01-01T00:00:00Z';
    await changed('out_for_delivery');
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(log().status).toBe('failed');
    expect(String(log().error_message)).toMatch(/window/i);
  });

  describe('Purchase thank-you (journey_event)', () => {
    it('fires on Purchase only and can use the order variables', async () => {
      h.db.automations.push({
        id: 'au-thx',
        account_id: 'acct-1',
        user_id: 'user-1',
        trigger_type: 'journey_event',
        trigger_config: { event_names: ['Purchase'] },
        is_active: true,
      });
      h.db.automation_steps.push({
        id: 'thx1',
        automation_id: 'au-thx',
        parent_step_id: null,
        branch: null,
        position: 0,
        step_type: 'send_message',
        step_config: { text: 'Obrigado! Pedido {{order_id}} ({{order_status}})' },
      });
      const ev = (name: string, extra: Row = {}) =>
        runAutomationsForTrigger({
          accountId: 'acct-1',
          triggerType: 'journey_event',
          contactId: 'ct-1',
          context: { conversation_id: 'cv-1', journey_event_name: name, ...extra },
        });
      await ev('AddToCart');
      expect(sent()).toEqual([]);
      await ev('Purchase', { order: order('placed') });
      expect(sent()).toEqual(['Obrigado! Pedido PED-1042 (placed)']);
    });
  });
});

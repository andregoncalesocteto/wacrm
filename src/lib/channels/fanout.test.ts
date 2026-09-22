import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
// Everything, including the US-074 additions (kept out of `calls`, which the
// US-020 tests compare exactly).
const order: string[] = [];
const flows = vi.fn();
const automations = vi.fn();
const ai = vi.fn();
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: (a: unknown) => {
    calls.push('flows');
    order.push('flows');
    return flows(a);
  },
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: (a: { triggerType: string }) => {
    calls.push(`auto:${a.triggerType}`);
    order.push(`auto:${a.triggerType}`);
    return automations(a);
  },
}));
const webhook = vi.fn();
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: (...a: unknown[]) => {
    order.push(`webhook:${a[2]}`);
    return webhook(...a);
  },
}));
const identityRows = vi.fn();
const flagQuery = vi.fn();
const flagUpdate = vi.fn();
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      order.push(`db:${table}`);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'order']) q[m] = () => q;
      q.limit = () => flagQuery();
      q.maybeSingle = () => Promise.resolve({ data: { phone: '' } });
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: identityRows() }).then(res);
      q.update = (patch: unknown) => ({
        eq: (_c: string, id: string) => flagUpdate(patch, id),
      });
      return q;
    },
  }),
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: (a: unknown) => {
    calls.push('ai');
    order.push('ai');
    return ai(a);
  },
}));

import { conversationCreatedHook, fanOutInbound, fanoutHook } from './fanout';
import { ingestInbound, type IngestedMessage } from './ingest';

function stored(over: Partial<IngestedMessage> = {}): IngestedMessage {
  return {
    connection: {
      id: 'conn',
      account_id: 'acc',
      store_id: 'st',
      channel_type: 'telegram',
    },
    contact: { id: 'ct' },
    conversation: { id: 'cv' },
    contactCreated: false,
    conversationCreated: false,
    event: { kind: 'message', externalId: 'wamid.1' },
    messageId: 'm1',
    contentType: 'text',
    contentText: 'hello',
    mediaUrl: null,
    interactiveReplyId: null,
    isFirstInbound: false,
    ...over,
  } as unknown as IngestedMessage;
}
const opts = { configOwnerUserId: 'owner' };

beforeEach(() => {
  calls.length = 0;
  flows.mockResolvedValue({ consumed: false });
  automations.mockResolvedValue(undefined);
  ai.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('fanOutInbound', () => {
  it('subsequent plain text: flows, message triggers, then AI, with the route arguments', async () => {
    await fanOutInbound(stored(), opts);
    expect(calls).toEqual([
      'flows',
      'auto:new_message_received',
      'auto:keyword_match',
      'ai',
    ]);
    expect(flows).toHaveBeenCalledWith({
      accountId: 'acc',
      userId: 'owner',
      contactId: 'ct',
      conversationId: 'cv',
      message: { kind: 'text', text: 'hello', meta_message_id: 'wamid.1' },
      isFirstInboundMessage: false,
    });
    expect(automations).toHaveBeenCalledWith({
      accountId: 'acc',
      triggerType: 'keyword_match',
      contactId: 'ct',
      context: {
        message_text: 'hello',
        conversation_id: 'cv',
        interactive_reply_id: undefined,
      },
    });
    expect(ai).toHaveBeenCalledWith({
      accountId: 'acc',
      conversationId: 'cv',
      contactId: 'ct',
      configOwnerUserId: 'owner',
      inboundMessageId: 'wamid.1',
    });
  });

  it('first inbound from a new contact adds the relationship triggers first', async () => {
    await fanOutInbound(
      stored({ isFirstInbound: true, contactCreated: true }),
      opts
    );
    expect(calls).toEqual([
      'flows',
      'auto:first_inbound_message',
      'auto:new_contact_created',
      'auto:new_message_received',
      'auto:keyword_match',
      'ai',
    ]);
    expect(flows.mock.calls[0][0].isFirstInboundMessage).toBe(true);
  });

  it('first inbound of an existing contact fires only first_inbound_message', async () => {
    await fanOutInbound(stored({ isFirstInbound: true }), opts);
    expect(calls.filter((c) => c.startsWith('auto:'))).toEqual([
      'auto:first_inbound_message',
      'auto:new_message_received',
      'auto:keyword_match',
    ]);
  });

  it('a consumed message keeps only the relationship triggers and skips the AI', async () => {
    flows.mockResolvedValue({ consumed: true });
    await fanOutInbound(
      stored({ isFirstInbound: true, contactCreated: true }),
      opts
    );
    expect(calls).toEqual([
      'flows',
      'auto:first_inbound_message',
      'auto:new_contact_created',
    ]);
  });

  it('an interactive reply goes to flows as such, adds interactive_reply and skips the AI', async () => {
    await fanOutInbound(
      stored({
        contentType: 'interactive',
        contentText: 'Sim',
        interactiveReplyId: 'btn_yes',
      }),
      opts
    );
    expect(flows.mock.calls[0][0].message).toEqual({
      kind: 'interactive_reply',
      reply_id: 'btn_yes',
      reply_title: 'Sim',
      meta_message_id: 'wamid.1',
    });
    expect(calls).toEqual([
      'flows',
      'auto:new_message_received',
      'auto:keyword_match',
      'auto:interactive_reply',
    ]);
    expect(automations.mock.calls[2][0].context.interactive_reply_id).toBe(
      'btn_yes'
    );
  });

  it('media without text or blank text does not reach the AI', async () => {
    await fanOutInbound(
      stored({ contentText: null, contentType: 'image' }),
      opts
    );
    expect(calls).not.toContain('ai');
    expect(flows.mock.calls[0][0].message).toMatchObject({ text: '' });
    await fanOutInbound(stored({ contentText: '   ' }), opts);
    expect(calls.filter((c) => c === 'ai')).toHaveLength(0);
  });

  it('a flow engine failure is isolated: automations and AI still run', async () => {
    flows.mockRejectedValue(new Error('boom'));
    await fanOutInbound(stored(), opts);
    expect(calls).toEqual([
      'flows',
      'auto:new_message_received',
      'auto:keyword_match',
      'ai',
    ]);
  });

  it('one automation trigger failing does not skip the others or the AI', async () => {
    automations.mockRejectedValueOnce(new Error('boom'));
    await fanOutInbound(stored(), opts);
    expect(calls).toEqual([
      'flows',
      'auto:new_message_received',
      'auto:keyword_match',
      'ai',
    ]);
  });

  it('an AI failure does not throw', async () => {
    ai.mockRejectedValue(new Error('boom'));
    await expect(fanOutInbound(stored(), opts)).resolves.toBeUndefined();
  });
});

describe('fanoutHook', () => {
  it('is an onMessageStored hook bound to the options', async () => {
    await fanoutHook(opts)(stored());
    expect(flows.mock.calls[0][0].userId).toBe('owner');
  });

  it('typechecks against IngestHooks and stays isolated from ingest', () => {
    // Compile-time check: the hook fits `IngestHooks['onMessageStored']`.
    const h: NonNullable<
      Parameters<typeof ingestInbound>[3]['hooks']
    >['onMessageStored'] = fanoutHook(opts);
    expect(typeof h).toBe('function');
  });
});

describe('US-074 fan-out additions', () => {
  beforeEach(() => {
    calls.length = 0;
    order.length = 0;
    flows.mockReset().mockResolvedValue({ consumed: false });
    automations.mockReset().mockResolvedValue(undefined);
    ai.mockReset().mockResolvedValue(undefined);
    webhook.mockReset().mockResolvedValue(undefined);
    identityRows.mockReset().mockReturnValue([
      { kind: 'telegram:user', external_id: '42', handle: 'ada' },
    ]);
    flagQuery.mockReset().mockResolvedValue({ data: [], error: null });
    flagUpdate.mockReset().mockResolvedValue({ error: null });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('flags the broadcast reply BEFORE flows and sends message.received AFTER the AI reply', async () => {
    flagQuery.mockResolvedValue({
      data: [{ id: 'r1', status: 'sent' }],
      error: null,
    });
    await fanOutInbound(stored(), { configOwnerUserId: 'owner' });
    expect(flagUpdate).toHaveBeenCalledTimes(1);
    expect(flagUpdate.mock.calls[0][0]).toMatchObject({ status: 'replied' });
    expect(flagUpdate.mock.calls[0][1]).toBe('r1');
    expect(order[0]).toBe('db:broadcast_recipients');
    expect(order.indexOf('flows')).toBeGreaterThan(
      order.lastIndexOf('db:broadcast_recipients')
    );
    expect(order.at(-1)).toBe('webhook:message.received');
    expect(order.indexOf('ai')).toBeLessThan(
      order.indexOf('webhook:message.received')
    );
  });

  it('does not update anything when there is no recent broadcast recipient', async () => {
    await fanOutInbound(stored(), { configOwnerUserId: 'owner' });
    expect(flagUpdate).not.toHaveBeenCalled();
  });

  it('dispatches message.received with today\'s fields plus connection, store, channel and contact', async () => {
    await fanOutInbound(stored({ contentType: 'image', contentText: 'cap' }), {
      configOwnerUserId: 'owner',
    });
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(webhook.mock.calls[0][1]).toBe('acc');
    expect(webhook.mock.calls[0][2]).toBe('message.received');
    expect(webhook.mock.calls[0][3]).toEqual({
      conversation_id: 'cv',
      contact_id: 'ct',
      whatsapp_message_id: 'wamid.1',
      external_message_id: 'wamid.1',
      content_type: 'image',
      text: 'cap',
      connection_id: 'conn',
      store_id: 'st',
      channel: 'telegram',
      contact: {
        id: 'ct',
        phone: null,
        identities: [{ kind: 'telegram:user', external_id: '42', handle: 'ada' }],
      },
    });
  });

  it('behaves the same for the first and for a later inbound', async () => {
    await fanOutInbound(stored({ isFirstInbound: true }), {
      configOwnerUserId: 'o',
    });
    await fanOutInbound(stored({ isFirstInbound: false }), {
      configOwnerUserId: 'o',
    });
    expect(webhook).toHaveBeenCalledTimes(2);
    expect(flagQuery).toHaveBeenCalledTimes(2);
  });

  it('does not emit conversation.created from the fan-out, even for a new conversation', async () => {
    await fanOutInbound(
      stored({ conversationCreated: true, contactCreated: true }),
      {
        configOwnerUserId: 'o',
      }
    );
    expect(order).not.toContain('webhook:conversation.created');
  });

  it('conversationCreatedHook emits conversation.created once with the route payload', async () => {
    await conversationCreatedHook({
      connection: {
        id: 'conn',
        account_id: 'acc',
        store_id: 'st',
        channel_type: 'telegram',
      },
      contact: { id: 'ct' },
      conversation: { id: 'cv' },
      contactCreated: true,
      conversationCreated: true,
    } as never);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(webhook.mock.calls[0].slice(1)).toEqual([
      'acc',
      'conversation.created',
      {
        conversation_id: 'cv',
        contact_id: 'ct',
        connection_id: 'conn',
        store_id: 'st',
        channel: 'telegram',
        contact: {
          id: 'ct',
          phone: null,
          identities: [
            { kind: 'telegram:user', external_id: '42', handle: 'ada' },
          ],
        },
      },
    ]);
  });

  it('a failing broadcast flag does not stop the engines or the webhook', async () => {
    flagQuery.mockRejectedValue(new Error('db down'));
    await fanOutInbound(stored(), { configOwnerUserId: 'o' });
    expect(order).toContain('flows');
    expect(order).toContain('ai');
    expect(order.at(-1)).toBe('webhook:message.received');
  });

  it('a failing webhook is logged and does not throw', async () => {
    webhook.mockRejectedValue(new Error('boom'));
    await expect(
      fanOutInbound(stored(), { configOwnerUserId: 'o' })
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[channel:fanout]'),
      expect.anything()
    );
  });

  it('failing engines do not prevent the webhook', async () => {
    flows.mockRejectedValue(new Error('x'));
    automations.mockRejectedValue(new Error('y'));
    ai.mockRejectedValue(new Error('z'));
    await fanOutInbound(stored(), { configOwnerUserId: 'o' });
    expect(order.at(-1)).toBe('webhook:message.received');
  });
});

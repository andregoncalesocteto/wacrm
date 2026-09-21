import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const flows = vi.fn();
const automations = vi.fn();
const ai = vi.fn();
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: (a: unknown) => {
    calls.push('flows');
    return flows(a);
  },
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: (a: { triggerType: string }) => {
    calls.push(`auto:${a.triggerType}`);
    return automations(a);
  },
}));
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: (a: unknown) => {
    calls.push('ai');
    return ai(a);
  },
}));

import { fanOutInbound, fanoutHook } from './fanout';
import { ingestInbound, type IngestedMessage } from './ingest';

function stored(over: Partial<IngestedMessage> = {}): IngestedMessage {
  return {
    connection: { id: 'conn', account_id: 'acc' },
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

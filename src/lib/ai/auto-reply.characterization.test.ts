/**
 * Characterization tests for the AI auto-reply SEND path (US-004,
 * channel-abstraction). Complements `auto-reply.test.ts` (which stubs
 * `engineSendText`) by running the real flows sender end to end: the
 * generated text goes to Meta with the account credentials, is persisted as
 * a bot message flagged `ai_generated`, updates the conversation, and the
 * per-conversation cap (atomic `claim_ai_reply_slot`) stops further replies.
 * Only the LLM, knowledge/context loaders and the Meta HTTP senders are
 * stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { dispatchInboundToAiReply } from './auto-reply';
import type { AiConfig } from './types';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  rpcCalls: [] as { name: string; args: unknown }[],
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  sendTextMessage: vi.fn(),
  sendTypingIndicator: vi.fn(),
}));

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }));
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('./usage', () => ({ logAiUsage: vi.fn(async () => undefined) }));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: h.sendTextMessage,
  sendTypingIndicator: h.sendTypingIndicator,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `dec:${v}`,
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}));

// Shared in-memory client; `claim_ai_reply_slot` mirrors migration 029
// (one UPDATE that increments only while ai_reply_count < max_replies).
async function fake() {
  const { fakeAdmin } =
    await import('@/lib/automations/engine.characterization.fake');
  const base = fakeAdmin(h);
  return {
    supabaseAdmin: () => ({
      ...base.supabaseAdmin(),
      rpc: (name: string, args: Record<string, unknown>) => {
        h.rpcCalls.push({ name, args });
        const c = h.db.conversations.find((r) => r.id === args.conversation_id);
        if (
          name === 'claim_ai_reply_slot' &&
          c &&
          (c.ai_reply_count as number) < (args.max_replies as number)
        ) {
          c.ai_reply_count = (c.ai_reply_count as number) + 1;
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: false, error: null });
      },
    }),
  };
}
vi.mock('./admin-client', fake);
vi.mock('@/lib/flows/admin-client', fake);

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.in',
};

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 2,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  };
}

const messages = () => h.db.messages;
const conv = () => h.db.conversations[0];

beforeEach(() => {
  __resetRateLimitForTests();
  h.seq = 0;
  h.rpcCalls = [];
  h.db = {
    contacts: [{ id: 'ct-1', account_id: 'acct-1', phone: '+15551234567' }],
    conversations: [
      {
        id: 'cv-1',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        assigned_agent_id: null,
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
        last_message_text: 'old',
        last_message_at: '2020-01-01T00:00:00Z',
      },
    ],
    whatsapp_config: [
      { account_id: 'acct-1', phone_number_id: 'pn-1', access_token: 'cipher' },
    ],
    automations: [],
    messages: [],
  };
  h.loadAiConfig.mockResolvedValue(aiConfig());
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'hi' },
  ]);
  h.retrieveKnowledge.mockResolvedValue([]);
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false });
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.ai' });
  h.sendTypingIndicator.mockResolvedValue(undefined);
});

describe('AI auto-reply send', () => {
  it('sends the generated text with the account credentials and persists an ai_generated bot message', async () => {
    await dispatchInboundToAiReply(ARGS);

    expect(h.sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'dec:cipher',
      to: '15551234567',
      text: 'Hello!',
    });
    expect(messages()).toHaveLength(1);
    expect(messages()[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'bot',
      content_type: 'text',
      content_text: 'Hello!',
      message_id: 'wamid.ai',
      status: 'sent',
      ai_generated: true,
    });
    expect(conv().last_message_text).toBe('Hello!');
    expect(conv().last_message_at).not.toBe('2020-01-01T00:00:00Z');
    expect(conv().ai_reply_count).toBe(1);
  });

  it('shows the typing indicator for the inbound wamid before answering', async () => {
    await dispatchInboundToAiReply(ARGS);
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'dec:cipher',
      messageId: 'wamid.in',
    });
  });

  it('stops after the per-conversation cap: the third inbound gets no reply', async () => {
    await dispatchInboundToAiReply(ARGS);
    await dispatchInboundToAiReply(ARGS);
    await dispatchInboundToAiReply(ARGS);

    expect(h.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(messages()).toHaveLength(2);
    expect(conv().ai_reply_count).toBe(2);
    // The early read-check short-circuits before the LLM is even called.
    expect(h.generateReply).toHaveBeenCalledTimes(2);
  });

  it('losing the atomic slot claim (cap reached after the early check) sends nothing', async () => {
    h.generateReply.mockImplementation(async () => {
      // A concurrent inbound takes the last slot while the LLM is running.
      conv().ai_reply_count = 2;
      return { text: 'Hello!', handoff: false };
    });

    await dispatchInboundToAiReply(ARGS);

    expect(h.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'cv-1', max_replies: 2 },
      },
    ]);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
    expect(conv().ai_reply_count).toBe(2);
  });

  it('a failed Meta send is swallowed (never throws), persists nothing, but the slot stays consumed', async () => {
    h.sendTextMessage.mockRejectedValue(new Error('(#100) boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(dispatchInboundToAiReply(ARGS)).resolves.toBeUndefined();

    expect(messages()).toHaveLength(0);
    expect(conv().last_message_text).toBe('old');
    expect(conv().ai_reply_count).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a handoff answer sends nothing and disables the auto-reply on the thread', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true });

    await dispatchInboundToAiReply(ARGS);

    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
    expect(conv().ai_autoreply_disabled).toBe(true);
    expect(typeof conv().ai_handoff_summary).toBe('string');
    // No slot is consumed by a handoff.
    expect(conv().ai_reply_count).toBe(0);
  });

  it('a typing-indicator failure does not prevent the reply', async () => {
    h.sendTypingIndicator.mockRejectedValue(new Error('nope'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await dispatchInboundToAiReply(ARGS);

    expect(messages()).toHaveLength(1);
    warn.mockRestore();
  });

  it('a human-assigned conversation gets no reply', async () => {
    conv().assigned_agent_id = 'agent-1';
    await dispatchInboundToAiReply(ARGS);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
    expect(h.generateReply).not.toHaveBeenCalled();
  });

  it('the per-account throttle (30 per minute) skips the reply without touching the conversation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.loadAiConfig.mockResolvedValue(
      aiConfig({ autoReplyMaxPerConversation: 1000 })
    );

    for (let i = 0; i < 31; i += 1) await dispatchInboundToAiReply(ARGS);

    expect(h.sendTextMessage).toHaveBeenCalledTimes(30);
    expect(conv().ai_reply_count).toBe(30);
    warn.mockRestore();
  });
});

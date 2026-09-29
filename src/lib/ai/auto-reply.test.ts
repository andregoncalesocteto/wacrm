import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  sendOutbound: vi.fn(),
  showTyping: vi.fn(),
  resolveMenuLink: vi.fn(),
  recordMenuLinkSent: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({
  buildConversationContext: h.buildConversationContext,
}))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/channels/send', () => ({
  sendOutbound: h.sendOutbound,
  showTyping: h.showTyping,
}))
vi.mock('@/lib/journeys', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveMenuLink: h.resolveMenuLink,
  recordMenuLinkSent: h.recordMenuLinkSent,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'
import { MenuLinkError } from '@/lib/journeys'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([
    { role: 'user', content: 'hi' },
  ])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.sendOutbound.mockResolvedValue({ externalMessageId: 'm1' })
  h.showTyping.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.sendOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        message: { type: 'text', text: 'Hello!' },
        actor: { type: 'ai' },
      }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.sendOutbound).not.toHaveBeenCalled()
    expect(h.showTyping).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendOutbound).not.toHaveBeenCalled()
    expect(h.showTyping).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendOutbound).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.sendOutbound).not.toHaveBeenCalled()
    expect(h.showTyping).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.showTyping).toHaveBeenCalledTimes(1)
    expect(h.showTyping).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        inboundExternalId: 'wamid.inbound-1',
      }),
    )
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.showTyping.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.sendOutbound).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.showTyping.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.sendOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        message: { type: 'text', text: 'Hello!' },
        actor: { type: 'ai' },
      }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.showTyping.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendOutbound).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.showTyping).not.toHaveBeenCalled()
    expect(h.sendOutbound).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.showTyping).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendOutbound).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

describe('dispatchInboundToAiReply — {{menu_link}}', () => {
  const LINK = 'https://menu.example/loja-a?idtrack=tok123'

  beforeEach(() => {
    h.generateReply.mockResolvedValue({
      text: 'Our menu: {{menu_link}} - enjoy!',
      handoff: false,
    })
    h.resolveMenuLink.mockResolvedValue({
      url: LINK,
      connectionId: 'conn-1',
      storeId: 'store-1',
    })
    h.recordMenuLinkSent.mockResolvedValue({ id: 'j-1' })
  })

  it('replaces the variable with the tracked store link and opens the Journey after the send', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.resolveMenuLink).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
    })
    expect(h.sendOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        message: { type: 'text', text: `Our menu: ${LINK} - enjoy!` },
        actor: { type: 'ai' },
      }),
    )
    expect(h.recordMenuLinkSent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        connectionId: 'conn-1',
      }),
    )
    expect(h.sendOutbound.mock.invocationCallOrder[0]).toBeLessThan(
      h.recordMenuLinkSent.mock.invocationCallOrder[0],
    )
  })

  it('does not resolve a link nor open a Journey for replies without the variable', async () => {
    h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.resolveMenuLink).not.toHaveBeenCalled()
    expect(h.recordMenuLinkSent).not.toHaveBeenCalled()
  })

  it('does not open a Journey when the send fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.sendOutbound.mockRejectedValue(new Error('window_closed'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.recordMenuLinkSent).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it('sends nothing and hands off with the reason when the store has no menu address', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.resolveMenuLink.mockRejectedValue(
      new MenuLinkError('menu_link: store "Loja A" has no menu URL configured'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendOutbound).not.toHaveBeenCalled()
    expect(h.recordMenuLinkSent).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0) // no reply slot consumed
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'has no menu URL configured',
    )
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('menu link unavailable'),
    )
    err.mockRestore()
  })

  it('still respects the cap and the human assignment', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.resolveMenuLink).not.toHaveBeenCalled()
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.resolveMenuLink).not.toHaveBeenCalled()
    expect(h.sendOutbound).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { deliverBroadcast, type BroadcastPlan } from './broadcast-core';

// Real telegram provider (registered via registerBuiltinProviders inside
// deliverBroadcast) — only the Bot API call at the bottom is stubbed.
const h = vi.hoisted(() => ({ callBotApi: vi.fn() }));
vi.mock('@/lib/channels/providers/telegram/api', () => ({
  callBotApi: h.callBotApi,
}));
vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionCredentials: async () => ({ bot_token: 'tg-tok' }),
}));

function fakeDb() {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  // Chainable and awaitable: covers updates and finalizeBroadcastStatus's
  // count queries (always reports 0 pending / 0 failed, i.e. "all sent").
  function chainFor(table: string) {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => void) => resolve({ count: 0 }),
    };
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.update = (patch: Record<string, unknown>) => {
      updates.push({ table, patch });
      return chain;
    };
    return chain;
  }
  return {
    db: { from: (table: string) => chainFor(table) } as unknown as SupabaseClient,
    updates,
  };
}

function telegramPlan(overrides: Partial<BroadcastPlan> = {}): BroadcastPlan {
  return {
    broadcastId: 'bc-1',
    templateName: '',
    templateLanguage: '',
    connection: {
      id: 'conn-1',
      channel_type: 'telegram',
      external_id: '123456',
      disabled_at: null,
    },
    phoneNumberId: '',
    accessToken: '',
    templateRow: null,
    messageText: 'Hi {{1}}, welcome!',
    messageMediaUrl: null,
    planned: [{ recipientRowId: 'r1', phone: '555', params: ['Maria'] }],
    rejected: 0,
    ...overrides,
  } as unknown as BroadcastPlan;
}

describe('deliverBroadcast on a channel without the template capability (US-005)', () => {
  it('sends the free-message text instead of rejecting, with variables resolved per recipient', async () => {
    h.callBotApi.mockResolvedValue({ message_id: 77, chat: { id: 555 } });
    const { db, updates } = fakeDb();

    await deliverBroadcast(db, telegramPlan());

    expect(h.callBotApi).toHaveBeenCalledTimes(1);
    expect(h.callBotApi).toHaveBeenCalledWith(
      'tg-tok',
      'sendMessage',
      expect.objectContaining({ text: 'Hi Maria, welcome!' })
    );
    expect(updates).toContainEqual({
      table: 'broadcast_recipients',
      patch: expect.objectContaining({
        status: 'sent',
        external_message_id: '555:77',
      }),
    });
  });

  it('sends media with a rendered caption when message_media_url is set', async () => {
    h.callBotApi.mockResolvedValue({ message_id: 78, chat: { id: 555 } });
    const { db } = fakeDb();

    await deliverBroadcast(
      db,
      telegramPlan({ messageMediaUrl: 'https://cdn.example.com/promo.png' })
    );

    expect(h.callBotApi).toHaveBeenCalledWith(
      'tg-tok',
      'sendPhoto',
      expect.objectContaining({
        photo: 'https://cdn.example.com/promo.png',
        caption: 'Hi Maria, welcome!',
      })
    );
  });

  it('fails one recipient without aborting the rest (free-message path)', async () => {
    h.callBotApi
      .mockRejectedValueOnce(new Error('bot was blocked by the user'))
      .mockResolvedValueOnce({ message_id: 2, chat: { id: 556 } });
    const { db, updates } = fakeDb();

    await deliverBroadcast(
      db,
      telegramPlan({
        planned: [
          { recipientRowId: 'r1', phone: '555', params: ['Maria'] },
          { recipientRowId: 'r2', phone: '556', params: ['João'] },
        ],
      })
    );

    const recipientUpdates = updates.filter(
      (u) => u.table === 'broadcast_recipients'
    );
    expect(recipientUpdates).toContainEqual({
      table: 'broadcast_recipients',
      patch: expect.objectContaining({
        status: 'failed',
        error_message: 'bot was blocked by the user',
      }),
    });
    expect(recipientUpdates).toContainEqual({
      table: 'broadcast_recipients',
      patch: expect.objectContaining({
        status: 'sent',
        external_message_id: '556:2',
      }),
    });
  });
});

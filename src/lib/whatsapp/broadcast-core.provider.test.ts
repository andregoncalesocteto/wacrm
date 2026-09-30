import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { deliverBroadcast, type BroadcastPlan } from './broadcast-core';

// Real telegram provider (registered via registerBuiltinProviders inside
// deliverBroadcast) — only the Bot API call at the bottom is stubbed.
const h = vi.hoisted(() => ({ callBotApi: vi.fn() }));
vi.mock('@/lib/channels/providers/telegram/api', () => ({
  callBotApi: h.callBotApi,
}));
// Consent is covered in broadcast-core.consent.test.ts; here everyone is allowed.
vi.mock('@/lib/consent/consent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  contactsWithConsent: async (
    _db: unknown,
    _account: string,
    ids: string[]
  ) => new Set(ids),
}));

vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionCredentials: async () => ({ bot_token: 'tg-tok' }),
}));

// contact_id -> contact_identities rows, read by deliverBroadcast's
// non-template target resolution (US-009: provider.resolveTarget(identities),
// not WA_PHONE_KIND/recipient.phone).
const DEFAULT_IDENTITIES: Record<string, { kind: string; external_id: string }[]> = {
  c1: [{ kind: 'telegram:chat_id', external_id: '555' }],
  c2: [{ kind: 'telegram:chat_id', external_id: '556' }],
};

function fakeDb(identities: typeof DEFAULT_IDENTITIES = DEFAULT_IDENTITIES) {
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  // Chainable and awaitable: covers updates and finalizeBroadcastStatus's
  // count queries (always reports 0 pending / 0 failed, i.e. "all sent").
  function chainFor(table: string) {
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => void) => resolve({ count: 0 }),
    };
    let contactId: string | undefined;
    chain.select = () => chain;
    chain.eq = (col: string, val: unknown) => {
      if (table === 'contact_identities' && col === 'contact_id') {
        contactId = val as string;
      }
      return chain;
    };
    chain.update = (patch: Record<string, unknown>) => {
      updates.push({ table, patch });
      return chain;
    };
    if (table === 'contact_identities') {
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: identities[contactId ?? ''] ?? [] });
    }
    return chain;
  }
  return {
    db: { from: (table: string) => chainFor(table) } as unknown as SupabaseClient,
    updates,
  };
}

// `phone: ''` on every default fixture recipient below is deliberate (US-009):
// the non-template path never reads `recipient.phone` for its target anymore,
// only `recipient.contactId` — resolved through `contact_identities` via
// `provider.resolveTarget`, same as `lib/channels/send.ts`. A Telegram
// recipient with no phone at all must still resolve and send.
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
    planned: [{ recipientRowId: 'r1', contactId: 'c1', phone: '', params: ['Maria'] }],
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
          { recipientRowId: 'r1', contactId: 'c1', phone: '', params: ['Maria'] },
          { recipientRowId: 'r2', contactId: 'c2', phone: '', params: ['João'] },
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

describe('deliverBroadcast recipient addressing per channel (US-009)', () => {
  it('a Telegram-eligible contact with phone empty has its target (chat_id) resolved from contact_identities and sends', async () => {
    h.callBotApi.mockResolvedValue({ message_id: 90, chat: { id: 555 } });
    const { db, updates } = fakeDb();

    // The plan's recipient carries no phone at all (empty string, same as a
    // contact.phone='' created from an inbound Telegram message) — only a
    // contactId. Before US-009 this would have sent `{ kind: WA_PHONE_KIND,
    // address: '' }` to the provider; now it resolves via resolveTarget.
    await deliverBroadcast(
      db,
      telegramPlan({
        planned: [{ recipientRowId: 'r1', contactId: 'c1', phone: '', params: ['Maria'] }],
      })
    );

    expect(h.callBotApi).toHaveBeenCalledWith(
      'tg-tok',
      'sendMessage',
      expect.objectContaining({ chat_id: '555' })
    );
    expect(updates).toContainEqual({
      table: 'broadcast_recipients',
      patch: expect.objectContaining({
        status: 'sent',
        external_message_id: '555:90',
      }),
    });
  });

  it('fails the recipient (without aborting others) when its contact has no identity for this channel', async () => {
    h.callBotApi.mockResolvedValue({ message_id: 91, chat: { id: 556 } });
    const { db, updates } = fakeDb({ c1: [], c2: DEFAULT_IDENTITIES.c2 });

    await deliverBroadcast(
      db,
      telegramPlan({
        planned: [
          { recipientRowId: 'r1', contactId: 'c1', phone: '', params: ['Maria'] },
          { recipientRowId: 'r2', contactId: 'c2', phone: '', params: ['João'] },
        ],
      })
    );

    // No identity to resolve for r1 — the provider is never called for it,
    // and it fails without touching r2.
    expect(h.callBotApi).toHaveBeenCalledTimes(1);
    const recipientUpdates = updates.filter(
      (u) => u.table === 'broadcast_recipients'
    );
    expect(recipientUpdates).toContainEqual({
      table: 'broadcast_recipients',
      patch: expect.objectContaining({
        status: 'failed',
        error_message: 'No reachable address on this channel',
      }),
    });
    expect(recipientUpdates).toContainEqual({
      table: 'broadcast_recipients',
      patch: expect.objectContaining({
        status: 'sent',
        external_message_id: '556:91',
      }),
    });
  });
});

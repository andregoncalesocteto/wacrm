/**
 * US-004: createBroadcast's connection resolution is now generic and
 * explicit — a required `connectionId`, resolved the same way
 * POST /api/v1/messages' pickConnection resolves one (getConnectionById +
 * ownership check), no channel_type filter, no automatic "the account's
 * WhatsApp connection" fallback. This replaces the characterization tests
 * US-003 wrote for the old `loadWhatsAppSendConnection(db, accountId)`
 * behavior (this file, previously) — that behavior is exactly what this
 * story changes.
 *
 * The other half of US-003's scope — the `deliverBroadcast` branch that
 * rejects with `ChannelError('unsupported', ...)` when
 * `!provider.capabilities.templates` (about to become a send branch in
 * US-005) — is untouched by this story and stays characterized by
 * `broadcast-core.provider.test.ts` (added in channel-abstraction, US-030).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';
import type { ChannelConnection } from '@/lib/channels/connections';
import { BroadcastError, createBroadcast } from './broadcast-core';

const h = vi.hoisted(() => ({
  getConnectionById: vi.fn(),
  getConnectionCredentials: vi.fn(),
}));

vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionById: h.getConnectionById,
  getConnectionCredentials: h.getConnectionCredentials,
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

// `message_templates` lookup (resolveTemplateRow): `await db.from(...).select().eq().eq()`
// with no terminal method, so a plain (non-thenable) chain object resolves to
// itself on `await`, `data` comes back `undefined`, and resolveTemplateRow
// treats that as "no local template row" — same shape broadcast-core.test.ts
// relies on.
function fakeDb(rpc: (name: string, args: unknown) => Promise<unknown>) {
  return {
    rpc,
    from: (table: string) => {
      if (table === 'message_templates') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
        };
        return chain;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

const okRpc = () =>
  Promise.resolve({
    data: [{ broadcast_id: 'b-1', recipient_id: 'r-1', contact_id: 'c1' }],
    error: null,
  });

beforeEach(() => {
  h.getConnectionById.mockReset();
  h.getConnectionCredentials.mockReset();
  h.getConnectionCredentials.mockResolvedValue({ access_token: 'tok' });
});

describe('createBroadcast connection resolution (US-004: explicit connectionId)', () => {
  it('resolves the given connectionId via getConnectionById — no channel_type filter, no fallback', async () => {
    const conn = whatsappConnectionRow('acc', 'pn-1') as unknown as ChannelConnection;
    h.getConnectionById.mockResolvedValue(conn);
    const db = fakeDb(okRpc);

    await createBroadcast(db, 'acc', 'user', {
      connectionId: 'conn-acc',
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(h.getConnectionById).toHaveBeenCalledTimes(1);
    expect(h.getConnectionById).toHaveBeenCalledWith('conn-acc', db);
  });

  it('throws not_found (404) when the connection does not exist', async () => {
    h.getConnectionById.mockResolvedValue(null);
    const db = fakeDb(okRpc);

    const err = await createBroadcast(db, 'acc', 'user', {
      connectionId: 'missing',
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(BroadcastError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('throws not_found (404) when the connection belongs to another account', async () => {
    const otherAccountConn = whatsappConnectionRow(
      'other-acc',
      'pn-9'
    ) as unknown as ChannelConnection;
    h.getConnectionById.mockResolvedValue(otherAccountConn);
    const db = fakeDb(okRpc);

    const err = await createBroadcast(db, 'acc', 'user', {
      connectionId: otherAccountConn.id,
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(BroadcastError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('uses whichever connection is resolved as-is — no independent selection logic, any channel_type', async () => {
    const telegramConn = {
      ...whatsappConnectionRow('acc', 'pn-2', { id: 'conn-tg' }),
      channel_type: 'telegram',
    } as unknown as ChannelConnection;
    h.getConnectionById.mockResolvedValue(telegramConn);
    h.getConnectionCredentials.mockResolvedValue({ access_token: 'tok-2' });
    let rpcArgs: unknown;
    const db = fakeDb((_name, args) => {
      rpcArgs = args;
      return okRpc();
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      connectionId: 'conn-tg',
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.connection).toBe(telegramConn);
    expect(plan.phoneNumberId).toBe('pn-2');
    expect(plan.accessToken).toBe('tok-2');
    expect(rpcArgs).toMatchObject({ p_connection_id: 'conn-tg' });
  });
});

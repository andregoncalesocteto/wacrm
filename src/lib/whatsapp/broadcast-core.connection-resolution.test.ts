/**
 * Characterization tests (US-003) for createBroadcast's connection
 * resolution — the one piece US-004 is about to change (an explicit
 * `connection_id` parameter, resolved generically instead). Pins today's
 * behavior: createBroadcast never accepts or threads a connection id of
 * its own — it defers entirely to `loadWhatsAppSendConnection(db, accountId)`
 * with no opts, and surfaces `whatsapp_not_configured` when that resolves
 * null. Whatever connection comes back is used as-is (phoneNumberId,
 * accessToken, and the persisted `p_connection_id`) — createBroadcast has
 * no independent selection logic of its own.
 *
 * The other half of US-003's scope — the `deliverBroadcast` branch that
 * rejects with `ChannelError('unsupported', ...)` when
 * `!provider.capabilities.templates` (about to become a send branch in
 * US-005) — is already fully characterized by `broadcast-core.provider.test.ts`
 * (added in channel-abstraction, US-030): it pins the same ChannelError code,
 * that `provider.send` is never called, and that only the broadcast's status
 * is stamped `failed` with no recipient touched. Audited, not duplicated here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';
import type { ChannelConnection } from '@/lib/channels/connections';
import { BroadcastError, createBroadcast } from './broadcast-core';

const h = vi.hoisted(() => ({ loadConn: vi.fn() }));

vi.mock('@/lib/channels/whatsapp-connection', () => ({
  loadWhatsAppSendConnection: h.loadConn,
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
  h.loadConn.mockReset();
});

describe('createBroadcast connection resolution (today: no connection_id param)', () => {
  it('resolves through loadWhatsAppSendConnection(db, accountId) with no opts/connectionId', async () => {
    const conn = whatsappConnectionRow('acc', 'pn-1') as unknown as ChannelConnection;
    h.loadConn.mockResolvedValue({
      connection: conn,
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
    });
    const db = fakeDb(okRpc);

    await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(h.loadConn).toHaveBeenCalledTimes(1);
    expect(h.loadConn).toHaveBeenCalledWith(db, 'acc');
  });

  it('throws whatsapp_not_configured (400) when the account has no WhatsApp connection', async () => {
    h.loadConn.mockResolvedValue(null);
    const db = fakeDb(okRpc);

    const err = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    }).catch((e) => e);

    expect(err).toBeInstanceOf(BroadcastError);
    expect(err).toMatchObject({ code: 'whatsapp_not_configured', status: 400 });
  });

  it('uses whichever connection is resolved as-is — no independent selection logic', async () => {
    const otherConn = whatsappConnectionRow('acc', 'pn-2', {
      id: 'conn-other',
    }) as unknown as ChannelConnection;
    h.loadConn.mockResolvedValue({
      connection: otherConn,
      phoneNumberId: 'pn-2',
      accessToken: 'tok-2',
    });
    let rpcArgs: unknown;
    const db = fakeDb((_name, args) => {
      rpcArgs = args;
      return okRpc();
    });

    const plan = await createBroadcast(db, 'acc', 'user', {
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    });

    expect(plan.connection).toBe(otherConn);
    expect(plan.phoneNumberId).toBe('pn-2');
    expect(plan.accessToken).toBe('tok-2');
    expect(rpcArgs).toMatchObject({ p_connection_id: 'conn-other' });
  });
});

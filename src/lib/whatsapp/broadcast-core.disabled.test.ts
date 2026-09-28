/**
 * US-078: a broadcast is bound to one connection; a disabled one is refused
 * (planning and delivery) with the stable `connection_disabled` code, before
 * any recipient is contacted or persisted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';
import type { ChannelConnection } from '@/lib/channels/connections';
import { ConnectionDisabledError } from '@/lib/channels/types';
import {
  BroadcastError,
  createBroadcast,
  deliverBroadcast,
  type BroadcastPlan,
} from './broadcast-core';

const h = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(),
  getConnectionById: vi.fn(),
  getConnectionCredentials: vi.fn(),
  updates: [] as Record<string, unknown>[],
  rpc: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage: h.sendTemplateMessage,
}));
vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionById: h.getConnectionById,
  getConnectionCredentials: h.getConnectionCredentials,
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: vi.fn(async () => ({ id: 'c1' })),
}));

const disabledConn = whatsappConnectionRow('acc', 'pn-1', {
  disabled_at: '2026-09-01T00:00:00Z',
}) as unknown as ChannelConnection;

const db = {
  from: () => {
    const b: Record<string, unknown> = {};
    b.update = (patch: Record<string, unknown>) => {
      h.updates.push(patch);
      return b;
    };
    b.eq = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: null, error: null });
    return b;
  },
  rpc: h.rpc,
} as unknown as SupabaseClient;

beforeEach(() => {
  h.updates = [];
  h.sendTemplateMessage.mockReset();
  h.rpc.mockReset();
  h.getConnectionById.mockReset();
  h.getConnectionCredentials.mockReset();
});

describe('broadcast with a disabled connection', () => {
  it('createBroadcast refuses with 409 connection_disabled and persists nothing', async () => {
    h.getConnectionById.mockResolvedValue(disabledConn);
    const err = await createBroadcast(db, 'acc', 'user', {
      connectionId: disabledConn.id,
      templateName: 'promo',
      recipients: [{ to: '+14155550123' }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BroadcastError);
    expect(err).toMatchObject({ code: 'connection_disabled', status: 409 });
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('deliverBroadcast marks the campaign failed and never calls the provider', async () => {
    const plan: BroadcastPlan = {
      broadcastId: 'bc-1',
      templateName: 'promo',
      templateLanguage: 'pt_BR',
      connection: disabledConn,
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      templateRow: null,
      planned: [
        { recipientRowId: 'r1', contactId: 'c1', phone: '+15550000000', params: [] },
      ],
      rejected: 0,
    };
    await expect(deliverBroadcast(db, plan)).rejects.toBeInstanceOf(
      ConnectionDisabledError
    );
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
    // Only the campaign's terminal status was written; no recipient stamped.
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ status: 'failed' });
  });
});

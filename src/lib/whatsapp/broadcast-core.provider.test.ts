import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { deliverBroadcast, type BroadcastPlan } from './broadcast-core';
import { ChannelError } from '@/lib/channels/types';

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({ capabilities: { templates: false }, send: h.send }),
}));
vi.mock('@/lib/channels/providers', () => ({
  registerBuiltinProviders: () => {},
}));

describe('deliverBroadcast without the templates capability', () => {
  it('fails typed unsupported before sending anything', async () => {
    const updates: unknown[] = [];
    const db = {
      from: () => ({
        update: (patch: unknown) => {
          updates.push(patch);
          return { eq: () => Promise.resolve({}) };
        },
      }),
    } as unknown as SupabaseClient;
    const plan = {
      broadcastId: 'bc-1',
      connection: { id: 'c', channel_type: 'telegram_bot' },
      planned: [{ recipientRowId: 'r1', phone: '+15550000000', params: [] }],
    } as unknown as BroadcastPlan;

    const err = await deliverBroadcast(db, plan).catch((e) => e);

    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).code).toBe('unsupported');
    expect(h.send).not.toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ status: 'failed' })]);
  });
});

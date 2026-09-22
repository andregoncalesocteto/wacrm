import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { deliverBroadcast, type BroadcastPlan } from './broadcast-core';

const h = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  sendTemplateMessage: vi.fn(),
}));

vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionCredentials: h.getCredentials,
}));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: h.sendTemplateMessage,
}));

function fakeDb() {
  // Chainable and awaitable: covers updates and the finalize count queries.
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown) => void) => resolve({ count: 0 }),
  };
  for (const m of ['update', 'select', 'eq']) chain[m] = () => chain;
  return { from: () => chain } as unknown as SupabaseClient;
}

function plan(n: number): BroadcastPlan {
  return {
    broadcastId: 'bc-1',
    templateName: 'promo',
    templateLanguage: 'pt_BR',
    templateRow: null,
    connection: {
      id: 'conn-1',
      channel_type: 'whatsapp_cloud',
      external_id: 'PNID-1',
    },
    planned: Array.from({ length: n }, (_, i) => ({
      recipientRowId: `r${i}`,
      phone: `+55119999000${i}`,
      params: [],
    })),
  } as unknown as BroadcastPlan;
}

describe('deliverBroadcast credentials', () => {
  it('reads the connection credentials once for N recipients', async () => {
    h.getCredentials.mockResolvedValue({ access_token: 'tok' });
    h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });

    await deliverBroadcast(fakeDb(), plan(5));

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(5);
    expect(h.getCredentials).toHaveBeenCalledTimes(1);
    expect(h.getCredentials).toHaveBeenCalledWith('conn-1');
    for (const c of h.sendTemplateMessage.mock.calls) {
      expect(c[0].accessToken).toBe('tok');
    }
  });

  it('a connection without credentials fails every recipient without re-reading', async () => {
    h.getCredentials.mockResolvedValue(null);

    await deliverBroadcast(fakeDb(), plan(3));

    expect(h.getCredentials).toHaveBeenCalledTimes(1);
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { buildWebhookOrigin } from './origin';

function makeDb(phone: string | null, ids: unknown[], fail = false) {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: () => {
          if (fail) throw new Error('db down');
          return Promise.resolve({ data: { phone } });
        },
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'contact_identities' ? ids : null,
          }).then(res),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const CONN = { id: 'c1', store_id: 's1', channel_type: 'telegram' };

describe('buildWebhookOrigin', () => {
  it('carries connection, store, channel, phone and identities', async () => {
    const o = await buildWebhookOrigin(
      makeDb('15551230000', [
        { kind: 'whatsapp:phone', external_id: '15551230000' },
      ]),
      { ...CONN, channel_type: 'whatsapp_cloud' },
      'ct'
    );
    expect(o).toEqual({
      connection_id: 'c1',
      store_id: 's1',
      channel: 'whatsapp_cloud',
      contact: {
        id: 'ct',
        phone: '15551230000',
        identities: [
          { kind: 'whatsapp:phone', external_id: '15551230000', handle: null },
        ],
      },
    });
  });

  it('maps an empty phone to null', async () => {
    const o = await buildWebhookOrigin(makeDb('', []), CONN, 'ct');
    expect(o.contact.phone).toBeNull();
  });

  it('degrades to an empty contact block when the lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = await buildWebhookOrigin(makeDb(null, [], true), CONN, 'ct');
    expect(o.connection_id).toBe('c1');
    expect(o.contact).toEqual({ id: 'ct', phone: null, identities: [] });
  });

  it('handles a missing contact id and store', async () => {
    const o = await buildWebhookOrigin(
      makeDb(null, []),
      { id: 'c', channel_type: 'x' },
      null
    );
    expect(o).toMatchObject({
      store_id: null,
      contact: { id: null, phone: null, identities: [] },
    });
  });
});

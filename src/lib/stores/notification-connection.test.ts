import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  findStoreByKey,
  isValidNotificationConnection,
  resolveNotificationConnection,
} from './notification-connection';

type Row = Record<string, unknown>;

/** Minimal in-memory client: select / eq / maybeSingle / await. */
function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const rows = () =>
        (tables[table] ?? []).filter((r) =>
          filters.every(([k, v]) => r[k] === v)
        );
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push([k, v]), q),
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) =>
          Promise.resolve({ data: rows(), error: null }).then(res),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const conn = (id: string, over: Row = {}): Row => ({
  id,
  account_id: 'a1',
  store_id: 's1',
  channel_type: 'whatsapp_cloud',
  status: 'connected',
  disabled_at: null,
  ...over,
});

const store = (over: Row = {}): Row => ({
  id: 's1',
  account_id: 'a1',
  name: 'Loja',
  notification_connection_id: null,
  ...over,
});

describe('findStoreByKey', () => {
  const db = fakeDb({
    stores: [
      store({ id: 's1', store_key_normalized: '89/rpa/blc' }),
      store({ id: 's2', store_key_normalized: '89/rpa/pza' }),
      store({ id: 's3', account_id: 'a2', store_key_normalized: '77/x/y' }),
      store({ id: 's4' }),
    ],
  });

  it('finds the store regardless of case and edge spaces', async () => {
    expect((await findStoreByKey(db, 'a1', ' 89/Rpa/BLC '))?.id).toBe('s1');
  });

  it('tells businesses of the same site apart', async () => {
    expect((await findStoreByKey(db, 'a1', '89/RPA/PZA'))?.id).toBe('s2');
  });

  it('never crosses accounts and returns null for unknown or malformed keys', async () => {
    expect(await findStoreByKey(db, 'a1', '77/x/y')).toBeNull();
    expect(await findStoreByKey(db, 'a1', '1/2/3')).toBeNull();
    expect(await findStoreByKey(db, 'a1', '89/RPA')).toBeNull();
  });
});

describe('resolveNotificationConnection', () => {
  const resolve = (conns: Row[], s: Row = store()) =>
    resolveNotificationConnection(
      fakeDb({ stores: [s], channel_connections: conns }),
      'a1',
      's1'
    );

  it('uses the only active WhatsApp connection', async () => {
    expect(await resolve([conn('c1')])).toEqual({
      ok: true,
      connectionId: 'c1',
    });
    expect(await resolve([conn('c1', { status: 'degraded' })])).toEqual({
      ok: true,
      connectionId: 'c1',
    });
  });

  it('ignores disabled, down and non-phone connections', async () => {
    const r = await resolve([
      conn('c1', { disabled_at: '2026-01-01' }),
      conn('c2', { status: 'disconnected' }),
      conn('c3', { status: 'needs_action' }),
      conn('c4', { channel_type: 'telegram' }),
      conn('c5'),
    ]);
    expect(r).toEqual({ ok: true, connectionId: 'c5' });
  });

  it('with several, uses the store default', async () => {
    const r = await resolve(
      [conn('c1'), conn('c2')],
      store({ notification_connection_id: 'c2' })
    );
    expect(r).toEqual({ ok: true, connectionId: 'c2' });
  });

  it('with several and no default, is ambiguous', async () => {
    expect(await resolve([conn('c1'), conn('c2')])).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('with several and a default that is not active, is ambiguous', async () => {
    const r = await resolve(
      [conn('c1'), conn('c2'), conn('c3', { disabled_at: 'x' })],
      store({ notification_connection_id: 'c3' })
    );
    expect(r).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('with a single active connection, a stale default does not block it', async () => {
    const r = await resolve(
      [conn('c1'), conn('c3', { disabled_at: 'x' })],
      store({ notification_connection_id: 'c3' })
    );
    expect(r).toEqual({ ok: true, connectionId: 'c1' });
  });

  it('none when there is no active WhatsApp connection (Telegram is not reachable by phone)', async () => {
    expect(await resolve([])).toEqual({ ok: false, reason: 'none' });
    expect(await resolve([conn('t', { channel_type: 'telegram' })])).toEqual({
      ok: false,
      reason: 'none',
    });
  });

  it('is scoped by account', async () => {
    const db = fakeDb({
      stores: [store()],
      channel_connections: [conn('c1', { account_id: 'a2' })],
    });
    expect(await resolveNotificationConnection(db, 'a1', 's1')).toEqual({
      ok: false,
      reason: 'none',
    });
    expect(await resolveNotificationConnection(db, 'a2', 's1')).toEqual({
      ok: false,
      reason: 'none',
    });
  });
});

describe('isValidNotificationConnection', () => {
  const db = fakeDb({
    channel_connections: [
      conn('c1'),
      conn('c2', { store_id: 's2' }),
      conn('c3', { account_id: 'a2' }),
      conn('c4', { channel_type: 'telegram' }),
    ],
  });

  it('accepts a WhatsApp connection of the same store and account', async () => {
    expect(await isValidNotificationConnection(db, 'a1', 's1', 'c1')).toBe(
      true
    );
  });

  it('refuses another store, another account, Telegram and unknown ids', async () => {
    for (const id of ['c2', 'c3', 'c4', 'nope']) {
      expect(await isValidNotificationConnection(db, 'a1', 's1', id)).toBe(
        false
      );
    }
  });
});

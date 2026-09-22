import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  isConnectionDownTransition,
  notifyConnectionDown,
} from './connection-down';
import { recordConnectionEvent } from './connection-state';

const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('./admin-client', () => ({ supabaseAdmin: () => admin.client }));

const CONN = {
  id: 'conn-1',
  account_id: 'acc-1',
  status: 'connected' as const,
  display_name: 'Loja Centro',
};

function fakeDb(
  admins: { user_id: string }[] = [{ user_id: 'u1' }, { user_id: 'u2' }]
) {
  const inserted: unknown[][] = [];
  const roles: { in?: unknown } = {};
  const db = {
    from: vi.fn((table: string) => {
      if (table === 'profiles') {
        const q = {
          select: () => q,
          eq: () => q,
          in: (_c: string, v: unknown) => {
            roles.in = v;
            return Promise.resolve({ data: admins, error: null });
          },
        };
        return q;
      }
      if (table === 'notifications') {
        return {
          insert: (rows: unknown[]) => {
            inserted.push(rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      // channel_connections update
      return { update: () => ({ eq: () => Promise.resolve({ error: null }) }) };
    }),
  };
  return { db: db as unknown as SupabaseClient, inserted, roles };
}

describe('isConnectionDownTransition', () => {
  it('fires only when entering a down state from a different status', () => {
    expect(isConnectionDownTransition('connected', 'needs_action')).toBe(true);
    expect(isConnectionDownTransition('degraded', 'disconnected')).toBe(true);
    expect(isConnectionDownTransition('needs_action', 'needs_action')).toBe(
      false
    );
    expect(isConnectionDownTransition('disconnected', 'disconnected')).toBe(
      false
    );
    expect(isConnectionDownTransition('connected', 'degraded')).toBe(false);
    expect(isConnectionDownTransition('needs_action', 'connected')).toBe(false);
    expect(isConnectionDownTransition('connected', undefined)).toBe(false);
  });
});

describe('notifyConnectionDown', () => {
  it('creates one connection_down notification per owner/admin', async () => {
    const { db, inserted, roles } = fakeDb();
    await notifyConnectionDown(CONN, db);
    expect(roles.in).toEqual(['owner', 'admin']);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual([
      expect.objectContaining({
        account_id: 'acc-1',
        user_id: 'u1',
        type: 'connection_down',
        connection_id: 'conn-1',
      }),
      expect.objectContaining({ user_id: 'u2', connection_id: 'conn-1' }),
    ]);
  });

  it('inserts nothing when the account has no administrator', async () => {
    const { db, inserted } = fakeDb([]);
    await notifyConnectionDown(CONN, db);
    expect(inserted).toEqual([]);
  });

  it('never throws', async () => {
    const db = {
      from: () => {
        throw new Error('boom');
      },
    } as unknown as SupabaseClient;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notifyConnectionDown(CONN, db)).resolves.toBeUndefined();
  });
});

describe('recordConnectionEvent notification', () => {
  it('notifies on the transition and not while the state repeats', async () => {
    const { db, inserted } = fakeDb();
    admin.client = db;
    const patch = { status: 'needs_action' };

    await recordConnectionEvent(db, 'conn-1', patch, CONN);
    expect(inserted).toHaveLength(1);

    // Same state persisted (already needs_action): no second notification.
    await recordConnectionEvent(db, 'conn-1', patch, {
      ...CONN,
      status: 'needs_action',
    });
    await recordConnectionEvent(
      db,
      'conn-1',
      { status: 'disconnected' },
      {
        ...CONN,
        status: 'disconnected',
      }
    );
    expect(inserted).toHaveLength(1);
  });

  it('does not notify for non-down patches or without a previous state', async () => {
    const { db, inserted } = fakeDb();
    admin.client = db;
    await recordConnectionEvent(db, 'conn-1', { status: 'connected' }, CONN);
    await recordConnectionEvent(db, 'conn-1', { last_inbound_at: 'x' }, CONN);
    await recordConnectionEvent(db, 'conn-1', { status: 'needs_action' });
    expect(inserted).toEqual([]);
  });
});

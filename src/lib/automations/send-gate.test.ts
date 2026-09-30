import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  hasConsent: vi.fn(),
  resolveNotificationConnection: vi.fn(),
}));
vi.mock('@/lib/consent/consent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasConsent: m.hasConsent,
}));
vi.mock('@/lib/stores/notification-connection', () => ({
  resolveNotificationConnection: m.resolveNotificationConnection,
}));

import { gateSend, stepConsentPurpose } from './send-gate';

type Row = Record<string, unknown>;

/**
 * Conversations table with the (contact, connection) unique index. `raceOnce`
 * simulates a concurrent step that inserts the row between our read and our
 * insert: the first insert then fails with 23505 and the re-read finds it.
 */
function fakeDb(rows: Row[] = [], raceOnce = false) {
  let raced = raceOnce;
  const inserts: Row[] = [];
  const db = {
    from(table: string) {
      expect(table).toBe('conversations');
      let mode: 'select' | 'insert' = 'select';
      let payload: Row = {};
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        insert(p: Row) {
          mode = 'insert';
          payload = p;
          return q;
        },
        maybeSingle: () =>
          Promise.resolve({
            data: rows[0] ? { connection_id: 'conn-of-cv' } : null,
            error: null,
          }),
        limit: () => Promise.resolve({ data: rows.slice(0, 1), error: null }),
        single: () => {
          if (raced) {
            raced = false;
            rows.push({ id: 'cv-winner' });
            return Promise.resolve({
              data: null,
              error: { code: '23505', message: 'dup' },
            });
          }
          const row = { id: 'cv-new', ...payload };
          inserts.push(row);
          rows.push(row);
          return Promise.resolve({ data: row, error: null });
        },
        then(resolve: (v: unknown) => unknown) {
          return Promise.resolve({
            data: mode === 'select' ? rows : null,
            error: null,
          }).then(resolve);
        },
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, inserts, rows };
}

const base = {
  accountId: 'a',
  userId: 'u',
  contactId: 'c',
  purpose: 'notifications' as const,
};

beforeEach(() => {
  m.hasConsent.mockReset();
  m.resolveNotificationConnection.mockReset();
  m.resolveNotificationConnection.mockResolvedValue({
    ok: true,
    connectionId: 'conn-1',
  });
});

describe('stepConsentPurpose', () => {
  it('defaults to the strictest purpose', () => {
    expect(stepConsentPurpose(undefined)).toBe('marketing');
    expect(stepConsentPurpose('bogus')).toBe('marketing');
    expect(stepConsentPurpose('notifications')).toBe('notifications');
  });
});

describe('gateSend', () => {
  it('no consent: refuses with the purpose and touches nothing', async () => {
    m.hasConsent.mockResolvedValue(false);
    const { db, inserts } = fakeDb();
    const r = await gateSend(db, { ...base, storeId: 'st-1' });
    expect(r).toEqual({
      ok: false,
      reason: 'sem consentimento: notifications',
    });
    expect(inserts).toEqual([]);
    expect(m.hasConsent).toHaveBeenCalledWith(db, 'a', 'c', 'notifications', {
      connectionId: 'conn-1',
    });
  });

  it('a run that already has a conversation keeps it', async () => {
    m.hasConsent.mockResolvedValue(true);
    const { db, inserts } = fakeDb();
    const r = await gateSend(db, {
      ...base,
      conversationId: 'cv-1',
      storeId: 'st-1',
    });
    expect(r).toMatchObject({ ok: true, conversationId: 'cv-1' });
    expect(inserts).toEqual([]);
  });

  it('scopes the consent to the connection of the step conversation', async () => {
    m.hasConsent.mockResolvedValue(true);
    const { db } = fakeDb([{ id: 'cv-1' }]);
    await gateSend(db, { ...base, conversationId: 'cv-1' });
    expect(m.hasConsent).toHaveBeenCalledWith(db, 'a', 'c', 'notifications', {
      connectionId: 'conn-of-cv',
    });
  });

  it('creates the conversation CLOSED on the notification connection', async () => {
    m.hasConsent.mockResolvedValue(true);
    const { db, inserts } = fakeDb();
    const r = await gateSend(db, { ...base, storeId: 'st-1' });
    expect(r).toEqual({
      ok: true,
      conversationId: 'cv-new',
      connectionId: 'conn-1',
    });
    expect(inserts[0]).toMatchObject({
      account_id: 'a',
      contact_id: 'c',
      connection_id: 'conn-1',
      status: 'closed',
    });
  });

  it('reuses an existing conversation of (contact, connection) instead of creating', async () => {
    m.hasConsent.mockResolvedValue(true);
    const { db, inserts } = fakeDb([{ id: 'cv-old' }]);
    const r = await gateSend(db, { ...base, storeId: 'st-1' });
    expect(r).toMatchObject({ ok: true, conversationId: 'cv-old' });
    expect(inserts).toEqual([]);
  });

  it('a concurrent step that wins the unique index is re-read, not duplicated', async () => {
    m.hasConsent.mockResolvedValue(true);
    const { db, rows } = fakeDb([], true);
    const r = await gateSend(db, { ...base, storeId: 'st-1' });
    expect(r).toMatchObject({ ok: true, conversationId: 'cv-winner' });
    expect(rows).toHaveLength(1);
  });

  it.each(['none', 'ambiguous'])(
    'no eligible connection (%s): refuses with the reason',
    async (reason) => {
      m.hasConsent.mockResolvedValue(true);
      m.resolveNotificationConnection.mockResolvedValue({ ok: false, reason });
      const { db, inserts } = fakeDb();
      const r = await gateSend(db, { ...base, storeId: 'st-1' });
      expect(r).toEqual({
        ok: false,
        reason: `sem conexão de avisos da loja (${reason})`,
      });
      expect(inserts).toEqual([]);
    }
  );

  it('no conversation and no store: legacy path (the step fails on its own), consent not consulted', async () => {
    const { db } = fakeDb();
    const r = await gateSend(db, base);
    expect(r).toEqual({ ok: true, conversationId: null, connectionId: null });
    expect(m.hasConsent).not.toHaveBeenCalled();
  });
});

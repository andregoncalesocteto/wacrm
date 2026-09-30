import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { contactsWithConsent } from './consent';

type Row = Record<string, unknown>;

/**
 * Minimal stand-in for the two batch queries of `contactsWithConsent`:
 * `contact_consents` (filtered by account/purpose/contact ids) and
 * `conversations` with the inner `messages` embed (only conversations that
 * have a customer message). Counts the queries to prove it is batched.
 */
function fakeDb(data: {
  consents: Row[];
  conversations: Row[]; // { account_id, contact_id, connection_id, hasCustomerMessage }
}) {
  const queries: { table: string; filters: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq(col: string, v: unknown) {
          filters[col] = v;
          return q;
        },
        in(col: string, v: unknown) {
          filters[col] = v;
          return q;
        },
        limit: () => q,
        then(resolve: (v: unknown) => unknown) {
          queries.push({ table, filters });
          const ids = filters.contact_id as string[];
          let rows: Row[] = [];
          if (table === 'contact_consents') {
            rows = data.consents.filter(
              (r) =>
                r.account_id === filters.account_id &&
                r.purpose === filters.purpose &&
                ids.includes(r.contact_id as string)
            );
          } else if (table === 'conversations') {
            rows = data.conversations.filter(
              (r) =>
                r.account_id === filters.account_id &&
                ids.includes(r.contact_id as string) &&
                r.hasCustomerMessage &&
                (!filters.connection_id ||
                  r.connection_id === filters.connection_id)
            );
          }
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, queries };
}

const consent = (contact_id: string, granted: boolean): Row => ({
  account_id: 'a',
  contact_id,
  purpose: 'marketing',
  granted,
});
const wrote = (contact_id: string, connection_id: string): Row => ({
  account_id: 'a',
  contact_id,
  connection_id,
  hasCustomerMessage: true,
});

describe('contactsWithConsent (batch hasConsent)', () => {
  const data = {
    consents: [
      consent('revoked', false),
      consent('granted-only-menu', true),
      consent('revoked-but-wrote', false),
    ],
    conversations: [
      wrote('wrote-here', 'c1'),
      wrote('wrote-elsewhere', 'c2'),
      wrote('revoked-but-wrote', 'c1'),
      { ...wrote('never-wrote', 'c1'), hasCustomerMessage: false },
    ],
  };
  const ids = [
    'revoked',
    'granted-only-menu',
    'revoked-but-wrote',
    'wrote-here',
    'wrote-elsewhere',
    'never-wrote',
    'no-row-at-all',
  ];

  it('an explicit revocation wins over having written; explicit grant passes', async () => {
    const { db } = fakeDb(data);
    const ok = await contactsWithConsent(db, 'a', ids, 'marketing', {
      connectionId: 'c1',
    });
    expect([...ok].sort()).toEqual(['granted-only-menu', 'wrote-here']);
  });

  it('implicit consent is scoped to the connection', async () => {
    const { db } = fakeDb(data);
    const onC2 = await contactsWithConsent(db, 'a', ids, 'marketing', {
      connectionId: 'c2',
    });
    expect([...onC2].sort()).toEqual(['granted-only-menu', 'wrote-elsewhere']);
    const any = await contactsWithConsent(db, 'a', ids, 'marketing');
    expect(any.has('wrote-here') && any.has('wrote-elsewhere')).toBe(true);
  });

  it('is filtered by account and batched: two queries per 100 contacts, not per contact', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `ct-${i}`);
    const { db, queries } = fakeDb({ consents: [], conversations: [] });
    await contactsWithConsent(db, 'a', many, 'marketing', {
      connectionId: 'c1',
    });
    expect(queries).toHaveLength(6); // 3 chunks x (consents + conversations)
    expect(queries.every((q) => q.filters.account_id === 'a')).toBe(true);
    const other = await contactsWithConsent(
      fakeDb(data).db,
      'other-account',
      ids,
      'marketing'
    );
    expect(other.size).toBe(0);
  });
});

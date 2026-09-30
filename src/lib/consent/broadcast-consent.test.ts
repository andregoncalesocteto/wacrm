import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { contactsWithConsent } from './consent';

type Row = Record<string, unknown>;

/**
 * Minimal stand-in for the batch queries of `contactsWithConsent`:
 * `contact_consents` (filtered by account/purpose/contact ids), `contacts`
 * (id + source, filtered by account) and `conversations` with the inner
 * `messages` embed (only conversations that have a customer message). Counts
 * the queries to prove it is batched.
 */
function fakeDb(data: {
  consents: Row[];
  contacts?: Row[]; // { id, account_id, source }
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
          const ids = (filters.contact_id ?? filters.id) as string[];
          let rows: Row[] = [];
          if (table === 'contacts') {
            rows = (data.contacts ?? []).filter(
              (r) =>
                r.account_id === filters.account_id &&
                ids.includes(r.id as string)
            );
          } else if (table === 'contact_consents') {
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

const contact = (id: string, source: string | null): Row => ({
  id,
  account_id: 'a',
  source,
});

describe('contactsWithConsent (narrowed batch hasConsent)', () => {
  const data = {
    consents: [
      consent('revoked', false),
      consent('granted-only-menu', true),
      consent('revoked-but-wrote', false),
    ],
    contacts: [
      contact('revoked', null),
      contact('granted-only-menu', 'menu'),
      contact('revoked-but-wrote', null),
      contact('imported', null), // CSV import: no source
      contact('api-created', 'api'),
      contact('menu-never-wrote', 'menu'),
      contact('menu-wrote-here', 'menu'),
      contact('menu-wrote-elsewhere', 'menu'),
    ],
    conversations: [
      wrote('menu-wrote-here', 'c1'),
      wrote('menu-wrote-elsewhere', 'c2'),
      wrote('revoked-but-wrote', 'c1'),
      { ...wrote('menu-never-wrote', 'c1'), hasCustomerMessage: false },
    ],
  };
  const ids = [
    'revoked',
    'granted-only-menu',
    'revoked-but-wrote',
    'imported',
    'api-created',
    'menu-never-wrote',
    'menu-wrote-here',
    'menu-wrote-elsewhere',
  ];

  it('an explicit revocation wins over having written; explicit grant passes', async () => {
    const { db } = fakeDb(data);
    const ok = await contactsWithConsent(db, 'a', ids, 'marketing', {
      connectionId: 'c1',
    });
    expect(ok.has('revoked')).toBe(false);
    expect(ok.has('revoked-but-wrote')).toBe(false);
    expect(ok.has('granted-only-menu')).toBe(true);
  });

  it('keeps messaging imported and API contacts, as broadcasts always did', async () => {
    const { db } = fakeDb(data);
    const ok = await contactsWithConsent(db, 'a', ids, 'marketing', {
      connectionId: 'c1',
    });
    expect(ok.has('imported')).toBe(true);
    expect(ok.has('api-created')).toBe(true);
  });

  it('holds back a menu-created contact who never wrote on the connection', async () => {
    const { db } = fakeDb(data);
    const ok = await contactsWithConsent(db, 'a', ids, 'marketing', {
      connectionId: 'c1',
    });
    expect(ok.has('menu-never-wrote')).toBe(false);
    expect(ok.has('menu-wrote-here')).toBe(true);
  });

  it('implicit consent of a menu contact is scoped to the connection', async () => {
    const { db } = fakeDb(data);
    const onC2 = await contactsWithConsent(db, 'a', ids, 'marketing', {
      connectionId: 'c2',
    });
    expect(onC2.has('menu-wrote-elsewhere')).toBe(true);
    expect(onC2.has('menu-wrote-here')).toBe(false);
    const any = await contactsWithConsent(db, 'a', ids, 'marketing');
    expect(any.has('menu-wrote-here') && any.has('menu-wrote-elsewhere')).toBe(
      true
    );
  });

  it('is filtered by account and batched: a few queries per 100 contacts, not per contact', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `ct-${i}`);
    const { db, queries } = fakeDb({
      consents: [],
      contacts: many.map((id) => contact(id, null)),
      conversations: [],
    });
    const out = await contactsWithConsent(db, 'a', many, 'marketing', {
      connectionId: 'c1',
    });
    expect(out.size).toBe(250); // nobody is held back: not from the menu
    // 3 chunks x (consents + contacts); no conversations query without menu contacts
    expect(queries).toHaveLength(6);
    expect(queries.every((q) => q.filters.account_id === 'a')).toBe(true);
    const other = await contactsWithConsent(
      fakeDb(data).db,
      'other-account',
      ids,
      'marketing'
    );
    expect(other.size).toBe(0); // nothing of account "a" is visible from another
  });
});

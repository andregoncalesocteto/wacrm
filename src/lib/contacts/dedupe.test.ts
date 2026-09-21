import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dedupeByPhone,
  ensurePhoneIdentity,
  findDuplicateContact,
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  normalizeKey,
} from './dedupe';

describe('normalizeKey', () => {
  it('strips every non-digit', () => {
    expect(normalizeKey('+1 (555) 123-4567')).toBe('15551234567');
    expect(normalizeKey('15551234567')).toBe('15551234567');
  });

  it('collapses different formats of the same number to one key', () => {
    expect(normalizeKey('+44 7911 123456')).toBe(normalizeKey('447911123456'));
  });
});

describe('isExactMatch', () => {
  it('treats different formatting of the same digits as exact', () => {
    expect(
      isExactMatch({ id: '1', phone: '+1 555-123-4567' }, '15551234567')
    ).toBe(true);
  });

  it('is false for a trunk-variant (fuzzy) match', () => {
    // last-8 match but not the same full number
    expect(
      isExactMatch({ id: '1', phone: '37063949836' }, '370063949836')
    ).toBe(false);
  });
});

describe('isUniqueViolation', () => {
  it('detects Postgres 23505', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });
  it('is false for other errors / non-objects', () => {
    expect(isUniqueViolation({ code: '23502' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
  });
});

describe('dedupeByPhone', () => {
  it('keeps the first occurrence and counts in-file duplicates', () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: '+1 555-1111', name: 'A' },
      { phone: '15551111', name: 'B' }, // same digits as #1
      { phone: '+1 555-2222', name: 'C' },
    ]);
    expect(unique.map((r) => r.name)).toEqual(['A', 'C']);
    expect(duplicates).toBe(1);
  });

  it('drops rows with no digits, counted as invalid rather than duplicate', () => {
    const { unique, duplicates, invalid } = dedupeByPhone([
      { phone: '   ' },
      { phone: '+1 555-3333' },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(0);
    expect(invalid).toBe(1);
  });
});

describe('findExistingContact', () => {
  // Minimal SupabaseClient stub: resolves the .from().select().eq().like()
  // chain to a fixed candidate set.
  function stubDb(rows: Array<{ id: string; phone: string }>): SupabaseClient {
    const builder = {
      select: () => builder,
      eq: () => builder,
      like: () => Promise.resolve({ data: rows, error: null }),
    };
    return { from: () => builder } as unknown as SupabaseClient;
  }

  it('returns a trunk-variant match via phonesMatch', async () => {
    const db = stubDb([{ id: 'c1', phone: '37063949836' }]);
    const hit = await findExistingContact(db, 'acct', '+370 063 949 836');
    expect(hit?.id).toBe('c1');
  });

  it('returns null when no candidate matches', async () => {
    const db = stubDb([{ id: 'c1', phone: '15559999999' }]);
    const hit = await findExistingContact(db, 'acct', '+1 555-123-4567');
    expect(hit).toBeNull();
  });

  it('returns null for an empty phone without querying', async () => {
    const db = stubDb([{ id: 'c1', phone: '15551234567' }]);
    expect(await findExistingContact(db, 'acct', '   ')).toBeNull();
  });
});

/**
 * Table-aware in-memory stub: `contacts` and `contact_identities` rows,
 * with the .eq/.like/.maybeSingle/.upsert calls the dedupe helpers use.
 */
function tableDb(tables: {
  contacts: Array<Record<string, unknown>>;
  contact_identities: Array<Record<string, unknown>>;
}) {
  const upserts: Array<Record<string, unknown>> = [];
  const db = {
    from(table: 'contacts' | 'contact_identities') {
      let rows = tables[table];
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        like: (col: string, pattern: string) => {
          const suffix = pattern.replace(/^%/, '');
          rows = rows.filter((r) => String(r[col] ?? '').endsWith(suffix));
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: rows, error: null }),
        upsert: (row: Record<string, unknown>) => {
          upserts.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, upserts };
}

describe('identity-aware duplicate detection', () => {
  const telegramOnly = {
    id: 'c-tg',
    account_id: 'acct',
    phone: '',
    name: 'Maria',
  };
  const phoneIdentity = {
    account_id: 'acct',
    contact_id: 'c-tg',
    kind: 'whatsapp:phone',
    external_id: '15551234567',
  };

  it('finds a contact whose phone column is blank through its whatsapp:phone identity', async () => {
    const { db } = tableDb({
      contacts: [telegramOnly],
      contact_identities: [phoneIdentity],
    });
    expect(await findExistingContact(db, 'acct', '+1 555 123 4567')).toBeNull();
    const hit = await findDuplicateContact(db, 'acct', '+1 (555) 123-4567');
    expect(hit?.id).toBe('c-tg');
    expect(hit?.matchedPhone).toBe('15551234567');
    expect(isExactMatch(hit!, '+1 (555) 123-4567')).toBe(true);
  });

  it('flags a trunk variant of the identity number as fuzzy, not exact', async () => {
    const { db } = tableDb({
      contacts: [telegramOnly],
      contact_identities: [{ ...phoneIdentity, external_id: '37063949836' }],
    });
    const hit = await findDuplicateContact(db, 'acct', '370063949836');
    expect(hit?.id).toBe('c-tg');
    expect(isExactMatch(hit!, '370063949836')).toBe(false);
  });

  it('ignores identities of other kinds and of other accounts', async () => {
    const { db } = tableDb({
      contacts: [telegramOnly],
      contact_identities: [
        { ...phoneIdentity, kind: 'telegram:chat_id' },
        { ...phoneIdentity, account_id: 'other' },
      ],
    });
    expect(await findDuplicateContact(db, 'acct', '15551234567')).toBeNull();
  });

  it('prefers the contacts column match when both exist', async () => {
    const { db } = tableDb({
      contacts: [
        telegramOnly,
        { id: 'c-col', account_id: 'acct', phone: '15551234567' },
      ],
      contact_identities: [phoneIdentity],
    });
    expect((await findDuplicateContact(db, 'acct', '15551234567'))?.id).toBe(
      'c-col'
    );
  });

  it('ensurePhoneIdentity upserts the digits-only whatsapp:phone identity, ignoring duplicates', async () => {
    const { db, upserts } = tableDb({ contacts: [], contact_identities: [] });
    await ensurePhoneIdentity(db, 'acct', 'c1', '+1 (555) 123-4567');
    expect(upserts).toEqual([
      {
        account_id: 'acct',
        contact_id: 'c1',
        kind: 'whatsapp:phone',
        external_id: '15551234567',
      },
    ]);
    await ensurePhoneIdentity(db, 'acct', 'c1', '   ');
    expect(upserts).toHaveLength(1);
  });
});

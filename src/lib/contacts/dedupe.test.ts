import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  dedupeByPhone,
  ensurePhoneIdentities,
  ensurePhoneIdentity,
  findDuplicateContact,
  findExistingPhoneIdentityKeys,
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  normalizeKey,
  syncPhoneIdentity,
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

/**
 * Mutable in-memory `contact_identities` stub for the bulk/sync helpers:
 * eq / in / select / delete / upsert (ignoreDuplicates) / maybeSingle.
 */
function identityDb(initial: Array<Record<string, string>>) {
  const rows = [...initial];
  const calls = { selects: 0, upserts: 0 };
  const db = {
    from() {
      let scope = rows;
      let deleting = false;
      const builder = {
        select: () => {
          calls.selects++;
          return builder;
        },
        delete: () => {
          deleting = true;
          return builder;
        },
        eq: (col: string, val: string) => {
          scope = scope.filter((r) => r[col] === val);
          return builder;
        },
        in: (col: string, vals: string[]) => {
          scope = scope.filter((r) => vals.includes(r[col]));
          return builder;
        },
        maybeSingle: () =>
          Promise.resolve({ data: scope[0] ?? null, error: null }),
        upsert: (input: Record<string, string> | Record<string, string>[]) => {
          calls.upserts++;
          for (const row of Array.isArray(input) ? input : [input]) {
            const clash = rows.some(
              (r) =>
                r.account_id === row.account_id &&
                r.kind === row.kind &&
                r.external_id === row.external_id
            );
            if (!clash) rows.push(row);
          }
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (deleting) {
            for (const r of scope) rows.splice(rows.indexOf(r), 1);
            return resolve({ error: null });
          }
          return resolve({ data: scope, error: null });
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, rows, calls };
}

const idn = (contact_id: string, external_id: string) => ({
  account_id: 'acct',
  contact_id,
  kind: 'whatsapp:phone',
  external_id,
});

describe('findExistingPhoneIdentityKeys', () => {
  it('returns only the keys held as identities, in chunked queries', async () => {
    const { db, calls } = identityDb([idn('c1', '5511'), idn('c2', '5522')]);
    const keys = Array.from({ length: 250 }, (_, i) => `9${i}`).concat([
      '5511',
      '5522',
    ]);
    const found = await findExistingPhoneIdentityKeys(db, 'acct', keys);
    expect([...found].sort()).toEqual(['5511', '5522']);
    expect(calls.selects).toBe(3); // 252 keys / 100 per chunk
  });

  it('does not query for an empty list', async () => {
    const { db, calls } = identityDb([]);
    expect((await findExistingPhoneIdentityKeys(db, 'acct', [''])).size).toBe(
      0
    );
    expect(calls.selects).toBe(0);
  });
});

describe('ensurePhoneIdentities', () => {
  it('batch-inserts digits-only identities, skipping blanks and existing ones', async () => {
    const { db, rows, calls } = identityDb([idn('c0', '5599')]);
    await ensurePhoneIdentities(db, 'acct', [
      { contactId: 'c1', phone: '+55 (11)' },
      { contactId: 'c2', phone: '5599' },
      { contactId: 'c3', phone: 'abc' },
    ]);
    expect(calls.upserts).toBe(1);
    expect(rows.map((r) => `${r.contact_id}:${r.external_id}`)).toEqual([
      'c0:5599',
      'c1:5511',
    ]);
  });
});

describe('syncPhoneIdentity', () => {
  const args = (oldPhone: string, newPhone: string) => ({
    accountId: 'acct',
    contactId: 'c1',
    oldPhone,
    newPhone,
  });

  it('replaces the identity of the old number with the new one', async () => {
    const { db, rows } = identityDb([idn('c1', '15551234567')]);
    const res = await syncPhoneIdentity(
      db,
      args('+1 555 123 4567', '+1 555 999 0000')
    );
    expect(res).toEqual({ ok: true });
    expect(rows).toEqual([idn('c1', '15559990000')]);
  });

  it('removes the identity when the phone is cleared', async () => {
    const { db, rows } = identityDb([idn('c1', '15551234567')]);
    expect(await syncPhoneIdentity(db, args('15551234567', ''))).toEqual({
      ok: true,
    });
    expect(rows).toEqual([]);
  });

  it('keeps the identity when the phone did not change (formatting aside)', async () => {
    const { db, rows } = identityDb([idn('c1', '15551234567')]);
    await syncPhoneIdentity(db, args('15551234567', '+1 (555) 123-4567'));
    expect(rows).toEqual([idn('c1', '15551234567')]);
  });

  it('creates the identity for a contact that had none', async () => {
    const { db, rows } = identityDb([]);
    await syncPhoneIdentity(db, args('', '15551234567'));
    expect(rows).toEqual([idn('c1', '15551234567')]);
  });

  it('does not steal a number held by another contact', async () => {
    const { db, rows } = identityDb([
      idn('c1', '15551234567'),
      idn('c2', '15559990000'),
    ]);
    const res = await syncPhoneIdentity(db, args('15551234567', '15559990000'));
    expect(res).toEqual({ ok: false, conflictContactId: 'c2' });
    expect(rows).toEqual([idn('c1', '15551234567'), idn('c2', '15559990000')]);
  });

  it("leaves other contacts' identities and other kinds alone", async () => {
    const other = { ...idn('c1', 'zed'), kind: 'telegram:handle' };
    const { db, rows } = identityDb([
      idn('c1', '15551234567'),
      idn('c2', '15550001111'),
      other,
    ]);
    await syncPhoneIdentity(db, args('15551234567', '15559990000'));
    expect(rows).toContainEqual(other);
    expect(rows).toContainEqual(idn('c2', '15550001111'));
    expect(rows).toContainEqual(idn('c1', '15559990000'));
    expect(rows).not.toContainEqual(idn('c1', '15551234567'));
  });
});

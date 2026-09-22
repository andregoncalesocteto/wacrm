import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Mock the two collaborators `setContactTags` writes through so the
// tests can assert exactly which joins it adds and removes.
const resolveImportTagIds = vi.fn();
vi.mock('@/lib/contacts/resolve-import-tags', () => ({
  resolveImportTagIds: (...args: unknown[]) => resolveImportTagIds(...args),
}));
const addContactTagAndDispatch = vi.fn();
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: (...args: unknown[]) =>
    addContactTagAndDispatch(...args),
}));

import {
  serializeContact,
  findOrCreateContact,
  setContactTags,
  ContactError,
} from './contacts';

describe('serializeContact', () => {
  it('flattens contact_tags(tags(*)) onto a tags array and nulls missing fields', () => {
    const row = {
      id: 'c1',
      phone: '+14155550123',
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      contact_tags: [
        { tags: { id: 't1', name: 'vip', color: '#fff' } },
        { tags: null }, // orphaned join — dropped
      ],
    };
    expect(serializeContact(row)).toEqual({
      id: 'c1',
      phone: '+14155550123',
      identities: [],
      name: 'Jane',
      email: null,
      company: 'Acme',
      avatar_url: null,
      tags: [{ id: 't1', name: 'vip', color: '#fff' }],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    });
  });

  it('tolerates a row with no contact_tags key', () => {
    const row = {
      id: 'c2',
      phone: '+1',
      name: null,
      email: null,
      company: null,
      avatar_url: null,
      created_at: 'a',
      updated_at: 'b',
    };
    expect(serializeContact(row).tags).toEqual([]);
  });
});

describe('findOrCreateContact', () => {
  const noopDb = {} as SupabaseClient;

  it('rejects a non-E.164 phone with a 400 ContactError', async () => {
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      findOrCreateContact(noopDb, 'acc', 'user', { phone: 'not-a-number' })
    ).rejects.toBeInstanceOf(ContactError);
  });

  // Table-aware stub: contacts + contact_identities, records inserts/upserts.
  function makeDb(
    contacts: Array<Record<string, unknown>>,
    identities: Array<Record<string, unknown>>
  ) {
    const inserted: Array<Record<string, unknown>> = [];
    const upserts: Array<Record<string, unknown>> = [];
    const db = {
      from(table: string) {
        let rows = table === 'contacts' ? contacts : identities;
        const b = {
          select: () => b,
          eq: (c: string, v: unknown) => {
            rows = rows.filter((r) => r[c] === v);
            return b;
          },
          like: (c: string, p: string) => {
            const suffix = p.replace(/^%/, '');
            rows = rows.filter((r) => String(r[c] ?? '').endsWith(suffix));
            return b;
          },
          maybeSingle: () =>
            Promise.resolve({ data: rows[0] ?? null, error: null }),
          then: (res: (v: unknown) => unknown) =>
            res({ data: rows, error: null }),
          insert: (row: Record<string, unknown>) => {
            inserted.push(row);
            return {
              select: () => ({
                single: () =>
                  Promise.resolve({ data: { id: 'new-1' }, error: null }),
              }),
            };
          },
          upsert: (row: Record<string, unknown>) => {
            upserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
        return b;
      },
    };
    return { db: db as unknown as SupabaseClient, inserted, upserts };
  }

  it('does not create a duplicate when the phone only exists as a whatsapp:phone identity', async () => {
    const { db, inserted } = makeDb(
      [{ id: 'c-tg', account_id: 'acc', phone: '' }],
      [
        {
          account_id: 'acc',
          contact_id: 'c-tg',
          kind: 'whatsapp:phone',
          external_id: '14155550123',
        },
      ]
    );
    const out = await findOrCreateContact(db, 'acc', 'user', {
      phone: '+14155550123',
    });
    expect(out).toEqual({ id: 'c-tg', created: false });
    expect(inserted).toHaveLength(0);
  });

  it('creates the contact and its whatsapp:phone identity when the phone is new', async () => {
    const { db, inserted, upserts } = makeDb([], []);
    const out = await findOrCreateContact(db, 'acc', 'user', {
      phone: '+14155550123',
    });
    expect(out).toEqual({ id: 'new-1', created: true });
    expect(inserted).toHaveLength(1);
    expect(upserts).toEqual([
      {
        account_id: 'acc',
        contact_id: 'new-1',
        kind: 'whatsapp:phone',
        external_id: '14155550123',
      },
    ]);
  });
});

describe('setContactTags', () => {
  /**
   * Fake just enough of the Supabase query builder for the two
   * `contact_tags` calls `setContactTags` makes: the current-joins read
   * and the diff delete. Records which tag ids were removed.
   */
  function fakeContactTagsDb(currentTagIds: string[]) {
    const removed: string[] = [];
    const builder = {
      select: () => ({
        eq: async () => ({
          data: currentTagIds.map((tag_id) => ({ tag_id })),
          error: null,
        }),
      }),
      delete: () => ({
        eq: () => ({
          in: async (_col: string, ids: string[]) => {
            removed.push(...ids);
            return { error: null };
          },
        }),
      }),
    };
    const db = {
      from: (table: string) => {
        expect(table).toBe('contact_tags');
        return builder;
      },
    } as unknown as SupabaseClient;
    return { db, removed };
  }

  // `resolveImportTagIds` returns EVERY tag in the account (it loads them
  // all for case-insensitive matching), not just the requested names.
  const allAccountTags = new Map([
    ['a', 'tag-a'],
    ['b', 'tag-b'],
    ['c', 'tag-c'],
  ]);

  beforeEach(() => {
    resolveImportTagIds.mockReset();
    addContactTagAndDispatch.mockReset();
    resolveImportTagIds.mockResolvedValue({
      tagIdByKey: allAccountTags,
      skippedNames: [],
    });
    addContactTagAndDispatch.mockResolvedValue({
      added: true,
      dispatched: false,
    });
  });

  it('only attaches the requested tags and removes unrelated ones (#560)', async () => {
    // Contact currently has c; account also has a and b; request is ["a"].
    const { db, removed } = fakeContactTagsDb(['tag-c']);

    await setContactTags(db, 'acc', 'user', 'c1', ['a']);

    const added = addContactTagAndDispatch.mock.calls.map(
      ([input]) => (input as { tagId: string }).tagId
    );
    expect(added).toEqual(['tag-a']);
    expect(removed).toEqual(['tag-c']);
  });

  it('normalizes requested names like resolveImportTagIds (trim, case, empty, dupes)', async () => {
    const { db, removed } = fakeContactTagsDb([]);

    await setContactTags(db, 'acc', 'user', 'c1', [' A ', 'a', 'B', '', '  ']);

    const added = addContactTagAndDispatch.mock.calls.map(
      ([input]) => (input as { tagId: string }).tagId
    );
    expect(added.sort()).toEqual(['tag-a', 'tag-b']);
    expect(removed).toEqual([]);
  });

  it('clears every tag when passed an empty list', async () => {
    const { db, removed } = fakeContactTagsDb(['tag-a', 'tag-c']);

    await setContactTags(db, 'acc', 'user', 'c1', []);

    expect(addContactTagAndDispatch).not.toHaveBeenCalled();
    expect(removed.sort()).toEqual(['tag-a', 'tag-c']);
  });
});

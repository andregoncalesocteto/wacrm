import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseQuickReplyStoreId } from './quick-reply-store';

// Fake with one store 's1' in account 'acct-1'.
function db(): SupabaseClient {
  return {
    from() {
      const f: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          f[k] = v;
          return q;
        },
        maybeSingle: async () => ({
          data:
            f.id === 's1' && f.account_id === 'acct-1' ? { id: 's1' } : null,
          error: null,
        }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

describe('parseQuickReplyStoreId', () => {
  it('undefined when the field is absent', async () => {
    expect(await parseQuickReplyStoreId(db(), 'acct-1', {})).toEqual({
      ok: true,
      value: undefined,
    });
  });
  it('null and empty string mean network-wide', async () => {
    for (const store_id of [null, '']) {
      expect(
        await parseQuickReplyStoreId(db(), 'acct-1', { store_id })
      ).toEqual({
        ok: true,
        value: null,
      });
    }
  });
  it('accepts a store of the account', async () => {
    expect(
      await parseQuickReplyStoreId(db(), 'acct-1', { store_id: 's1' })
    ).toEqual({ ok: true, value: 's1' });
  });
  it('rejects a store of another account or unknown', async () => {
    expect(
      (await parseQuickReplyStoreId(db(), 'acct-2', { store_id: 's1' })).ok
    ).toBe(false);
    expect(
      (await parseQuickReplyStoreId(db(), 'acct-1', { store_id: 'nope' })).ok
    ).toBe(false);
  });
  it('rejects a non-string', async () => {
    expect(
      (await parseQuickReplyStoreId(db(), 'acct-1', { store_id: 7 })).ok
    ).toBe(false);
  });
});

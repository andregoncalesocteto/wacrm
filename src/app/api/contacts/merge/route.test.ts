import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route test for POST /api/contacts/merge. The role helper is the real one
// over a mocked session; the session client is a tiny fake that honours the
// account filter, so cross-account ids are really rejected.

const h = vi.hoisted(() => ({
  role: 'agent' as string,
  contacts: [] as Array<{ id: string; account_id: string }>,
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/auth/account')>();
  const roles = await import('@/lib/auth/roles');
  const ctx = () => ({
    supabase: {
      from: () => {
        let account = '';
        let ids: string[] = [];
        const b = {
          select: () => b,
          eq: (_k: string, v: string) => ((account = v), b),
          in: (_k: string, v: string[]) => ((ids = v), b),
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve({
              data: h.contacts.filter(
                (c) => c.account_id === account && ids.includes(c.id)
              ),
              error: null,
            }).then(res),
        };
        return b;
      },
    },
    userId: 'u1',
    accountId: 'acct-1',
    role: h.role,
    account: { id: 'acct-1', name: 'A' },
  });
  return {
    ...orig,
    requireRole: async (min: import('@/lib/auth/roles').AccountRole) => {
      const c = ctx();
      if (!roles.hasMinRole(c.role as never, min)) {
        throw new orig.ForbiddenError(`This action requires '${min}'`);
      }
      return c;
    },
  };
});

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({ rpc: h.rpc }),
}));

import { POST } from './route';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const X = '33333333-3333-4333-8333-333333333333';

const post = (body: unknown) =>
  POST(
    new Request('http://x/api/contacts/merge', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

beforeEach(() => {
  h.role = 'agent';
  h.contacts = [
    { id: A, account_id: 'acct-1' },
    { id: B, account_id: 'acct-1' },
    { id: X, account_id: 'acct-2' },
  ];
  h.rpc.mockResolvedValue({
    data: { conversations_merged: 1, notes: 2 },
    error: null,
  });
});

describe('POST /api/contacts/merge', () => {
  it('merges through merge_contacts scoped to the caller account and returns the counts', async () => {
    const res = await post({ survivor_id: A, duplicate_id: B });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      survivor_id: A,
      moved: { conversations_merged: 1, notes: 2 },
    });
    expect(h.rpc).toHaveBeenCalledWith('merge_contacts', {
      p_account_id: 'acct-1',
      p_survivor_id: A,
      p_duplicate_id: B,
    });
  });

  it('allows owner/admin too', async () => {
    h.role = 'admin';
    expect((await post({ survivor_id: A, duplicate_id: B })).status).toBe(200);
  });

  it('rejects viewers with 403 and never calls the database function', async () => {
    h.role = 'viewer';
    const res = await post({ survivor_id: A, duplicate_id: B });
    expect(res.status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('rejects a contact from another account with 404', async () => {
    const res = await post({ survivor_id: A, duplicate_id: X });
    expect(res.status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('rejects unknown contacts with 404', async () => {
    const res = await post({
      survivor_id: A,
      duplicate_id: '44444444-4444-4444-8444-444444444444',
    });
    expect(res.status).toBe(404);
  });

  it.each([
    ['invalid JSON', '{nope'],
    ['missing ids', {}],
    ['non-uuid ids', { survivor_id: 'a', duplicate_id: 'b' }],
    ['the same contact twice', { survivor_id: A, duplicate_id: A }],
  ])('rejects %s with 400', async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('maps a contact deleted meanwhile to 404 and other failures to 500 without leaking details', async () => {
    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'contact_not_found' },
    });
    expect((await post({ survivor_id: A, duplicate_id: B })).status).toBe(404);

    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'deadlock detected' },
    });
    const res = await post({ survivor_id: A, duplicate_id: B });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('deadlock');
  });
});

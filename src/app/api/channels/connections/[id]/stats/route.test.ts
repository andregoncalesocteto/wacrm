import { beforeEach, describe, expect, it, vi } from 'vitest';

// Route test for GET /connections/[id]/stats: the fake records every filter of
// each query and answers the counts by query shape.

type Call = { table: string; filters: Array<[string, string, unknown]> };
const h = vi.hoisted(() => ({
  found: true as boolean,
  calls: [] as Array<{
    table: string;
    filters: Array<[string, string, unknown]>;
  }>,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...orig,
    getCurrentAccount: async () => ({
      supabase: {
        from(table: string) {
          const call: Call = { table, filters: [] };
          h.calls.push(call);
          const add =
            (op: string) =>
            (k: string, v: unknown): unknown => (
              call.filters.push([op, k, v]),
              b
            );
          const count = () => {
            const f = (op: string, k: string) =>
              call.filters.find((x) => x[0] === op && x[1] === k)?.[2];
            if (table === 'conversations') {
              return f('neq', 'status') === 'closed' ? 2 : 5;
            }
            if (f('eq', 'sender_type') === 'customer') return 7;
            if (f('eq', 'status') === 'failed') return 1;
            return 4;
          };
          const b: Record<string, unknown> = {
            select: () => b,
            eq: add('eq'),
            neq: add('neq'),
            gte: add('gte'),
            in: add('in'),
            maybeSingle: async () => ({
              data: h.found ? { id: 'c1' } : null,
              error: null,
            }),
            then: (res: (v: unknown) => unknown) =>
              Promise.resolve({ count: count(), error: null }).then(res),
          };
          return b;
        },
      },
      accountId: 'acct-1',
      role: 'viewer',
    }),
  };
});

import { GET } from './route';

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  h.found = true;
  h.calls = [];
});

describe('GET stats', () => {
  it('returns the 24h counts and conversation counts, numbers only', async () => {
    const res = await GET(new Request('http://x'), params('c1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      received: 7,
      sent: 4,
      failed: 1,
      conversations: 5,
      open_conversations: 2,
    });
    expect(Object.keys(body).sort()).toEqual([
      'conversations',
      'failed',
      'open_conversations',
      'received',
      'sent',
      'since',
    ]);
  });

  it('scopes messages to the connection through conversations and to 24h', async () => {
    const before = Date.now();
    await GET(new Request('http://x'), params('c1'));
    const msgs = h.calls.filter((c) => c.table === 'messages');
    expect(msgs).toHaveLength(3);
    for (const c of msgs) {
      expect(c.filters).toContainEqual([
        'eq',
        'conversations.connection_id',
        'c1',
      ]);
      const gte = c.filters.find(
        (f) => f[0] === 'gte' && f[1] === 'created_at'
      );
      const age = before - new Date(gte![2] as string).getTime();
      expect(Math.abs(age - 24 * 3600 * 1000)).toBeLessThan(5000);
    }
    for (const c of h.calls.filter((c) => c.table === 'conversations')) {
      expect(c.filters).toContainEqual(['eq', 'account_id', 'acct-1']);
    }
  });

  it('is a 404 for a connection of another account', async () => {
    h.found = false;
    const res = await GET(new Request('http://x'), params('nope'));
    expect(res.status).toBe(404);
    expect(h.calls.filter((c) => c.table === 'messages')).toHaveLength(0);
  });
});

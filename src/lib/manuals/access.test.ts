import { afterEach, describe, expect, it, vi } from 'vitest';

// The REAL requireRole / getCurrentAccount run here; only Supabase and the
// two Next navigation helpers are replaced. redirect() and notFound() throw in
// Next to stop rendering, so the stubs throw tagged errors we can assert on.

type Role = 'owner' | 'admin' | 'agent' | 'viewer';

function supabaseFor(role: Role | null) {
  const rows: Record<string, unknown> = {
    profiles: { account_id: 'acc-1', account_role: role },
    accounts: { id: 'acc-1', name: 'Acme' },
  };
  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: role ? { id: 'user-1' } : null },
          error: null,
        }),
    },
    from: (table: string) => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () =>
          Promise.resolve({ data: rows[table] ?? null, error: null }),
      };
      return builder;
    },
  };
}

const createClient = vi.fn();
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => createClient(),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));

const { requireManualsAccess } = await import('./access');

afterEach(() => {
  vi.clearAllMocks();
});

describe('requireManualsAccess', () => {
  it.each(['owner', 'admin'] as const)(
    'lets an %s read the manuals',
    async (role) => {
      createClient.mockResolvedValue(supabaseFor(role));
      const ctx = await requireManualsAccess();
      expect(ctx.role).toBe(role);
    }
  );

  it.each(['agent', 'viewer'] as const)(
    'answers 404 to an %s',
    async (role) => {
      createClient.mockResolvedValue(supabaseFor(role));
      await expect(requireManualsAccess()).rejects.toThrow('NOT_FOUND');
    }
  );

  it('sends a visitor without a session to /login', async () => {
    createClient.mockResolvedValue(supabaseFor(null));
    await expect(requireManualsAccess()).rejects.toThrow('REDIRECT:/login');
  });

  it('rethrows an unexpected error instead of hiding it as a 404', async () => {
    createClient.mockRejectedValue(new Error('database is down'));
    await expect(requireManualsAccess()).rejects.toThrow('database is down');
  });
});

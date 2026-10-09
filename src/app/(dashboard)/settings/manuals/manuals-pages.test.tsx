import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Calls the page functions directly (they are async Server Components) with a
// stubbed session, to prove the role check comes FIRST and that the right
// manuals are served in this tree.

type Role = 'owner' | 'admin' | 'agent' | 'viewer';

const session = vi.hoisted(() => ({ role: 'owner' as Role }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from: (table: string) => {
      const rows: Record<string, unknown> = {
        profiles: { account_id: 'acc-1', account_role: session.role },
        accounts: { id: 'acc-1', name: 'Acme' },
      };
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return builder;
    },
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/manuals/loader', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/manuals/loader')>();
  return { ...real, getAdminManual: vi.fn(real.getAdminManual) };
});

const { getAdminManual } = await import('@/lib/manuals/loader');
const { default: IndexPage } = await import('./page');
const { default: ManualPage } = await import('./[slug]/page');

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

afterEach(() => {
  vi.clearAllMocks();
});

describe('/settings/manuals', () => {
  it.each(['owner', 'admin'] as const)(
    'lists only the admin manuals for an %s',
    async (role) => {
      session.role = role;
      const html = renderToStaticMarkup(await IndexPage());
      expect(html).toContain(
        'href="/settings/manuals/configuracao-jornada-pedido"'
      );
      expect(html).not.toContain('integracao-cardapio');
    }
  );

  it.each(['agent', 'viewer'] as const)('is a 404 for an %s', async (role) => {
    session.role = role;
    await expect(IndexPage()).rejects.toThrow('NOT_FOUND');
  });
});

describe('/settings/manuals/[slug]', () => {
  it('renders the operator manual for an owner', async () => {
    session.role = 'owner';
    const html = renderToStaticMarkup(
      await ManualPage(params('configuracao-jornada-pedido'))
    );
    expect(html).toContain('{{menu_link}}');
    expect(html).toContain('href="/settings/manuals"');
  });

  it('answers 404 to an agent BEFORE touching the manual', async () => {
    session.role = 'agent';
    await expect(
      ManualPage(params('configuracao-jornada-pedido'))
    ).rejects.toThrow('NOT_FOUND');
    expect(getAdminManual).not.toHaveBeenCalled();
  });

  it('is a 404 for the slug of a PUBLIC manual, even for an owner', async () => {
    session.role = 'owner';
    await expect(ManualPage(params('integracao-cardapio'))).rejects.toThrow(
      'NOT_FOUND'
    );
  });

  it('is a 404 for an unknown slug', async () => {
    session.role = 'admin';
    await expect(ManualPage(params('nao-existe'))).rejects.toThrow('NOT_FOUND');
  });
});

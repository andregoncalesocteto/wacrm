import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const path = vi.hoisted(() => ({ current: '/' as string | null }));

vi.mock('next/navigation', () => ({ usePathname: () => path.current }));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => `t:${key}`,
}));

const { NotFoundView } = await import('./not-found-view');
const { NotFoundAction, isDocsPath } = await import('./not-found-action');
const { default: AppNotFound } = await import('@/app/not-found');

afterEach(() => {
  path.current = '/';
});

describe('NotFoundView', () => {
  const html = renderToStaticMarkup(
    <NotFoundView title="Página não encontrada" description="Sem acesso.">
      <a href="/x">Voltar</a>
    </NotFoundView>
  );

  it('shows the title, the description and the action it is given', () => {
    expect(html).toContain('Página não encontrada');
    expect(html).toContain('Sem acesso.');
    expect(html).toContain('<a href="/x">Voltar</a>');
  });

  it('uses only theme tokens, so it follows the light and the dark mode', () => {
    expect(html).toContain('text-foreground');
    expect(html).toContain('text-muted-foreground');
    expect(html).toContain('text-primary');
    // No fixed palette colour and no hex literal that would ignore the theme.
    expect(html).not.toMatch(
      /(?:text|bg|border)-(?:black|white|gray|slate|zinc|neutral|stone)\b/
    );
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('renders without an action', () => {
    expect(
      renderToStaticMarkup(<NotFoundView title="T" description="D" />)
    ).not.toContain('<a ');
  });
});

describe('NotFoundAction', () => {
  const render = () =>
    renderToStaticMarkup(<NotFoundAction homeLabel="Home" docsLabel="Docs" />);

  it.each(['/', '/dashboard', '/settings/manuals/x', '/developersX'])(
    'goes home from %s',
    (p) => {
      path.current = p;
      expect(render()).toMatch(/href="\/"[^>]*>Home</);
    }
  );

  it.each(['/developers', '/developers/typo', '/developers/a/b'])(
    'goes to the documentation index from %s, never to the dashboard',
    (p) => {
      path.current = p;
      const out = render();
      expect(out).toMatch(/href="\/developers"[^>]*>Docs</);
      expect(out).not.toContain('href="/"');
    }
  );

  it('treats an unknown path as the app, not the docs', () => {
    expect(isDocsPath(null)).toBe(false);
  });
});

describe('app not-found page', () => {
  it('composes the view with the NotFound texts and the action', async () => {
    const out = renderToStaticMarkup(await AppNotFound());
    expect(out).toContain('t:title');
    expect(out).toContain('t:description');
    expect(out).toMatch(/href="\/"[^>]*>t:backHome</);
  });
});

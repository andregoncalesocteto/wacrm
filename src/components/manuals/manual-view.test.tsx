import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  getAdminManual,
  getPublicManual,
  type Manual,
} from '@/lib/manuals/loader';
import { extractHeadings } from '@/lib/manuals/markdown';
import type { ManualVisibility } from '@/lib/manuals/registry';

import { ManualToc } from './manual-toc';
import { ManualView } from './manual-view';

function fake(
  markdown: string,
  visibility: ManualVisibility = 'public'
): Manual {
  return {
    meta: {
      slug: 'demo',
      title: 'Demo',
      description: 'd',
      visibility,
      file: 'demo.md',
    },
    markdown,
    headings: extractHeadings(markdown),
  };
}

describe('ManualView', () => {
  it('gives every table-of-contents id to a rendered heading', async () => {
    for (const manual of [
      await getPublicManual('integracao-cardapio'),
      await getAdminManual('configuracao-jornada-pedido'),
    ]) {
      expect(manual).not.toBeNull();
      const html = renderToStaticMarkup(<ManualView manual={manual!} />);
      expect(manual!.headings.length).toBeGreaterThan(5);
      for (const h of manual!.headings) {
        expect(html, `${manual!.meta.slug}#${h.id}`).toContain(`id="${h.id}"`);
      }
    }
  });

  it('keeps {{menu_link}} and the other product variables literal', async () => {
    const manual = await getAdminManual('configuracao-jornada-pedido');
    const html = renderToStaticMarkup(<ManualView manual={manual!} />);
    expect(html).toContain('{{menu_link}}');
    expect(html).toContain('{{order_id}}');
  });

  it('puts tables inside a horizontally scrollable container', () => {
    const html = renderToStaticMarkup(
      <ManualView manual={fake('| a | b |\n| - | - |\n| 1 | 2 |\n')} />
    );
    expect(html).toMatch(/<div class="[^"]*overflow-x-auto[^"]*"><table/);
    expect(html).toContain('<th');
  });

  it('renders ./openapi.yaml as the public route and external links as safe new-tab links', () => {
    const html = renderToStaticMarkup(
      <ManualView
        manual={fake(
          'Veja [o contrato](./openapi.yaml) e [o editor](https://editor.swagger.io).'
        )}
      />
    );
    expect(html).toContain('href="/developers/openapi.yaml"');
    expect(html).toMatch(
      /href="https:\/\/editor\.swagger\.io"[^>]*target="_blank"[^>]*rel="noopener noreferrer"|href="https:\/\/editor\.swagger\.io"[^>]*rel="noopener noreferrer"[^>]*target="_blank"/
    );
  });

  it('shows a link a public manual must not have as plain text, not as a link', () => {
    const html = renderToStaticMarkup(
      <ManualView
        manual={fake(
          'Antes, [configure o CRM](./configuracao-jornada-pedido.md).'
        )}
      />
    );
    expect(html).toContain('configure o CRM');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('settings/manuals');
  });

  it('links an admin manual to the public one', () => {
    const html = renderToStaticMarkup(
      <ManualView
        manual={fake('[Integração](./integracao-cardapio.md)', 'admin')}
      />
    );
    expect(html).toContain('href="/developers/integracao-cardapio"');
  });

  it('does not render raw HTML from the Markdown', () => {
    const html = renderToStaticMarkup(
      <ManualView manual={fake('oi <script>alert(1)</script> <b>x</b>')} />
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
  });
});

describe('ManualToc', () => {
  it('links each heading by its id and hides itself when printing', () => {
    const headings = extractHeadings('## Um\n\n### `Dois`\n');
    const html = renderToStaticMarkup(
      <ManualToc headings={headings} label="Índice" />
    );
    expect(html).toContain('href="#um"');
    expect(html).toContain('href="#dois"');
    expect(html).toContain('aria-label="Índice"');
    expect(html).toContain('print:hidden');
  });

  it('renders nothing for a manual without h2/h3', () => {
    expect(
      renderToStaticMarkup(<ManualToc headings={[]} label="Índice" />)
    ).toBe('');
  });
});

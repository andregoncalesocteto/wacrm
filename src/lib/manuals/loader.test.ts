import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAdminManual,
  getPublicManual,
  listAdminManuals,
  listPublicManuals,
} from './loader';
import {
  extractHeadings,
  FALLBACK_SITE_URL,
  substituteTokens,
} from './markdown';
import { MANUALS, validateRegistry, type ManualMeta } from './registry';

describe('registry', () => {
  it('declares one public and one admin manual', () => {
    expect(MANUALS.map((m) => [m.slug, m.visibility])).toEqual([
      ['integracao-cardapio', 'public'],
      ['configuracao-jornada-pedido', 'admin'],
    ]);
  });

  it('rejects the reserved slug api-reference', () => {
    const bad: ManualMeta = {
      slug: 'api-reference',
      title: 't',
      description: 'd',
      visibility: 'public',
      file: 'x.md',
    };
    expect(() => validateRegistry([bad])).toThrow(/reserved/);
  });

  it('rejects a duplicated slug', () => {
    expect(() => validateRegistry([MANUALS[0], MANUALS[0]])).toThrow(
      /duplicated/
    );
  });
});

describe('public / admin separation (real content)', () => {
  it('serves the public manual through getPublicManual only', async () => {
    const manual = await getPublicManual('integracao-cardapio');
    expect(manual?.meta.visibility).toBe('public');
    expect(manual?.markdown.length).toBeGreaterThan(0);
    expect(await getAdminManual('integracao-cardapio')).toBeNull();
  });

  it('serves the admin manual through getAdminManual only', async () => {
    const manual = await getAdminManual('configuracao-jornada-pedido');
    expect(manual?.meta.visibility).toBe('admin');
    expect(await getPublicManual('configuracao-jornada-pedido')).toBeNull();
  });

  it('returns null for an unknown slug', async () => {
    expect(await getPublicManual('nope')).toBeNull();
    expect(await getAdminManual('nope')).toBeNull();
    expect(await getPublicManual('api-reference')).toBeNull();
  });

  it('lists each visibility separately', () => {
    expect(listPublicManuals().map((m) => m.slug)).toEqual([
      'integracao-cardapio',
    ]);
    expect(listAdminManuals().map((m) => m.slug)).toEqual([
      'configuracao-jornada-pedido',
    ]);
  });

  it('extracts the headings of a real manual', async () => {
    const manual = await getPublicManual('integracao-cardapio');
    expect(manual!.headings.length).toBeGreaterThan(10);
    expect(manual!.headings.every((h) => h.id && h.text)).toBe(true);
  });
});

describe('token substitution', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('replaces {URL_BASE} with NEXT_PUBLIC_SITE_URL, without the trailing slash', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com/');
    expect(substituteTokens('POST {URL_BASE}/api/v1/me and {URL_BASE}')).toBe(
      'POST https://crm.example.com/api/v1/me and https://crm.example.com'
    );
  });

  it('falls back to the placeholder URL when the variable is not set', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(substituteTokens('{URL_BASE}/x')).toBe(`${FALLBACK_SITE_URL}/x`);
  });

  it('leaves {{menu_link}} and the other {{…}} variables untouched', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com');
    const text =
      'Use {{menu_link}}, {{order_id}}, {{store_name}} and {URL_BASE}';
    expect(substituteTokens(text)).toBe(
      'Use {{menu_link}}, {{order_id}}, {{store_name}} and https://crm.example.com'
    );
  });
});

describe('headings', () => {
  it('gives titles with backticks and repeated titles the ids the renderer uses', () => {
    const md = [
      '# Title',
      '## Erros',
      '### `ViewContent`',
      '## Erros',
      '#### Too deep',
      '## 9. O que entregar ao time do cardápio',
    ].join('\n\n');
    expect(extractHeadings(md)).toEqual([
      { id: 'erros', text: 'Erros', depth: 2 },
      { id: 'viewcontent', text: 'ViewContent', depth: 3 },
      { id: 'erros-1', text: 'Erros', depth: 2 },
      {
        id: '9-o-que-entregar-ao-time-do-cardápio',
        text: '9. O que entregar ao time do cardápio',
        depth: 2,
      },
    ]);
  });

  it('does not take a # inside a code block for a heading', () => {
    const md = '## Real\n\n```bash\n## not a heading\n```\n';
    expect(extractHeadings(md).map((h) => h.text)).toEqual(['Real']);
  });
});

describe('locale and missing files (temporary content root)', () => {
  let root: string;
  const manual = (file: string): ManualMeta => ({
    slug: 'demo',
    title: 'Demo',
    description: 'd',
    visibility: 'public',
    file,
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'manuals-'));
    await mkdir(path.join(root, 'pt'));
    await writeFile(path.join(root, 'pt', 'demo.md'), '## Em português\n');
    await mkdir(path.join(root, 'es'));
    await writeFile(path.join(root, 'es', 'demo.md'), '## En español\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the folder of the deployment locale when it exists', async () => {
    const m = await getPublicManual('demo', {
      contentRoot: root,
      locale: 'es',
      manuals: [manual('demo.md')],
    });
    expect(m?.markdown).toContain('En español');
  });

  it('falls back to pt when the locale has no folder', async () => {
    const m = await getPublicManual('demo', {
      contentRoot: root,
      locale: 'ko',
      manuals: [manual('demo.md')],
    });
    expect(m?.markdown).toContain('Em português');
  });

  it('throws, never returns empty content, when the file does not exist', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      getPublicManual('demo', {
        contentRoot: root,
        locale: 'pt',
        manuals: [manual('missing.md')],
      })
    ).rejects.toThrow(/no file at/);
  });
});

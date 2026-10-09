// The cache and tracing rules that keep the operator manual private and make
// its files part of the standalone image (ADR-003). `next.config.ts` is not
// covered by the build's type checks of behaviour, so pin it here.

import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import nextConfig from '../../../next.config';

// Next's own matcher, the one it uses for `headers()` sources. It ships
// without type declarations, so load it by hand.
const { pathToRegexp } = createRequire(import.meta.url)(
  'next/dist/compiled/path-to-regexp'
) as { pathToRegexp: (source: string) => RegExp };

type Rule = { source: string; headers: { key: string; value: string }[] };

async function rulesFor(url: string): Promise<Rule[]> {
  const rules = (await nextConfig.headers!()) as Rule[];
  return rules.filter((rule) => pathToRegexp(rule.source).test(url));
}

async function cacheControl(url: string): Promise<string[]> {
  return (await rulesFor(url)).flatMap((rule) =>
    rule.headers.filter((h) => h.key === 'Cache-Control').map((h) => h.value)
  );
}

describe('next.config.ts: operator manuals', () => {
  it.each([
    '/settings/manuals',
    '/settings/manuals/configuracao-jornada-pedido',
  ])(
    'gives %s only `private, no-store` (no shared-cache rule)',
    async (url) => {
      expect(await cacheControl(url)).toEqual(['private, no-store']);
    }
  );

  it('keeps the public shared-cache rule for the public docs and the dashboard shell', async () => {
    for (const url of [
      '/developers',
      '/developers/integracao-cardapio',
      '/settings',
    ]) {
      const values = await cacheControl(url);
      expect(values, url).toHaveLength(1);
      expect(values[0], url).toContain('s-maxage=300');
    }
  });

  it('leaves the API on no-store, as before', async () => {
    expect(await cacheControl('/api/v1/me')).toEqual(['no-store']);
  });

  it('still applies the security headers to the manuals', async () => {
    const rules = await rulesFor('/settings/manuals/x');
    const keys = rules.flatMap((r) => r.headers.map((h) => h.key));
    expect(keys).toContain('X-Content-Type-Options');
    expect(keys).toContain('Strict-Transport-Security');
  });

  it('declares the manuals folder for the standalone trace of the admin pages', () => {
    expect(nextConfig.outputFileTracingIncludes).toEqual({
      '/settings/manuals/*': ['content/manuals/**/*'],
    });
  });
});

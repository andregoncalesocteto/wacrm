import { describe, expect, it } from 'vitest';

import { resolveManualHref } from './links';

const fromPublic = { visibility: 'public' } as const;
const fromAdmin = { visibility: 'admin' } as const;

describe('resolveManualHref', () => {
  it('sends ./openapi.yaml to the public YAML route, from either area', () => {
    expect(resolveManualHref('./openapi.yaml', fromPublic)).toBe(
      '/developers/openapi.yaml'
    );
    expect(resolveManualHref('./openapi.yaml', fromAdmin)).toBe(
      '/developers/openapi.yaml'
    );
  });

  it('resolves a public manual from a public and from an admin manual', () => {
    expect(resolveManualHref('./integracao-cardapio.md', fromPublic)).toBe(
      '/developers/integracao-cardapio'
    );
    expect(resolveManualHref('./integracao-cardapio.md', fromAdmin)).toBe(
      '/developers/integracao-cardapio'
    );
  });

  it('resolves an admin manual only from another admin manual', () => {
    expect(
      resolveManualHref('./configuracao-jornada-pedido.md', fromAdmin)
    ).toBe('/settings/manuals/configuracao-jornada-pedido');
    expect(
      resolveManualHref('./configuracao-jornada-pedido.md', fromPublic)
    ).toBeNull();
  });

  it('keeps the #anchor of a link to another manual', () => {
    expect(
      resolveManualHref('./integracao-cardapio.md#11-testando', fromAdmin)
    ).toBe('/developers/integracao-cardapio#11-testando');
    expect(resolveManualHref('./openapi.yaml#section', fromPublic)).toBe(
      '/developers/openapi.yaml#section'
    );
  });

  it('passes in-page anchors, http(s) and mailto through unchanged', () => {
    expect(resolveManualHref('#9-o-que-entregar', fromPublic)).toBe(
      '#9-o-que-entregar'
    );
    expect(resolveManualHref('https://editor.swagger.io', fromPublic)).toBe(
      'https://editor.swagger.io'
    );
    expect(resolveManualHref('http://localhost:3000/x', fromAdmin)).toBe(
      'http://localhost:3000/x'
    );
    expect(resolveManualHref('mailto:suporte@exemplo.com', fromPublic)).toBe(
      'mailto:suporte@exemplo.com'
    );
  });

  it('returns null for any other relative or root-absolute link', () => {
    expect(resolveManualHref('./nao-existe.md', fromPublic)).toBeNull();
    expect(resolveManualHref('../README.md', fromAdmin)).toBeNull();
    expect(
      resolveManualHref('/developers/api-reference', fromPublic)
    ).toBeNull();
    expect(resolveManualHref('openapi.yaml', fromPublic)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildMenuUrl,
  hasMenuLinkVariable,
  replaceMenuLinkVariable,
} from './menu-link';

describe('buildMenuUrl', () => {
  it('appends idtrack and preserves the other query parameters', () => {
    const url = new URL(
      buildMenuUrl('https://loja.example.com/menu?utm=wa&mesa=3', 'tok')
    );
    expect(url.origin + url.pathname).toBe('https://loja.example.com/menu');
    expect(url.searchParams.get('utm')).toBe('wa');
    expect(url.searchParams.get('mesa')).toBe('3');
    expect(url.searchParams.get('idtrack')).toBe('tok');
  });

  it('works on an address without a query and replaces a stale idtrack', () => {
    expect(buildMenuUrl('https://a.example.com', 't1')).toBe(
      'https://a.example.com/?idtrack=t1'
    );
    const url = new URL(
      buildMenuUrl('https://a.example.com/?idtrack=old', 'new')
    );
    expect(url.searchParams.getAll('idtrack')).toEqual(['new']);
  });
});

describe('menu_link variable', () => {
  it('is detected with or without inner spaces', () => {
    expect(hasMenuLinkVariable('Pede aqui: {{menu_link}}')).toBe(true);
    expect(hasMenuLinkVariable('Pede aqui: {{ menu_link }}')).toBe(true);
    expect(hasMenuLinkVariable('{{ vars.menu_link }}')).toBe(false);
  });

  it('expands every occurrence literally', () => {
    expect(
      replaceMenuLinkVariable(
        '{{menu_link}} e {{ menu_link }}',
        'https://x/?a=$&'
      )
    ).toBe('https://x/?a=$& e https://x/?a=$&');
  });
});

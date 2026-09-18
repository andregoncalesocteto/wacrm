import { describe, expect, it } from 'vitest';
import { pickBrowserTimeZone } from './browser-time-zone';

describe('pickBrowserTimeZone', () => {
  it('returns a valid browser time zone', () => {
    expect(pickBrowserTimeZone('America/Sao_Paulo')).toBe('America/Sao_Paulo');
  });

  it('returns undefined for an invalid time zone', () => {
    expect(pickBrowserTimeZone('Not/AZone')).toBeUndefined();
  });

  it('returns undefined when the time zone is absent', () => {
    expect(pickBrowserTimeZone(undefined)).toBeUndefined();
    expect(pickBrowserTimeZone(null)).toBeUndefined();
    expect(pickBrowserTimeZone('')).toBeUndefined();
  });
});

import { createFormatter } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { FORMATS, getFormats } from './formats';

const d = new Date('2026-09-18T14:30:00Z');
const fmt = (locale: keyof typeof FORMATS) =>
  createFormatter({ locale, timeZone: 'UTC', formats: getFormats(locale) });

describe('FORMATS', () => {
  it('pt formats dates numerically (dd/mm/aaaa, 24h)', () => {
    const f = fmt('pt');
    expect(f.dateTime(d, 'date')).toBe('18/09/2026');
    expect(f.dateTime(d, 'time')).toBe('14:30');
    expect(f.dateTime(d, 'dayMonth')).toBe('18/09');
    expect(f.dateTime(d, 'dateTime')).toMatch(/^18\/09\/2026,? 14:30$/);
    expect(f.number(1234.5)).toBe('1.234,5');
  });

  it('en keeps "Sep 18, 2026"', () => {
    const f = fmt('en');
    expect(f.dateTime(d, 'date')).toBe('Sep 18, 2026');
    expect(f.dateTime(d, 'dayMonth')).toBe('Sep 18');
    expect(f.dateTime(d, 'time')).toBe('14:30');
    expect(f.number(1234.5)).toBe('1,234.5');
  });

  it('defines every preset for every locale', () => {
    for (const locale of ['en', 'pt', 'es', 'ko'] as const) {
      const f = fmt(locale);
      for (const name of ['date', 'dateTime', 'time', 'dayMonth']) {
        expect(() => f.dateTime(d, name)).not.toThrow();
      }
      expect(() => f.number(12345, 'compact')).not.toThrow();
      expect(() => f.number(12345, 'integer')).not.toThrow();
    }
  });

  it('unknown locale falls back to en presets', () => {
    expect(getFormats('fr')).toBe(FORMATS.en);
  });
});

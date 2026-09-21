import { createFormatter } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { formatDateAndTime } from '@/lib/i18n/format-date-time';
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

  it('en reproduces the old toLocale*String output', () => {
    const f = fmt('en');
    const local = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o });
    expect(f.dateTime(d, 'date')).toBe(local({ year: 'numeric', month: 'short', day: 'numeric' }).format(d));
    expect(f.dateTime(d, 'dateLong')).toBe('September 18, 2026');
    expect(f.dateTime(d, 'dateShort')).toBe('9/18/2026');
    expect(f.dateTime(d, 'weekdayDayMonth')).toBe('Fri, Sep 18');
    expect(f.dateTime(d, 'dateTimeShort')).toBe(
      local({ month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d),
    );
    expect(f.dateTime(d, 'dateTimeSeconds')).toBe('9/18/2026, 2:30:00 PM');
  });

  it('en composes the old date-fns patterns (no comma, 24h / AM-PM)', () => {
    const f = fmt('en');
    expect(formatDateAndTime(f, d)).toBe('Sep 18, 2026 14:30');
    expect(formatDateAndTime(f, d, 'timeShort')).toBe('Sep 18, 2026 2:30 PM');
    expect(f.dateTime(d, 'dateLong')).toBe('September 18, 2026');
    expect(f.dateTime(d, 'dayMonth')).toBe('Sep 18');
  });

  it('pt composes Brazilian date and 24h time', () => {
    const f = fmt('pt');
    expect(formatDateAndTime(f, d)).toBe('18/09/2026 14:30');
    expect(formatDateAndTime(f, d, 'timeShort')).toBe('18/09/2026 14:30');
  });

  it('pt uses Brazilian forms for the added presets', () => {
    const f = fmt('pt');
    expect(f.dateTime(d, 'dateShort')).toBe('18/09/2026');
    expect(f.dateTime(d, 'dateTimeShort')).toMatch(/^18\/09\/2026,? 14:30$/);
    expect(f.dateTime(d, 'dateTimeSeconds')).toMatch(/^18\/09\/2026,? 14:30:00$/);
    expect(f.dateTime(d, 'dateLong')).toBe('18 de setembro de 2026');
  });

  it('defines every preset for every locale', () => {
    for (const locale of ['en', 'pt', 'es', 'ko'] as const) {
      const f = fmt(locale);
      for (const name of [
        'date',
        'dateTime',
        'time',
        'timeShort',
        'dayMonth',
        'dateLong',
        'dateShort',
        'dateTimeShort',
        'dateTimeSeconds',
        'weekdayDayMonth',
      ]) {
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

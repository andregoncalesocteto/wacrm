// Named date/number presets per locale (ADR-003). Consumed through
// next-intl's `formats` (request.ts) with `useFormatter().dateTime(d, 'name')`.
// `en` keeps the historical look ("Sep 18, 2026"); `pt` is numeric dd/mm/aaaa, 24h.

import type { DateTimeFormatOptions, NumberFormatOptions } from 'next-intl';

export type FormatPresets = {
  dateTime: Record<'date' | 'dateTime' | 'time' | 'dayMonth', DateTimeFormatOptions>;
  number: Record<'integer' | 'compact', NumberFormatOptions>;
};

const time24: DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
};

const numbers: FormatPresets['number'] = {
  integer: { maximumFractionDigits: 0 },
  compact: { notation: 'compact', maximumFractionDigits: 1 },
};

const medium = (dayMonth: DateTimeFormatOptions): FormatPresets['dateTime'] => ({
  date: { dateStyle: 'medium' },
  dateTime: { dateStyle: 'medium', ...time24 },
  time: time24,
  dayMonth,
});

export const FORMATS: Record<'en' | 'pt' | 'es' | 'ko', FormatPresets> = {
  en: { dateTime: medium({ month: 'short', day: 'numeric' }), number: numbers },
  pt: {
    dateTime: {
      date: { day: '2-digit', month: '2-digit', year: 'numeric' },
      dateTime: { day: '2-digit', month: '2-digit', year: 'numeric', ...time24 },
      time: time24,
      dayMonth: { day: '2-digit', month: '2-digit' },
    },
    number: numbers,
  },
  es: { dateTime: medium({ month: 'short', day: 'numeric' }), number: numbers },
  ko: { dateTime: medium({ month: 'short', day: 'numeric' }), number: numbers },
};

export function getFormats(locale: string): FormatPresets {
  return FORMATS[locale as keyof typeof FORMATS] ?? FORMATS.en;
}

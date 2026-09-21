import { enUS, es, ko, ptBR } from 'date-fns/locale';
import { describe, expect, it } from 'vitest';
import { getDateFnsLocale } from './date-fns-locale';

describe('getDateFnsLocale', () => {
  it('maps supported locales', () => {
    expect(getDateFnsLocale('pt')).toBe(ptBR);
    expect(getDateFnsLocale('es')).toBe(es);
    expect(getDateFnsLocale('ko')).toBe(ko);
    expect(getDateFnsLocale('en')).toBe(enUS);
  });

  it('falls back to enUS for unknown locales', () => {
    expect(getDateFnsLocale('fr')).toBe(enUS);
    expect(getDateFnsLocale('')).toBe(enUS);
  });
});

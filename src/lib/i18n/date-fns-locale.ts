import type { Locale } from 'date-fns';
import { enUS, es, ko, ptBR } from 'date-fns/locale';

// Maps the app locale (NEXT_PUBLIC_APP_LOCALE) to the date-fns locale used by
// relative/distance helpers. Anything unknown falls back to enUS (date-fns default).
export function getDateFnsLocale(locale: string): Locale {
  switch (locale) {
    case 'pt':
      return ptBR;
    case 'es':
      return es;
    case 'ko':
      return ko;
    default:
      return enUS;
  }
}

import type { useFormatter } from 'next-intl';

type Formatter = ReturnType<typeof useFormatter>;

// Date and time joined by a plain space ("Sep 18, 2026 11:30"), which is what
// the old date-fns patterns ("MMM d, yyyy HH:mm", "PP p") printed in en. Intl's
// own date+time presets insert a comma there, so the two parts are composed.
export function formatDateAndTime(
  formatter: Formatter,
  value: Date,
  timePreset: 'time' | 'timeShort' = 'time',
): string {
  return `${formatter.dateTime(value, 'date')} ${formatter.dateTime(value, timePreset)}`;
}

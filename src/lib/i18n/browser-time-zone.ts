/**
 * Picks the time zone the client-side formatter should use: the browser's when
 * it is a valid IANA zone, otherwise `undefined` (the parent provider keeps the
 * server zone it inherited).
 */
export function pickBrowserTimeZone(
  browserTimeZone: string | null | undefined,
): string | undefined {
  if (!browserTimeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: browserTimeZone });
    return browserTimeZone;
  } catch {
    return undefined;
  }
}

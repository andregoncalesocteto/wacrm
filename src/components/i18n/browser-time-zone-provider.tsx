'use client';

import { NextIntlClientProvider, useLocale } from 'next-intl';
import { useSyncExternalStore, type ReactNode } from 'react';
import { pickBrowserTimeZone } from '@/lib/i18n/browser-time-zone';

const subscribe = () => () => {};
const getBrowserTimeZone = () =>
  pickBrowserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
// Server render and hydration use no zone, so the parent provider's
// (server) zone applies and markup matches; the browser zone is applied
// right after hydration.
const getServerTimeZone = () => undefined;

/**
 * next-intl's provider inherits the SERVER time zone. The old toLocale*()
 * calls used the browser's, so re-provide the browser zone to keep that.
 * Nested provider inherits messages, formats, now and onError from the parent.
 */
export function BrowserTimeZoneProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const timeZone = useSyncExternalStore(
    subscribe,
    getBrowserTimeZone,
    getServerTimeZone,
  );
  return (
    <NextIntlClientProvider locale={locale} timeZone={timeZone}>
      {children}
    </NextIntlClientProvider>
  );
}

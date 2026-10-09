// ============================================================
// /developers/** — public documentation for the teams that integrate a
// digital menu. No session, no account, no database (ADR-003).
//
// noindex: the docs of a private deployment should not end up in search.
// ============================================================

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import {
  CONTRACT_STATUS,
  CONTRACT_STATUS_MESSAGE_KEY,
} from '@/lib/manuals/contract-status';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function DevelopersLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getTranslations('Developers');
  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border border-b print:hidden">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href="/developers"
              className="truncate font-semibold tracking-tight"
            >
              {t('siteTitle')}
            </Link>
            <span className="border-border bg-muted text-muted-foreground shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium">
              {t(CONTRACT_STATUS_MESSAGE_KEY[CONTRACT_STATUS])}
            </span>
          </div>
          <Link
            href="/developers/api-reference"
            className="text-primary shrink-0 text-sm font-medium underline-offset-4 hover:underline"
          >
            {t('apiReference')}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      <footer className="border-border border-t print:hidden">
        <p className="text-muted-foreground mx-auto max-w-6xl px-4 py-4 text-sm">
          {t('supportNote')}
        </p>
      </footer>
    </div>
  );
}

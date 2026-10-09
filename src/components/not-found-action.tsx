'use client';

// ============================================================
// The link of the not-found screen: where it goes depends on where you are.
//
// `/developers/<unknown>` has no segment of its own to render (the slugs are
// fixed at build time, so Next answers it as an unmatched route with the ROOT
// not-found, a true 404). A reader there is an external developer with no CRM
// account, so "back" must be the documentation index, not the dashboard (which
// would send them to the login).
// ============================================================

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { buttonVariants } from '@/components/ui/button';

export function isDocsPath(pathname: string | null): boolean {
  return (
    !!pathname &&
    (pathname === '/developers' || pathname.startsWith('/developers/'))
  );
}

export function NotFoundAction({
  homeLabel,
  docsLabel,
}: {
  homeLabel: string;
  docsLabel: string;
}) {
  const docs = isDocsPath(usePathname());
  return (
    <Link href={docs ? '/developers' : '/'} className={buttonVariants()}>
      {docs ? docsLabel : homeLabel}
    </Link>
  );
}

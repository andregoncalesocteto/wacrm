// /developers — the page the operator sends to the integrating team.
// Lists the PUBLIC manuals only (an admin manual never appears here) and the
// API reference. Static: nothing here depends on the request.

import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { listPublicManuals } from '@/lib/manuals/loader';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Developers');
  return { title: t('indexTitle'), description: t('indexIntro') };
}

const CARD =
  'block rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/60 hover:bg-muted/40';

export default async function DevelopersIndexPage() {
  const t = await getTranslations('Developers');
  const manuals = listPublicManuals();

  return (
    <div className="max-w-3xl">
      <h1 className="text-3xl font-bold tracking-tight">{t('indexTitle')}</h1>
      <p className="text-muted-foreground mt-2">{t('indexIntro')}</p>

      <h2 className="text-muted-foreground mt-10 mb-3 text-sm font-semibold tracking-[0.09em] uppercase">
        {t('manualsHeading')}
      </h2>
      <ul className="grid gap-3">
        {manuals.map((manual) => (
          <li key={manual.slug}>
            <Link href={`/developers/${manual.slug}`} className={CARD}>
              <span className="block text-lg font-semibold">
                {manual.title}
              </span>
              <span className="text-muted-foreground mt-1 block text-sm">
                {manual.description}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <h2 className="text-muted-foreground mt-10 mb-3 text-sm font-semibold tracking-[0.09em] uppercase">
        {t('apiReference')}
      </h2>
      <Link href="/developers/api-reference" className={CARD}>
        <span className="block text-lg font-semibold">{t('apiReference')}</span>
        <span className="text-muted-foreground mt-1 block text-sm">
          {t('apiReferenceDesc')}
        </span>
      </Link>
    </div>
  );
}

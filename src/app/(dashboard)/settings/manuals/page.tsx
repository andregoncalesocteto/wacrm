// /settings/manuals — the operator manuals, for owners and admins only.

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { requireManualsAccess } from '@/lib/manuals/access';
import { listAdminManuals } from '@/lib/manuals/loader';

const CARD =
  'block rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/60 hover:bg-muted/40';

export default async function ManualsIndexPage() {
  await requireManualsAccess();
  const t = await getTranslations('Manuals');
  const manuals = listAdminManuals();

  return (
    <div className="max-w-3xl">
      <Link
        href="/settings"
        className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
      >
        {t('backToSettings')}
      </Link>
      <h1 className="text-foreground mt-3 text-2xl font-bold tracking-tight">
        {t('title')}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">{t('intro')}</p>

      <ul className="mt-6 grid gap-3">
        {manuals.map((manual) => (
          <li key={manual.slug}>
            <Link href={`/settings/manuals/${manual.slug}`} className={CARD}>
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
    </div>
  );
}

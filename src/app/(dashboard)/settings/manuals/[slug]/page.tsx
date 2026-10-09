// /settings/manuals/[slug] — one operator manual. Role check FIRST, then the
// lookup: a public manual's slug is a 404 here (getAdminManual only returns
// 'admin' manuals).

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ManualPage } from '@/components/manuals/manual-page';
import { requireManualsAccess } from '@/lib/manuals/access';
import { getAdminManual } from '@/lib/manuals/loader';

export default async function AdminManualPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireManualsAccess();
  const { slug } = await params;
  const manual = await getAdminManual(slug);
  if (!manual) notFound();
  const t = await getTranslations('Manuals');

  return (
    <div>
      <Link
        href="/settings/manuals"
        className="text-muted-foreground hover:text-foreground mb-4 inline-block text-sm underline-offset-4 hover:underline print:hidden"
      >
        {t('backToManuals')}
      </Link>
      <ManualPage manual={manual} tocLabel={t('tocLabel')} />
    </div>
  );
}

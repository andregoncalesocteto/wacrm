// /developers/[slug] — a public manual, pre-rendered at build time.
// `dynamicParams = false`: any slug that is not a public manual is a 404
// without touching the disk at request time.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { ManualPage } from '@/components/manuals/manual-page';
import { getPublicManual, listPublicManuals } from '@/lib/manuals/loader';

export const dynamicParams = false;

export function generateStaticParams() {
  return listPublicManuals().map((manual) => ({ slug: manual.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const meta = listPublicManuals().find((m) => m.slug === slug);
  return { title: meta?.title, description: meta?.description };
}

export default async function PublicManualPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const manual = await getPublicManual(slug);
  if (!manual) notFound();
  const t = await getTranslations('Developers');
  return <ManualPage manual={manual} tocLabel={t('tocLabel')} />;
}

// /developers/api-reference — the Swagger UI. A literal segment, so it wins
// over `/developers/[slug]` (and the registry reserves the slug).

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { SwaggerViewer } from '@/components/manuals/swagger-viewer';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Developers');
  return { title: t('apiReference'), description: t('apiReferenceDesc') };
}

export default async function ApiReferencePage() {
  const t = await getTranslations('Developers');
  return (
    <div>
      <h1 className="mb-4 text-3xl font-bold tracking-tight">
        {t('apiReference')}
      </h1>
      <p className="border-border bg-muted/50 text-muted-foreground mb-4 rounded-lg border px-4 py-3 text-sm">
        {t('tryItOutNotice')}
      </p>
      <SwaggerViewer url="/developers/openapi.yaml" />
    </div>
  );
}

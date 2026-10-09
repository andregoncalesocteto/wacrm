// The not-found page of the whole app (unmatched URLs and `notFound()`), in
// the app's theme. Inside the dashboard it renders within the shell.

import { getTranslations } from 'next-intl/server';

import { NotFoundAction } from '@/components/not-found-action';
import { NotFoundView } from '@/components/not-found-view';

export default async function NotFound() {
  const t = await getTranslations('NotFound');
  return (
    <NotFoundView title={t('title')} description={t('description')}>
      <NotFoundAction homeLabel={t('backHome')} docsLabel={t('backToDocs')} />
    </NotFoundView>
  );
}

'use client';

import { Store } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCan } from '@/hooks/use-can';
import { Card } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * Stores section — placeholder until the store CRUD lands. Actions
 * (none yet) will require `edit-settings`; other roles see it read-only.
 */
export function StoresPanel() {
  const t = useTranslations('Settings.stores');
  const canEditSettings = useCan('edit-settings');

  return (
    <section className="animate-in fade-in-50 max-w-3xl space-y-4 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
        <Store className="text-muted-foreground size-6" />
        <p className="text-foreground text-sm font-medium">{t('listTitle')}</p>
        <p className="text-muted-foreground max-w-[46ch] text-sm">
          {t('empty')}
        </p>
        {!canEditSettings ? (
          <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
        ) : null}
      </Card>
    </section>
  );
}

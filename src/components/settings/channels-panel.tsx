'use client';

import { PlugZap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useCan } from '@/hooks/use-can';
import { Card } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';

/**
 * Channels section. Per-store connections arrive later; until then the
 * existing WhatsApp configuration stays below so the current setup flow
 * keeps working (the legacy `?tab=whatsapp` lands here).
 */
export function ChannelsPanel() {
  const t = useTranslations('Settings.channels');
  const tProvider = useTranslations('Channels.providers.whatsapp_cloud');
  const canEditSettings = useCan('edit-settings');

  return (
    <div className="space-y-8">
      <section className="animate-in fade-in-50 max-w-3xl space-y-4 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Card className="flex flex-row items-center gap-3 px-4 py-3">
          <span className="bg-primary-soft text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
            <PlugZap className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-foreground text-sm font-semibold">
              {tProvider('name')}
            </p>
            <p className="text-muted-foreground text-xs">
              {tProvider('description')}
            </p>
          </div>
        </Card>
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
        {!canEditSettings ? (
          <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
        ) : null}
      </section>
      <WhatsAppConfig />
    </div>
  );
}

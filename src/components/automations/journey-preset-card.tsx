'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShoppingBag,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useCan } from '@/hooks/use-can';
import type { JourneyPresetStatus } from '@/lib/automations/journey-preset';

/**
 * One-click "Jornada de pedido" preset with a summary of what is still
 * missing (stores without a menu URL, send steps without a WhatsApp fallback
 * template, automations still off). `refreshKey` re-reads the summary after
 * the list below changes (activation, edits).
 */
export function JourneyPresetCard({
  refreshKey,
  onInstalled,
}: {
  refreshKey: unknown;
  onInstalled: () => void;
}) {
  const t = useTranslations('Automations.journeyPreset');
  const canCreate = useCan('send-messages');
  const [status, setStatus] = useState<JourneyPresetStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [installing, setInstalling] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/automations/journey-preset', {
        cache: 'no-store',
      });
      if (!res.ok) throw new Error();
      setStatus((await res.json()).status as JourneyPresetStatus);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function install() {
    setInstalling(true);
    try {
      const res = await fetch('/api/automations/journey-preset', {
        method: 'POST',
      });
      if (!res.ok) throw new Error();
      const body = await res.json();
      setStatus(body.status as JourneyPresetStatus);
      toast.success(
        t('toastCreated', {
          created: body.created.length,
          existing: body.existing.length,
        })
      );
      onInstalled();
    } catch {
      toast.error(t('toastError'));
    } finally {
      setInstalling(false);
    }
  }

  const complete = status !== null && status.installed >= status.total;
  const nothingMissing =
    complete &&
    status.inactive.length === 0 &&
    status.storesWithoutMenuUrl.length === 0 &&
    status.missingFallbackTemplate.length === 0;
  const templateSteps =
    status?.missingFallbackTemplate.reduce((n, a) => n + a.steps, 0) ?? 0;

  return (
    <section className="border-border bg-card rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <div className="bg-primary/10 text-primary flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg">
            <ShoppingBag className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-foreground text-sm font-semibold">
              {t('title')}
            </h2>
            <p className="text-muted-foreground mt-1 text-xs">
              {t('description')}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">
              {t('selectionNote')}
            </p>
          </div>
        </div>
        {!complete && (
          <Button
            onClick={install}
            disabled={!canCreate || installing || status === null}
          >
            {installing && <Loader2 className="h-4 w-4 animate-spin" />}
            {status && status.installed > 0 ? t('installAgain') : t('install')}
          </Button>
        )}
      </div>

      {failed && <p className="mt-3 text-xs text-red-400">{t('loadError')}</p>}

      {status && (
        <div className="border-border mt-4 space-y-2 border-t pt-3 text-xs">
          <h3 className="text-foreground font-semibold">{t('statusTitle')}</h3>
          <p className="text-muted-foreground">
            {t('installedCount', {
              installed: status.installed,
              total: status.total,
            })}
          </p>
          {nothingMissing && (
            <p className="text-foreground flex items-center gap-2">
              <CheckCircle2 className="text-primary h-4 w-4" />
              {t('allSet')}
            </p>
          )}
          {status.inactive.length > 0 && (
            <Pending>
              {t('inactive', { count: status.inactive.length })}
            </Pending>
          )}
          {status.storesWithoutMenuUrl.length > 0 && (
            <Pending>
              {t('storesMissing', {
                count: status.storesWithoutMenuUrl.length,
                names: status.storesWithoutMenuUrl
                  .map((s) => s.name)
                  .join(', '),
              })}{' '}
              <Link href="/settings?tab=stores" className="underline">
                {t('storesLink')}
              </Link>
            </Pending>
          )}
          {status.missingFallbackTemplate.length > 0 && (
            <Pending>
              {t('templatesMissing', { count: templateSteps })}
              <span className="mt-1 flex flex-wrap gap-x-3">
                {status.missingFallbackTemplate.map((a) => (
                  <Link
                    key={a.id}
                    href={`/automations/${a.id}/edit`}
                    className="underline"
                  >
                    {t('templatesLink', { name: a.name })}
                  </Link>
                ))}
              </span>
            </Pending>
          )}
        </div>
      )}
    </section>
  );
}

function Pending({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground flex items-start gap-2">
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" />
      <div>{children}</div>
    </div>
  );
}

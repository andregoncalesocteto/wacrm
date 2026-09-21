'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  PlugZap,
  XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  DescriptorForm,
  type DescriptorFormSubmit,
} from '@/components/channels/descriptor-form';
import type {
  Capabilities,
  DescriptorField,
  ProviderDescriptor,
} from '@/lib/channels/types';
import {
  reasonFixKey,
  type ChannelConnectionRow,
  type StoreRef,
} from '@/lib/channels/ui';
import { getChannelUi } from '@/lib/channels/ui-registry';
import {
  WIZARD_STEPS,
  canLeaveStep,
  capabilityChips,
  fixHintKey,
  type WizardStep,
} from '@/lib/channels/wizard';
import { SettingsPanelHead } from './settings-panel-head';

interface ProviderInfo {
  type: string;
  capabilities: Capabilities;
  descriptor: ProviderDescriptor;
}

type Outcome =
  | { state: 'running'; phase: 'connect' | 'test' }
  | { state: 'ok' }
  | { state: 'failed'; reason: string; hint: string };

interface Props {
  /** Preselected store (wizard started from a store). */
  initialStoreId?: string;
  onClose: () => void;
  /** Called after any write so the list behind the wizard refreshes. */
  onChanged: () => void;
}

/**
 * "Connect a channel" in four steps: store, channel, data, connect and test.
 * Channels come from GET /api/channels/providers and the form from the UI
 * registry; nothing here names a channel. Writes go through the channels API
 * only (never the legacy whatsapp_config dual-write). Closing at any point
 * leaves the connection (if already created) in the list with its state.
 */
export function ConnectChannelWizard({
  initialStoreId,
  onClose,
  onChanged,
}: Props) {
  const t = useTranslations('Settings.channels.wizard');
  const tp = useTranslations('Channels.providers');

  const [step, setStep] = useState<WizardStep>('store');
  const [stores, setStores] = useState<StoreRef[] | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [storeId, setStoreId] = useState<string | null>(initialStoreId ?? null);
  const [channelType, setChannelType] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    connection: ChannelConnectionRow;
    pin: string;
  } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sRes, pRes] = await Promise.all([
          fetch('/api/stores', { cache: 'no-store' }),
          fetch('/api/channels/providers', { cache: 'no-store' }),
        ]);
        if (!sRes.ok || !pRes.ok) throw new Error('load');
        const sData = await sRes.json();
        const pData = await pRes.json();
        if (cancelled) return;
        const list = ((sData.stores ?? []) as StoreRef[]).map((s) => ({
          id: s.id,
          name: s.name,
        }));
        setStores(list);
        setProviders((pData.providers ?? []) as ProviderInfo[]);
        // One store: nothing to choose; keep an explicit preselection.
        setStoreId((cur) =>
          cur && list.some((s) => s.id === cur)
            ? cur
            : list.length === 1
              ? list[0].id
              : null
        );
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const provider = providers?.find((p) => p.type === channelType) ?? null;
  const ui = channelType ? getChannelUi(channelType) : null;
  const stepIndex = WIZARD_STEPS.indexOf(step);

  /** POST .../connect, then POST .../test; the outcome is what step 4 shows. */
  const runConnect = useCallback(
    async (connectionId: string, pin: string) => {
      setOutcome({ state: 'running', phase: 'connect' });
      try {
        const cRes = await fetch(
          `/api/channels/connections/${connectionId}/connect`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pin.trim() ? { pin: pin.trim() } : {}),
          }
        );
        const cData = await cRes.json().catch(() => ({}));
        onChanged();
        if (!cRes.ok || !cData.ok) {
          setOutcome({
            state: 'failed',
            reason: cData.message ?? cData.error ?? t('unreachable'),
            hint:
              reasonFixKey(cData.error?.reason) ??
              fixHintKey(cData.error?.code),
          });
          return;
        }
        setOutcome({ state: 'running', phase: 'test' });
        const tRes = await fetch(
          `/api/channels/connections/${connectionId}/test`,
          { method: 'POST' }
        );
        const tData = await tRes.json().catch(() => ({}));
        onChanged();
        if (!tRes.ok || !tData.health) {
          setOutcome({
            state: 'failed',
            reason: tData.error ?? t('unreachable'),
            hint: 'unknown',
          });
          return;
        }
        if (tData.health.state === 'connected') {
          setOutcome({ state: 'ok' });
        } else {
          setOutcome({
            state: 'failed',
            reason: tData.health.reason ?? t('notHealthy'),
            hint: tData.health.state === 'needs_action' ? 'auth' : 'unknown',
          });
        }
      } catch {
        setOutcome({
          state: 'failed',
          reason: t('unreachable'),
          hint: 'unknown',
        });
      }
    },
    [onChanged, t]
  );

  function handleCreated(
    connection: ChannelConnectionRow,
    opts: { pin: string }
  ) {
    setCreated({ connection, pin: opts.pin });
    setStep('connect');
    void runConnect(connection.id, opts.pin);
  }

  async function handleDescriptorSubmit(payload: DescriptorFormSubmit) {
    if (!storeId || !channelType) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/channels/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          store_id: storeId,
          channel_type: channelType,
          display_name: payload.displayName,
          config: payload.config,
          credentials: payload.credentials,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCreateError(
          data.code === 'duplicate_connection'
            ? t('duplicate')
            : data.code === 'invalid_credentials' &&
                tp.has(`${channelType}.fix.auth`)
              ? tp(`${channelType}.fix.auth`)
              : (data.error ?? t('createFailed'))
        );
        return;
      }
      onChanged();
      handleCreated(data.connection as ChannelConnectionRow, { pin: '' });
    } catch {
      setCreateError(t('createFailed'));
      toast.error(t('createFailed'));
    } finally {
      setCreating(false);
    }
  }

  const stepLabel: Record<WizardStep, string> = {
    store: t('step.store'),
    channel: t('step.channel'),
    data: t('step.data'),
    connect: t('step.connect'),
  };

  const loading = !loadFailed && (stores === null || providers === null);
  const noStores = stores !== null && stores.length === 0;

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onClose}>
        <ArrowLeft className="size-4" />
        {t('close')}
      </Button>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <ol className="flex flex-wrap gap-2 text-xs" aria-label={t('title')}>
        {WIZARD_STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? 'step' : undefined}
            className={`rounded-full px-3 py-1 ${
              s === step
                ? 'bg-primary text-primary-foreground'
                : i < stepIndex
                  ? 'bg-primary-soft text-primary'
                  : 'bg-muted text-muted-foreground'
            }`}
          >
            {`${i + 1}. ${stepLabel[s]}`}
          </li>
        ))}
      </ol>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
        </div>
      ) : loadFailed ? (
        <Alert className="border-red-700/50 bg-red-950/30">
          <AlertDescription className="text-red-100/80">
            {t('loadFailed')}
          </AlertDescription>
        </Alert>
      ) : step === 'store' ? (
        noStores ? (
          <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <p className="text-foreground text-sm font-medium">
              {t('noStoresTitle')}
            </p>
            <p className="text-muted-foreground max-w-[46ch] text-sm">
              {t('noStoresBody')}
            </p>
            <Button render={<Link href="/settings?tab=stores" />}>
              {t('createStore')}
            </Button>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="wizard-store">{t('storeLabel')}</Label>
              <select
                id="wizard-store"
                value={storeId ?? ''}
                onChange={(e) => setStoreId(e.target.value || null)}
                className="border-border bg-muted text-foreground h-9 w-full rounded-md border px-2 text-sm"
              >
                <option value="">{t('storePlaceholder')}</option>
                {(stores ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              disabled={!canLeaveStep('store', { storeId, channelType })}
              onClick={() => setStep('channel')}
            >
              {t('next')}
            </Button>
          </div>
        )
      ) : step === 'channel' ? (
        <div className="space-y-4">
          {(providers ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noProviders')}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {(providers ?? []).map((p) => {
                const Icon = getChannelUi(p.type)?.icon ?? PlugZap;
                const selected = p.type === channelType;
                const chips = capabilityChips(p.capabilities);
                return (
                  <li key={p.type}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setChannelType(p.type)}
                      className={`bg-card flex h-full w-full flex-col gap-2 rounded-lg border p-4 text-left transition-colors ${
                        selected
                          ? 'border-primary ring-primary/30 ring-2'
                          : 'border-border hover:bg-muted/50'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Icon className="text-primary size-4" aria-hidden />
                        <span className="text-foreground text-sm font-semibold">
                          {tp(`${p.type}.name`)}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {tp(`${p.type}.description`)}
                      </span>
                      {chips.length > 0 ? (
                        <span className="flex flex-wrap gap-1">
                          {chips.map((c) => (
                            <span
                              key={c}
                              className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px]"
                            >
                              {t(`caps.${c}`)}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep('store')}>
              {t('back')}
            </Button>
            <Button
              disabled={!canLeaveStep('channel', { storeId, channelType })}
              onClick={() => setStep('data')}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      ) : step === 'data' && storeId && channelType ? (
        <div className="space-y-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStep('channel')}
          >
            {t('back')}
          </Button>
          {ui?.kind === 'panel' ? (
            <ui.Panel
              key={`${storeId}:${channelType}`}
              connection={null}
              storeId={storeId}
              onChanged={onChanged}
              onCreated={handleCreated}
              hideChrome
            />
          ) : (
            <>
              {createError ? (
                <Alert className="border-red-700/50 bg-red-950/30">
                  <AlertDescription className="text-red-100/80">
                    {createError}
                  </AlertDescription>
                </Alert>
              ) : null}
              <DescriptorForm
                channelType={channelType}
                fields={
                  ((ui?.kind === 'form' && ui.fields.length > 0
                    ? ui.fields
                    : provider?.descriptor.fields) ?? []) as DescriptorField[]
                }
                docsUrl={ui?.kind === 'form' ? ui.docsUrl : undefined}
                submitting={creating}
                onSubmit={(p) => void handleDescriptorSubmit(p)}
              />
            </>
          )}
        </div>
      ) : step === 'connect' && created ? (
        <div className="space-y-4">
          {outcome?.state === 'ok' ? (
            <Alert className="border-emerald-700/50 bg-emerald-950/30">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-400" />
                <div>
                  <AlertTitle className="text-emerald-200">
                    {t('successTitle')}
                  </AlertTitle>
                  <AlertDescription className="text-emerald-100/80">
                    {t('successBody')}
                  </AlertDescription>
                </div>
              </div>
            </Alert>
          ) : outcome?.state === 'failed' ? (
            <Alert className="border-red-700/50 bg-red-950/30">
              <div className="flex items-start gap-3">
                <XCircle className="mt-0.5 size-5 shrink-0 text-red-400" />
                <div className="min-w-0 space-y-1">
                  <AlertTitle className="text-red-200">
                    {t('failedTitle')}
                  </AlertTitle>
                  <AlertDescription className="text-sm text-red-100/80">
                    <p>{t('reason', { reason: outcome.reason })}</p>
                    <p>
                      {channelType &&
                      tp.has(`${channelType}.fix.${outcome.hint}`)
                        ? tp(`${channelType}.fix.${outcome.hint}`)
                        : t(`fix.${outcome.hint}`)}
                    </p>
                    <p className="text-red-100/60">{t('keptInList')}</p>
                  </AlertDescription>
                </div>
              </div>
            </Alert>
          ) : (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {outcome?.state === 'running' && outcome.phase === 'test'
                ? t('testing')
                : t('connecting')}
            </div>
          )}
          <div className="flex gap-2">
            {outcome?.state === 'failed' ? (
              <Button
                onClick={() =>
                  void runConnect(created.connection.id, created.pin)
                }
              >
                {t('retry')}
              </Button>
            ) : null}
            <Button
              variant={outcome?.state === 'ok' ? 'default' : 'outline'}
              onClick={onClose}
            >
              {outcome?.state === 'ok' ? t('finish') : t('closeKeep')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

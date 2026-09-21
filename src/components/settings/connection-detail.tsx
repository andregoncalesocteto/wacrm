'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  canDeleteConnection,
  canRunConnectionActions,
  errorSuggestion,
  moveTargets,
  parseLastError,
  reasonFixKey,
  type ChannelConnectionRow,
  type StoreRef,
} from '@/lib/channels/ui';
import { getChannelUi } from '@/lib/channels/ui-registry';
import { CredentialsPanel } from '@/components/channels/credentials-panel';
import { connectionChipState, type ConnectionChipState } from '@/lib/stores/ui';

const CHIP_TONE: Record<ConnectionChipState, string> = {
  connected: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  degraded: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  disconnected: 'bg-muted text-muted-foreground',
  needs_action: 'bg-red-500/10 text-red-600 dark:text-red-400',
  disabled: 'bg-muted text-muted-foreground line-through',
};

interface Stats {
  received: number;
  sent: number;
  failed: number;
  conversations: number;
  open_conversations: number;
}

type Dialogs = 'disable' | 'move' | 'delete' | null;

interface Props {
  connection: ChannelConnectionRow;
  stores: StoreRef[];
  onBack: () => void;
  /** Refresh the list behind the detail (the row is re-read from it). */
  onChanged: () => void;
}

/**
 * Connection detail: state, last error with a suggested action, 24 h counts
 * and the actions, above the provider's own panel from the UI registry.
 */
export function ConnectionDetail({
  connection: c,
  stores,
  onBack,
  onChanged,
}: Props) {
  const t = useTranslations('Settings.channels');
  const td = useTranslations('Settings.channels.detail');
  const tpp = useTranslations('Channels.providers');
  // Translated text for a provider's stable error reason, else the raw message.
  const reasonText = (reason: string | undefined, raw: string) => {
    const k = reasonFixKey(reason);
    const key = `${c.channel_type}.fix.${k}`;
    return k && tpp.has(key) ? tpp(key) : raw;
  };
  const format = useFormatter();

  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [target, setTarget] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch(`/api/channels/connections/${c.id}/stats`, {
        cache: 'no-store',
      });
      if (res.ok) setStats((await res.json()) as Stats);
    } catch {
      /* the counts are informative only */
    }
  }, [c.id]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const state = connectionChipState(c);
  const lastError = parseLastError(c.last_error);
  const ui = getChannelUi(c.channel_type);
  const Panel = ui?.kind === 'panel' ? ui.Panel : null;
  const actionsOk = canRunConnectionActions(c);
  const targets = moveTargets(stores, c.store_id);
  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? '';
  const name = c.display_name || c.channel_type;

  const call = async (
    key: string,
    url: string,
    init: RequestInit
  ): Promise<{ ok: boolean; data: Record<string, unknown> }> => {
    setBusy(key);
    try {
      const res = await fetch(url, init);
      const data = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return { ok: res.ok, data };
    } catch {
      return { ok: false, data: {} };
    } finally {
      setBusy(null);
    }
  };
  const base = `/api/channels/connections/${c.id}`;

  const runTest = async () => {
    const { ok, data } = await call('test', `${base}/test`, { method: 'POST' });
    const health = data.health as
      { state: string; reason: string | null } | undefined;
    if (!ok || !health) {
      setResult({
        ok: false,
        text: (data.error as string) ?? td('actionFailed'),
      });
    } else if (health.state === 'connected') {
      setResult({ ok: true, text: td('testOk') });
    } else {
      setResult({
        ok: false,
        text: td('testNotOk', { reason: health.reason ?? health.state }),
      });
    }
    onChanged();
  };

  const runReconnect = async () => {
    const { ok, data } = await call('connect', `${base}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (ok && data.ok !== false) {
      setResult({ ok: true, text: td('reconnectOk') });
    } else {
      setResult({
        ok: false,
        text: td('reconnectFailed', {
          reason: reasonText(
            (data.error as { reason?: string } | undefined)?.reason,
            (data.message as string) ?? (data.error as string) ?? ''
          ),
        }),
      });
    }
    onChanged();
  };

  const runToggle = async (action: 'disable' | 'enable') => {
    const { ok, data } = await call(action, `${base}/${action}`, {
      method: 'POST',
    });
    if (!ok) {
      toast.error((data.error as string) ?? td('actionFailed'));
      return;
    }
    toast.success(
      action === 'disable'
        ? t('toastDisabled', {
            count: (data.open_conversations as number) ?? 0,
          })
        : t('toastEnabled')
    );
    setDialog(null);
    onChanged();
  };

  const runMove = async () => {
    const { ok, data } = await call('move', base, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store_id: target }),
    });
    if (!ok) {
      toast.error((data.error as string) ?? td('actionFailed'));
      return;
    }
    toast.success(td('moved', { store: storeName(target) }));
    setDialog(null);
    setTarget('');
    onChanged();
    void loadStats();
  };

  const runDelete = async () => {
    const { ok, data } = await call('delete', base, { method: 'DELETE' });
    if (!ok) {
      toast.error(
        data.code === 'has_conversations'
          ? t('toastDeleteBlocked')
          : ((data.error as string) ?? t('toastDeleteFailed'))
      );
      setDialog(null);
      onChanged();
      return;
    }
    toast.success(t('toastDeleted'));
    onChanged();
    onBack();
  };

  const count = (n: number | undefined) =>
    n === undefined ? '–' : format.number(n);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4" />
        {t('back')}
      </Button>

      <Card className="max-w-3xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-foreground text-base font-semibold">{name}</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${CHIP_TONE[state]}`}
          >
            {t(`status.${state}`)}
          </span>
          <span className="text-muted-foreground text-xs">
            {storeName(c.store_id)}
          </span>
        </div>

        <p className="text-muted-foreground text-sm" data-testid="state-reason">
          {state === 'disabled'
            ? td('reasonDisabled')
            : lastError?.message
              ? reasonText(lastError.reason, lastError.message)
              : t(`status.${state}`)}
        </p>

        {lastError ? (
          <div
            className="space-y-1 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm"
            data-testid="last-error"
          >
            <p className="text-foreground font-medium">{td('lastError')}</p>
            <p className="text-muted-foreground text-xs">
              {td('errorCode')}: <code>{lastError.code ?? '–'}</code>
            </p>
            <p className="text-foreground">
              {reasonText(lastError.reason, lastError.message)}
            </p>
            <p className="text-muted-foreground">
              {td(`suggestion.${errorSuggestion(lastError.code)}`)}
            </p>
          </div>
        ) : null}

        <div>
          <p className="text-foreground mb-2 text-sm font-medium">
            {td('last24h')}
          </p>
          <dl className="grid grid-cols-3 gap-2 text-center">
            {(
              [
                ['received', stats?.received],
                ['sent', stats?.sent],
                ['failed', stats?.failed],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="border-border rounded-lg border p-2">
                <dd
                  className="text-foreground text-lg font-semibold"
                  data-testid={`stat-${k}`}
                >
                  {count(v)}
                </dd>
                <dt className="text-muted-foreground text-xs">
                  {td(`stat.${k}`)}
                </dt>
              </div>
            ))}
          </dl>
        </div>

        {result ? (
          <p
            role="status"
            data-testid="action-result"
            className={
              result.ok
                ? 'text-sm text-emerald-600 dark:text-emerald-400'
                : 'text-sm text-red-600 dark:text-red-400'
            }
          >
            {result.text}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!actionsOk || !!busy}
            onClick={() => void runTest()}
          >
            {busy === 'test' && (
              <Loader2 className="mr-1 size-4 animate-spin" />
            )}
            {td('test')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!actionsOk || !!busy}
            onClick={() => void runReconnect()}
          >
            {busy === 'connect' && (
              <Loader2 className="mr-1 size-4 animate-spin" />
            )}
            {td('reconnect')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={targets.length === 0 || !!busy}
            title={targets.length === 0 ? td('noOtherStore') : undefined}
            onClick={() => {
              setTarget(targets[0]?.id ?? '');
              setDialog('move');
            }}
          >
            {td('move')}
          </Button>
          {state === 'disabled' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => void runToggle('enable')}
            >
              {t('enable')}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!!busy}
              onClick={() => setDialog('disable')}
            >
              {t('disable')}
            </Button>
          )}
          {canDeleteConnection(c) ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() => setDialog('delete')}
              className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
            >
              {t('delete')}
            </Button>
          ) : null}
        </div>
      </Card>

      {Panel ? (
        <Panel
          key={c.id}
          connection={c}
          storeId={c.store_id}
          onChanged={onChanged}
        />
      ) : ui?.kind === 'form' ? (
        <CredentialsPanel
          key={c.id}
          connection={c}
          channelType={c.channel_type}
          fields={ui.fields}
          onChanged={onChanged}
        />
      ) : null}

      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialog === 'move'
                ? td('moveTitle')
                : dialog === 'delete'
                  ? t('deleteTitle')
                  : t('disableTitle')}
            </DialogTitle>
            <DialogDescription>
              {dialog === 'move'
                ? td('moveConfirm', {
                    name,
                    store: storeName(target),
                    count: stats?.conversations ?? 0,
                  })
                : dialog === 'delete'
                  ? t('deleteConfirm', { name })
                  : td('disableWarning', {
                      name,
                      count: stats?.open_conversations ?? 0,
                    })}
            </DialogDescription>
          </DialogHeader>
          {dialog === 'move' ? (
            <select
              aria-label={td('targetStore')}
              className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialog(null)}
              disabled={!!busy}
            >
              {t('cancel')}
            </Button>
            <Button
              variant={dialog === 'move' ? 'default' : 'destructive'}
              disabled={!!busy || (dialog === 'move' && !target)}
              onClick={() =>
                dialog === 'move'
                  ? void runMove()
                  : dialog === 'delete'
                    ? void runDelete()
                    : void runToggle('disable')
              }
            >
              {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
              {dialog === 'move'
                ? td('moveAction')
                : dialog === 'delete'
                  ? t('delete')
                  : t('disable')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

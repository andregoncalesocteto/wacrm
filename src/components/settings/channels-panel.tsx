'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowLeft,
  Loader2,
  MessageCircle,
  Plug,
  PlugZap,
  Store,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
  emptyStateKind,
  groupConnectionsByStore,
  type ChannelConnectionRow,
  type StoreRef,
} from '@/lib/channels/ui';
import {
  configurableChannelTypes,
  getChannelUi,
} from '@/lib/channels/ui-registry';
import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';
import { connectionChipState, type ConnectionChipState } from '@/lib/stores/ui';
import { SettingsPanelHead } from './settings-panel-head';

const CHIP_TONE: Record<ConnectionChipState, string> = {
  connected: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  degraded: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  disconnected: 'bg-muted text-muted-foreground',
  needs_action: 'bg-red-500/10 text-red-600 dark:text-red-400',
  disabled: 'bg-muted text-muted-foreground line-through',
};

// Which panel is open in place of the list: a connection (edit) or a new one.
type View =
  | { mode: 'edit'; connection: ChannelConnectionRow }
  | { mode: 'create'; storeId: string; channelType: string }
  | null;

type Pending = {
  kind: 'disable' | 'delete';
  connection: ChannelConnectionRow;
} | null;

/**
 * Channels section: connections grouped by store, with state and actions.
 * "Configure" / "Connect channel" open the provider's panel from the UI
 * registry in place of the list (the guided wizard comes later). Write
 * actions require `edit-settings`.
 */
export function ChannelsPanel() {
  const t = useTranslations('Settings.channels');
  const tProvider = useTranslations('Channels.providers');
  const locale = useLocale();
  const canEditSettings = useCan('edit-settings');

  const [stores, setStores] = useState<StoreRef[]>([]);
  const [connections, setConnections] = useState<ChannelConnectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Pending>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [view, setView] = useState<View>(null);

  const load = useCallback(async () => {
    try {
      const [sRes, cRes] = await Promise.all([
        fetch('/api/stores', { cache: 'no-store' }),
        fetch('/api/channels/connections', { cache: 'no-store' }),
      ]);
      if (!sRes.ok || !cRes.ok) {
        toast.error(t('toastLoadFailed'));
        return;
      }
      const sData = await sRes.json();
      const cData = await cRes.json();
      setStores(
        ((sData.stores ?? []) as StoreRef[]).map((s) => ({
          id: s.id,
          name: s.name,
        }))
      );
      setConnections((cData.connections ?? []) as ChannelConnectionRow[]);
    } catch {
      toast.error(t('toastLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const channelLabel = (type: string) =>
    t.has(`type.${type}`) ? t(`type.${type}`) : type;

  const openCreate = () => {
    const channelType = configurableChannelTypes()[0];
    if (!channelType || stores.length === 0) return;
    setView({ mode: 'create', storeId: stores[0].id, channelType });
  };

  const runAction = async (
    c: ChannelConnectionRow,
    action: 'disable' | 'enable'
  ) => {
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/channels/connections/${c.id}/${action}`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toastActionFailed'));
        return;
      }
      toast.success(
        action === 'disable'
          ? t('toastDisabled', { count: data.open_conversations ?? 0 })
          : t('toastEnabled')
      );
      setPending(null);
      await load();
    } catch {
      toast.error(t('toastActionFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const runDelete = async (c: ChannelConnectionRow) => {
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/channels/connections/${c.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          data.code === 'has_conversations'
            ? t('toastDeleteBlocked')
            : (data.error ?? t('toastDeleteFailed'))
        );
        setPending(null);
        await load();
        return;
      }
      toast.success(t('toastDeleted'));
      setPending(null);
      await load();
    } catch {
      toast.error(t('toastDeleteFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const kind = emptyStateKind(stores.length, connections.length);
  const groups = groupConnectionsByStore(stores, connections);

  if (view) {
    const entry = getChannelUi(
      view.mode === 'edit' ? view.connection.channel_type : view.channelType
    );
    const Panel = entry?.kind === 'panel' ? entry.Panel : null;
    const storeId =
      view.mode === 'edit' ? view.connection.store_id : view.storeId;
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setView(null);
            void load();
          }}
        >
          <ArrowLeft className="size-4" />
          {t('back')}
        </Button>
        {view.mode === 'create' ? (
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="channel-store">{t('storeLabel')}</Label>
            <select
              id="channel-store"
              value={view.storeId}
              onChange={(e) => setView({ ...view, storeId: e.target.value })}
              className="border-border bg-muted text-foreground h-9 w-full rounded-md border px-2 text-sm"
            >
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {Panel ? (
          <Panel
            // A store change in create mode must not keep half-typed state
            // tied to the previous store, and each connection is its own form.
            key={view.mode === 'edit' ? view.connection.id : 'create'}
            connection={view.mode === 'edit' ? view.connection : null}
            storeId={storeId}
            onChanged={() => void load()}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section className="animate-in fade-in-50 max-w-3xl space-y-4 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        {configurableChannelTypes().map((type) => (
          <Card
            key={type}
            className="flex flex-row items-center gap-3 px-4 py-3"
          >
            <span className="bg-primary-soft text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
              <PlugZap className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="text-foreground text-sm font-semibold">
                {tProvider(`${type}.name`)}
              </p>
              <p className="text-muted-foreground text-xs">
                {tProvider(`${type}.description`)}
              </p>
            </div>
          </Card>
        ))}

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : kind === 'has-connections' ? (
          <div className="space-y-5">
            {canEditSettings ? (
              <div className="flex justify-end">
                <Button size="sm" onClick={openCreate}>
                  {t('connect')}
                </Button>
              </div>
            ) : null}
            {groups.map((g) => (
              <div key={g.store.id} className="space-y-2">
                <h3 className="text-foreground flex items-center gap-1.5 text-sm font-semibold">
                  <Store className="text-muted-foreground size-4" />
                  {g.store.name}
                </h3>
                <ul className="flex flex-col gap-2">
                  {g.connections.map((c) => {
                    const state = connectionChipState(c);
                    const ui = getChannelUi(c.channel_type);
                    const Icon = ui?.icon ?? MessageCircle;
                    const busy = busyId === c.id;
                    return (
                      <li
                        key={c.id}
                        className="border-border bg-card flex flex-wrap items-center gap-3 rounded-lg border p-3"
                      >
                        <Icon
                          className="text-muted-foreground size-4 shrink-0"
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <p className="text-foreground truncate text-sm font-medium">
                            {c.display_name || channelLabel(c.channel_type)}
                          </p>
                          <p className="text-muted-foreground truncate text-xs">
                            {channelLabel(c.channel_type)}
                            {' · '}
                            {c.last_inbound_at
                              ? t('lastInbound', {
                                  time: formatDistanceToNow(
                                    new Date(c.last_inbound_at),
                                    {
                                      addSuffix: true,
                                      locale: getDateFnsLocale(locale),
                                    }
                                  ),
                                })
                              : t('neverReceived')}
                          </p>
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${CHIP_TONE[state]}`}
                        >
                          {t(`status.${state}`)}
                        </span>
                        {canEditSettings ? (
                          <div className="flex shrink-0 flex-wrap gap-1">
                            <span
                              title={
                                ui?.kind === 'panel'
                                  ? undefined
                                  : t('configureSoon')
                              }
                            >
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={ui?.kind !== 'panel'}
                                onClick={() =>
                                  setView({ mode: 'edit', connection: c })
                                }
                              >
                                {t('configure')}
                              </Button>
                            </span>
                            {state === 'disabled' ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() => void runAction(c, 'enable')}
                              >
                                {t('enable')}
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  setPending({
                                    kind: 'disable',
                                    connection: c,
                                  })
                                }
                              >
                                {t('disable')}
                              </Button>
                            )}
                            {canDeleteConnection(c) ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() =>
                                  setPending({
                                    kind: 'delete',
                                    connection: c,
                                  })
                                }
                                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                              >
                                {t('delete')}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <Plug className="text-muted-foreground size-6" />
            <p className="text-foreground text-sm font-medium">
              {t('emptyTitle')}
            </p>
            <p className="text-muted-foreground max-w-[46ch] text-sm">
              {kind === 'no-stores'
                ? t('emptyNoStores')
                : t('emptyNoConnections')}
            </p>
            {canEditSettings ? (
              kind === 'no-stores' ? (
                <Button render={<Link href="/settings?tab=stores" />}>
                  {t('createStoreFirst')}
                </Button>
              ) : (
                <Button onClick={openCreate}>{t('connect')}</Button>
              )
            ) : null}
          </Card>
        )}
        {!canEditSettings ? (
          <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
        ) : null}
      </section>

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {pending?.kind === 'delete'
                ? t('deleteTitle')
                : t('disableTitle')}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === 'delete'
                ? t('deleteConfirm', {
                    name: pending.connection.display_name ?? '',
                  })
                : t('disableConfirm', {
                    name: pending?.connection.display_name ?? '',
                  })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPending(null)}
              disabled={!!busyId}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={!!busyId}
              onClick={() =>
                pending?.kind === 'delete'
                  ? void runDelete(pending.connection)
                  : pending
                    ? void runAction(pending.connection, 'disable')
                    : undefined
              }
            >
              {busyId && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {pending?.kind === 'delete' ? t('delete') : t('disable')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import {
  Loader2,
  MessageCircle,
  Plug,
  PlugZap,
  Send,
  Store,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useCan } from '@/hooks/use-can';
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
  emptyStateKind,
  groupConnectionsByStore,
  type ChannelConnectionRow,
  type StoreRef,
} from '@/lib/channels/ui';
import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';
import { connectionChipState, type ConnectionChipState } from '@/lib/stores/ui';
import { SettingsPanelHead } from './settings-panel-head';
import { WhatsAppConfig } from './whatsapp-config';

const CHIP_TONE: Record<ConnectionChipState, string> = {
  connected: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  degraded: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  disconnected: 'bg-muted text-muted-foreground',
  needs_action: 'bg-red-500/10 text-red-600 dark:text-red-400',
  disabled: 'bg-muted text-muted-foreground line-through',
};

const CHANNEL_TYPES = ['whatsapp_cloud', 'telegram'] as const;
const LEGACY_FORM_ID = 'whatsapp-config';

type Pending = {
  kind: 'disable' | 'delete';
  connection: ChannelConnectionRow;
} | null;

/**
 * Channels section: connections grouped by store, with state and actions.
 * The existing WhatsApp configuration stays below until the connection wizard
 * replaces it. Write actions require `edit-settings`.
 */
export function ChannelsPanel() {
  const t = useTranslations('Settings.channels');
  const tProvider = useTranslations('Channels.providers.whatsapp_cloud');
  const locale = useLocale();
  const canEditSettings = useCan('edit-settings');

  const [stores, setStores] = useState<StoreRef[]>([]);
  const [connections, setConnections] = useState<ChannelConnectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Pending>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
    (CHANNEL_TYPES as readonly string[]).includes(type)
      ? t(`type.${type as (typeof CHANNEL_TYPES)[number]}`)
      : type;

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

  const scrollToLegacyForm = () =>
    document
      .getElementById(LEGACY_FORM_ID)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const kind = emptyStateKind(stores.length, connections.length);
  const groups = groupConnectionsByStore(stores, connections);

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

        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : kind === 'has-connections' ? (
          <div className="space-y-5">
            {groups.map((g) => (
              <div key={g.store.id} className="space-y-2">
                <h3 className="text-foreground flex items-center gap-1.5 text-sm font-semibold">
                  <Store className="text-muted-foreground size-4" />
                  {g.store.name}
                </h3>
                <ul className="flex flex-col gap-2">
                  {g.connections.map((c) => {
                    const state = connectionChipState(c);
                    const Icon =
                      c.channel_type === 'telegram' ? Send : MessageCircle;
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
                            <span title={t('configureSoon')}>
                              <Button variant="outline" size="sm" disabled>
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
                <Button onClick={scrollToLegacyForm}>{t('connect')}</Button>
              )
            ) : null}
          </Card>
        )}
        {!canEditSettings ? (
          <p className="text-muted-foreground text-xs">{t('readOnly')}</p>
        ) : null}
      </section>
      <div id={LEGACY_FORM_ID}>
        <WhatsAppConfig />
      </div>

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

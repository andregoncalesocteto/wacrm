'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight, Loader2, PlugZap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Capabilities, ChannelType } from '@/lib/channels/types';
import type { ChannelConnectionRow, StoreRef } from '@/lib/channels/ui';
import type { BroadcastConnectionContext } from '@/lib/contacts/broadcast-eligibility';

interface ProviderInfo {
  type: string;
  capabilities: Capabilities;
}

interface EligibleRow {
  connection: ChannelConnectionRow;
  label: string;
  initiate: Capabilities['initiate'];
}

interface Step0Props {
  selected: BroadcastConnectionContext | null;
  onSelect: (connection: BroadcastConnectionContext) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * Wizard step 0: choose which connection the broadcast sends from. Only
 * connections that are actually reachable right now (`status === 'connected'`
 * and not disabled) are offered — same bar as the settings channel list.
 * The chosen connection's `capabilities.initiate` decides step 1 (template
 * vs. free-message compose, US-011) and is threaded through unchanged to
 * eligibility (US-006) and send (US-009).
 */
export function Step0ChooseConnection({
  selected,
  onSelect,
  onNext,
  onBack,
}: Step0Props) {
  const t = useTranslations('Broadcasts.wizard');
  const tChannel = useTranslations('Settings.channels');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [eligible, setEligible] = useState<EligibleRow[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [sRes, cRes, pRes] = await Promise.all([
          fetch('/api/stores', { cache: 'no-store' }),
          fetch('/api/channels/connections', { cache: 'no-store' }),
          fetch('/api/channels/providers', { cache: 'no-store' }),
        ]);
        if (!sRes.ok || !cRes.ok || !pRes.ok) throw new Error('load');
        const sData = await sRes.json();
        const cData = await cRes.json();
        const pData = await pRes.json();
        if (!alive) return;

        const stores = (sData.stores ?? []) as StoreRef[];
        const connections = (cData.connections ?? []) as ChannelConnectionRow[];
        const providers = (pData.providers ?? []) as ProviderInfo[];

        const storeName = (id: string) =>
          stores.find((s) => s.id === id)?.name ?? '';
        const channelLabel = (type: string) =>
          tChannel.has(`type.${type}`) ? tChannel(`type.${type}`) : type;
        const initiateFor = (type: string): Capabilities['initiate'] =>
          providers.find((p) => p.type === type)?.capabilities.initiate ??
          'template';

        const rows: EligibleRow[] = connections
          .filter((c) => c.status === 'connected' && !c.disabled_at)
          .map((c) => ({
            connection: c,
            label: `${channelLabel(c.channel_type)} — ${storeName(c.store_id)}`,
            initiate: initiateFor(c.channel_type),
          }));
        setEligible(rows);
      } catch {
        if (alive) setError(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [tChannel]);

  // Exactly one eligible connection: pre-select it, but the step stays
  // visible (the AC is explicit: no hiding it just because there's one
  // choice).
  useEffect(() => {
    if (selected || eligible.length !== 1) return;
    const only = eligible[0];
    onSelect({
      connectionId: only.connection.id,
      channelType: only.connection.channel_type as ChannelType,
      initiate: only.initiate,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible]);

  function handleChange(connectionId: string | null) {
    // @base-ui Select fires onValueChange(null) on deselect.
    if (!connectionId) return;
    const row = eligible.find((r) => r.connection.id === connectionId);
    if (!row) return;
    onSelect({
      connectionId: row.connection.id,
      channelType: row.connection.channel_type as ChannelType,
      initiate: row.initiate,
    });
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{t('chooseConnection.errorLoad')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">
          {t('chooseConnection.title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('chooseConnection.subtitle')}
        </p>
      </div>

      {eligible.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card/50 px-6 text-center">
          <PlugZap className="mb-1 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {t('chooseConnection.emptyTitle')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('chooseConnection.emptyBody')}
          </p>
          <Link
            href="/settings?tab=channels"
            className="mt-2 text-sm font-medium text-primary hover:underline"
          >
            {t('chooseConnection.emptyCta')}
          </Link>
        </div>
      ) : (
        <div className="space-y-2 rounded-xl border border-border bg-card/50 p-4">
          <label className="text-sm font-medium text-foreground">
            {t('chooseConnection.label')}
          </label>
          <Select
            value={selected?.connectionId ?? null}
            onValueChange={handleChange}
          >
            <SelectTrigger className="w-full bg-muted border-border text-foreground">
              {/* Connection ids aren't human-readable — resolve the label
                  from `eligible` explicitly (@base-ui only auto-resolves a
                  label when the value string equals its displayed text). */}
              <SelectValue placeholder={t('chooseConnection.placeholder')}>
                {(value: string | null) =>
                  eligible.find((r) => r.connection.id === value)?.label ??
                  value
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="bg-popover border-border">
              {eligible.map((row) => (
                <SelectItem
                  key={row.connection.id}
                  value={row.connection.id}
                  className="text-popover-foreground focus:bg-muted focus:text-popover-foreground"
                >
                  {row.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selected || eligible.length === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

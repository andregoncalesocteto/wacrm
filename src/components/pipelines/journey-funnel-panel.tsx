'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  FUNNEL_STAGES,
  type FunnelCounts,
  type FunnelGroup,
  type JourneyFunnel,
} from '@/lib/journeys/funnel';

/**
 * Conversion funnel of the order Journeys: for each step, how many Journeys
 * reached it (in it or beyond) and the link -> purchase rate, overall and by
 * channel and by store. Read via the session-protected internal route.
 */
export function JourneyFunnelPanel() {
  const t = useTranslations('Pipelines.journey.funnel');
  const tStages = useTranslations('Pipelines.journey.stages');
  const tType = useTranslations('Settings.channels.type');
  const format = useFormatter();
  const [data, setData] = useState<JourneyFunnel | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/journeys/funnel')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<JourneyFunnel>;
      })
      .then((json) => alive && setData(json))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const percent = (rate: number | null) =>
    rate === null ? t('noData') : format.number(rate, 'percent');
  const channelLabel = (type: string) => (tType.has(type) ? tType(type) : type);

  const renderTable = (title: string, groups: FunnelGroup[]) => (
    <div className="space-y-2">
      <h4 className="text-foreground text-sm font-semibold">{title}</h4>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('group')}</TableHead>
              {FUNNEL_STAGES.map((s) => (
                <TableHead key={s} className="text-right">
                  {tStages(s)}
                </TableHead>
              ))}
              <TableHead className="text-right">{tStages('lost')}</TableHead>
              <TableHead className="text-right">{t('conversion')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <FunnelRow
                key={g.key}
                label={g.label}
                counts={g}
                percent={percent}
                number={(n) => format.number(n, 'integer')}
              />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );

  return (
    <section
      className="border-border bg-card space-y-4 rounded-xl border p-4"
      data-testid="journey-funnel"
    >
      <div>
        <h3 className="text-foreground text-base font-semibold">
          {t('title')}
        </h3>
        <p className="text-muted-foreground text-xs">{t('description')}</p>
      </div>
      {failed ? (
        <p className="text-muted-foreground text-sm">{t('error')}</p>
      ) : !data ? (
        <div className="bg-muted h-24 animate-pulse rounded" />
      ) : data.total.reached.link_sent === 0 ? (
        <p className="text-muted-foreground text-sm">{t('empty')}</p>
      ) : (
        <div className="space-y-5">
          {renderTable(t('overall'), [
            { key: 'all', label: t('allJourneys'), ...data.total },
          ])}
          {renderTable(
            t('byChannel'),
            data.byChannel.map((g) => ({ ...g, label: channelLabel(g.label) }))
          )}
          {renderTable(t('byStore'), data.byStore)}
        </div>
      )}
    </section>
  );
}

function FunnelRow({
  label,
  counts,
  percent,
  number,
}: {
  label: string;
  counts: FunnelCounts;
  percent: (rate: number | null) => string;
  number: (n: number) => string;
}) {
  return (
    <TableRow>
      <TableCell className="font-medium">{label}</TableCell>
      {FUNNEL_STAGES.map((s) => (
        <TableCell key={s} className="text-right tabular-nums">
          {number(counts.reached[s])}
        </TableCell>
      ))}
      <TableCell className="text-right tabular-nums">
        {number(counts.lost)}
      </TableCell>
      <TableCell className="text-right font-semibold tabular-nums">
        {percent(counts.conversion)}
      </TableCell>
    </TableRow>
  );
}

'use client';

import { useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useActiveChannelTypes } from '@/hooks/use-active-channel-types';
import { useChannelProviders } from '@/hooks/use-channel-providers';
import {
  channelWarnings,
  type StepRequirement,
} from '@/lib/channels/step-capabilities';

/**
 * Informational (never blocking): which steps only work on connections with a
 * capability that some ACTIVE connection lacks. Renders nothing when there is
 * nothing to warn about (e.g. a WhatsApp-only account).
 */
export function StepWarnings({
  requirements,
}: {
  requirements: StepRequirement[];
}) {
  const t = useTranslations('Channels.stepWarnings');
  const tName = useTranslations();
  const providers = useChannelProviders();
  const activeTypes = useActiveChannelTypes();

  const warnings = useMemo(
    () => channelWarnings(requirements, providers, activeTypes ?? []),
    [requirements, providers, activeTypes]
  );
  if (warnings.length === 0) return null;

  return (
    <div
      role="status"
      data-testid="step-warnings"
      className="bg-background rounded-lg border border-amber-500/40 p-3 text-sm"
    >
      <div className="mb-1 flex items-center gap-2 text-xs font-medium text-amber-400">
        <TriangleAlert className="h-4 w-4" />
        {t('title')}
      </div>
      <ul className="text-muted-foreground flex flex-col gap-1">
        {warnings.map((w) => {
          const channels = w.channelTypes
            .map((type) => tName(`Channels.providers.${type}.name`))
            .join(', ');
          const r = w.requirement;
          return (
            <li
              key={
                r.capability === 'media' ? `media:${r.mediaKind}` : r.capability
              }
            >
              {r.capability === 'media'
                ? t('media', { kind: r.mediaKind, channels })
                : t(r.capability, { channels })}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import type { ContactIdentity } from '@/lib/channels/types';
import {
  contactDisplayName,
  contactSecondaryLine,
} from '@/lib/contacts/display-name';

type C = Parameters<typeof contactDisplayName>[0];

/**
 * Display helpers bound to the channel-name translations, for CRM screens
 * outside the inbox (contacts, pipelines, broadcasts).
 */
export function useContactDisplay() {
  const tChannel = useTranslations('Settings.channels.type');

  const name = useCallback(
    (contact: C | null | undefined, identities?: ContactIdentity[]) =>
      contact
        ? contactDisplayName(
            contact,
            identities ??
              (contact as { identities?: ContactIdentity[] }).identities
          )
        : '',
    []
  );

  const secondary = useCallback(
    (contact: C | null | undefined, identities?: ContactIdentity[]) =>
      contact
        ? contactSecondaryLine(
            contact,
            identities ??
              (contact as { identities?: ContactIdentity[] }).identities,
            (type) => (tChannel.has(type) ? tChannel(type) : undefined)
          )
        : '',
    [tChannel]
  );

  return { name, secondary };
}

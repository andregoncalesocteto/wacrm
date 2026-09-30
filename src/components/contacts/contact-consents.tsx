'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { CONSENT_PURPOSES, type ConsentPurpose } from '@/lib/consent/consent';

interface ConsentRow {
  purpose: ConsentPurpose;
  granted: boolean;
  given_at: string | null;
  revoked_at: string | null;
  source: string;
}

interface ContactConsentsProps {
  contactId: string;
}

const KNOWN_SOURCES = ['menu', 'chat'];

/**
 * Read-only consent per purpose of a contact (proof kept by the CRM): state,
 * date and source. Sits in the contact panel; edited only by events / "PARAR".
 */
export function ContactConsents({ contactId }: ContactConsentsProps) {
  const t = useTranslations('Contacts.consents');
  const format = useFormatter();
  const [rows, setRows] = useState<ConsentRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    createClient()
      .from('contact_consents')
      .select('purpose, granted, given_at, revoked_at, source')
      .eq('contact_id', contactId)
      .then(({ data }) => {
        if (!cancelled) setRows((data ?? []) as ConsentRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const describe = (row: ConsentRow | undefined) => {
    if (!row) return t('notRecorded');
    const when = row.granted ? row.given_at : row.revoked_at;
    if (!when) return t('notRecorded');
    return t(row.granted ? 'active' : 'revoked', {
      date: format.dateTime(new Date(when), 'dateTime'),
      source: KNOWN_SOURCES.includes(row.source)
        ? t(`source.${row.source as 'menu' | 'chat'}`)
        : row.source,
    });
  };

  return (
    <div data-testid="contact-consents">
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
        <ShieldCheck className="h-3 w-3" />
        {t('title')}
      </div>
      <ul className="mt-2 space-y-2">
        {CONSENT_PURPOSES.map((purpose) => {
          const row = rows.find((r) => r.purpose === purpose);
          return (
            <li
              key={purpose}
              className="bg-muted/40 border-border rounded-md border px-2.5 py-2 text-xs"
            >
              <div className="text-foreground font-medium">
                {t(`purpose.${purpose}`)}
              </div>
              <div className="text-muted-foreground mt-0.5">
                {describe(row)}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

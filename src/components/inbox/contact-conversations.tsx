'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { MessageSquare } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { getDateFnsLocale } from '@/lib/i18n/date-fns-locale';
import {
  CONVERSATION_SELECT,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { contactConversationsSummary } from '@/lib/inbox/contact-conversations';
import { cn } from '@/lib/utils';
import type { Conversation } from '@/types';

interface ContactConversationsProps {
  contactId: string;
  /** Highlighted row (the conversation open in the inbox), if any. */
  currentConversationId?: string | null;
  /** Draws a separator after the section (only when it renders). */
  dividerAfter?: boolean;
  /**
   * Inbox only: select the conversation in place. Return true when handled
   * (the link's navigation is then skipped); the plain link is the fallback.
   */
  onOpen?: (conversationId: string) => boolean;
}

/**
 * "Conversas" section of a contact profile: every conversation of the contact
 * across connections/stores, each linking to the inbox. Renders nothing when
 * the contact has a single conversation.
 */
export function ContactConversations({
  contactId,
  currentConversationId,
  dividerAfter,
  onOpen,
}: ContactConversationsProps) {
  const t = useTranslations('Inbox.contactConversations');
  const tType = useTranslations('Settings.channels.type');
  const locale = useLocale();
  const [rows, setRows] = useState<Conversation[]>([]);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('contact_id', contactId)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .then(({ data }) => {
        if (cancelled) return;
        setRows(data ? normalizeConversations(data as unknown as never[]) : []);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const summary = useMemo(
    () => contactConversationsSummary(rows, currentConversationId),
    [rows, currentConversationId]
  );

  if (!summary.visible) return null;

  return (
    <>
      <div data-testid="contact-conversations">
        <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
          <MessageSquare className="h-3 w-3" />
          {t('title')}
        </div>
        <ul className="mt-2 space-y-2">
          {summary.items.map((item) => {
            const channel =
              item.channelType && tType.has(item.channelType)
                ? tType(item.channelType)
                : item.channelType;
            const scope = [item.storeName, channel].filter(Boolean).join(' · ');
            return (
              <li key={item.id}>
                <Link
                  href={`/inbox?c=${item.id}`}
                  onClick={(e) => {
                    if (onOpen?.(item.id)) e.preventDefault();
                  }}
                  data-current={item.isCurrent ? 'true' : undefined}
                  className={cn(
                    'bg-muted hover:bg-muted/70 block rounded-lg px-3 py-2 text-xs',
                    item.isCurrent && 'border-primary border-l-2'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground truncate font-medium">
                      {scope || t('noStore')}
                    </span>
                    {item.unreadCount > 0 && (
                      <span className="bg-primary text-primary-foreground shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                        {t('unread', { count: item.unreadCount })}
                      </span>
                    )}
                  </div>
                  {item.connectionName && (
                    <p className="text-muted-foreground truncate">
                      {item.connectionName}
                    </p>
                  )}
                  <p className="text-muted-foreground mt-0.5 truncate">
                    {item.lastMessageText || t('noMessages')}
                  </p>
                  <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                    {item.lastMessageAt && (
                      <span>
                        {formatDistanceToNow(new Date(item.lastMessageAt), {
                          addSuffix: true,
                          locale: getDateFnsLocale(locale),
                        })}
                      </span>
                    )}
                    <span className="bg-background rounded px-1.5 py-0.5">
                      {t(`status.${item.status}`)}
                    </span>
                    {item.disabled && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600">
                        {t('disabled')}
                      </span>
                    )}
                    {item.isCurrent && (
                      <span className="text-primary font-medium">
                        {t('current')}
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      {dividerAfter && <div className="border-border my-4 border-t" />}
    </>
  );
}

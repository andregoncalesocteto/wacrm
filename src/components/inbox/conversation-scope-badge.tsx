'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import type { ConversationConnection } from '@/types';

interface ConversationScopeBadgeProps {
  connection: ConversationConnection | null | undefined;
  className?: string;
}

/**
 * "Store · channel" label for a conversation, plus a "disabled" marker when
 * its connection is off. Renders nothing without an embedded connection.
 * The caller decides whether to show it at all (see `shouldShowScopeUi`).
 */
export function ConversationScopeBadge({
  connection,
  className,
}: ConversationScopeBadgeProps) {
  const tType = useTranslations('Settings.channels.type');
  const t = useTranslations('Inbox.conversationList');
  if (!connection) return null;

  const channel = tType.has(connection.channel_type)
    ? tType(connection.channel_type)
    : connection.channel_type;
  const label = connection.store?.name
    ? `${connection.store.name} · ${channel}`
    : channel;
  const disabled = Boolean(connection.disabled_at);

  return (
    <span
      className={cn(
        'text-muted-foreground inline-flex max-w-full items-center gap-1 text-[10px]',
        className
      )}
      data-testid="conversation-scope-badge"
    >
      <span className="bg-muted truncate rounded px-1.5 py-0.5">{label}</span>
      {disabled && (
        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600">
          {t('disabled')}
        </span>
      )}
    </span>
  );
}

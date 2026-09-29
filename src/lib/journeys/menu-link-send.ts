import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMenuUrl } from './menu-link';
import { openOrRenewJourney, type JourneyRow } from './journeys';
import { issueTrackingToken } from './tokens';

/** The menu link cannot be produced; the message must NOT be sent. */
export class MenuLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MenuLinkError';
  }
}

export interface MenuLinkArgs {
  accountId: string;
  /** Audit `user_id` for rows created on the way (the automation author). */
  userId: string;
  conversationId: string;
  contactId: string;
}

export interface ResolvedMenuLink {
  /** Store menu address with `idtrack=<token>`; goes into the message text. */
  url: string;
  connectionId: string;
  storeId: string;
}

/**
 * Phase 1, BEFORE sending: conversation -> connection -> store -> menu_url,
 * then create/renew the Tracking token and build the link. Throws
 * `MenuLinkError` (nothing created except, at worst, a token) when the chain is
 * broken or the store has no menu address.
 */
export async function resolveMenuLink(
  db: SupabaseClient,
  args: MenuLinkArgs
): Promise<ResolvedMenuLink> {
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('id, contact_id, connection_id')
    .eq('account_id', args.accountId)
    .eq('id', args.conversationId)
    .maybeSingle();
  if (convErr)
    throw new MenuLinkError(
      `menu_link: conversation lookup failed: ${convErr.message}`
    );
  const conversation = conv as {
    contact_id: string;
    connection_id: string | null;
  } | null;
  if (!conversation)
    throw new MenuLinkError('menu_link: conversation not found');
  if (conversation.contact_id !== args.contactId) {
    throw new MenuLinkError(
      'menu_link: conversation does not belong to the contact'
    );
  }
  if (!conversation.connection_id) {
    throw new MenuLinkError(
      'menu_link: conversation has no connection, so no store'
    );
  }

  const { data: conn, error: connErr } = await db
    .from('channel_connections')
    .select('id, store_id')
    .eq('account_id', args.accountId)
    .eq('id', conversation.connection_id)
    .maybeSingle();
  if (connErr)
    throw new MenuLinkError(
      `menu_link: connection lookup failed: ${connErr.message}`
    );
  const connection = conn as { id: string; store_id: string } | null;
  if (!connection) throw new MenuLinkError('menu_link: connection not found');

  const { data: st, error: storeErr } = await db
    .from('stores')
    .select('id, name, menu_url')
    .eq('account_id', args.accountId)
    .eq('id', connection.store_id)
    .maybeSingle();
  if (storeErr)
    throw new MenuLinkError(
      `menu_link: store lookup failed: ${storeErr.message}`
    );
  const store = st as {
    id: string;
    name: string;
    menu_url: string | null;
  } | null;
  if (!store) throw new MenuLinkError('menu_link: store not found');
  if (!store.menu_url?.trim()) {
    throw new MenuLinkError(
      `menu_link: store "${store.name}" has no menu URL configured; nothing was sent`
    );
  }

  const { token } = await issueTrackingToken(db, {
    accountId: args.accountId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    connectionId: connection.id,
  });
  return {
    url: buildMenuUrl(store.menu_url.trim(), token),
    connectionId: connection.id,
    storeId: store.id,
  };
}

/**
 * Phase 2, AFTER the message carrying the link was sent: open (or reuse) the
 * Journey, put its deal at "Link enviado" and stamp `link_sent_at`.
 */
export function recordMenuLinkSent(
  db: SupabaseClient,
  args: MenuLinkArgs & { connectionId: string; sentAt?: Date }
): Promise<JourneyRow> {
  return openOrRenewJourney(db, {
    accountId: args.accountId,
    userId: args.userId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    connectionId: args.connectionId,
    linkSentAt: args.sentAt,
  });
}

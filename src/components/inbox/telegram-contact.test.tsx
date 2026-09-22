import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import en from '../../../messages/en.json';
import type { Contact, Conversation } from '@/types';

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'a1' }) }));
vi.mock('./contact-conversations', () => ({
  ContactConversations: () => null,
}));

import { ConversationItem } from './conversation-list';
import { ContactSidebar } from './contact-sidebar';

const base = {
  id: 'p1',
  user_id: 'u',
  account_id: 'a',
  created_at: '',
  updated_at: '',
};
const telegram: Contact = {
  ...base,
  phone: '',
  name: '',
  identities: [
    { kind: 'telegram:chat_id', externalId: '4242' },
    { kind: 'telegram:username', externalId: 'maria', handle: '@Maria' },
  ],
};
const noIdentity: Contact = { ...base, phone: '', name: '' };

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en as never}>
      {node}
    </NextIntlClientProvider>
  );
}

function item(contact: Contact) {
  const conversation = {
    id: 'c1',
    contact_id: contact.id,
    status: 'open',
    unread_count: 0,
    last_message_text: 'hi',
    last_message_at: null,
    contact,
  } as unknown as Conversation;
  return wrap(
    <ConversationItem
      conversation={conversation}
      isActive={false}
      onSelect={() => {}}
      showScopeUi={false}
      t={((k: string) => (k === 'unknown' ? 'Unknown' : k)) as never}
    />
  );
}

describe('inbox with a Telegram contact (no phone)', () => {
  it('list row shows the @username, not a blank', () => {
    const html = item(telegram);
    expect(html).toContain('@Maria');
    expect(html).toContain('>M<');
  });

  it('list row of a contact with nothing falls back to Unknown', () => {
    const html = item(noIdentity);
    expect(html).toContain('Unknown');
    expect(html).toContain('>U<');
  });

  it('side panel shows name, and the handle with its channel', () => {
    const html = wrap(<ContactSidebar contact={telegram} />);
    expect(html).toContain('<h3');
    expect(html).toContain('@Maria');
    expect(html).toContain('@Maria · Telegram');
  });

  it('side panel omits the phone row when there is nothing to show', () => {
    const html = wrap(<ContactSidebar contact={noIdentity} />);
    expect(html).toContain('Unknown');
    expect(html).not.toContain(' · ');
  });

  it('WhatsApp contact with a phone is unchanged', () => {
    const wa: Contact = { ...base, phone: '+5511999', name: 'Ana' };
    const html = wrap(<ContactSidebar contact={wa} />);
    expect(html).toContain('Ana');
    expect(html).toContain('+5511999');
    expect(html).not.toContain('·');
  });
});

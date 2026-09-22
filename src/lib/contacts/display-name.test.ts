import { describe, expect, it } from 'vitest';
import {
  contactDisplayName,
  contactInitial,
  contactSubtitle,
  matchesContactSearch,
  primaryIdentity,
} from './display-name';
import { normalizeConversation } from '@/lib/inbox/conversations';
import type { ContactIdentity } from '@/lib/channels/types';

const tgChat: ContactIdentity = {
  kind: 'telegram:chat_id',
  externalId: '4242',
};
const tgUser: ContactIdentity = {
  kind: 'telegram:username',
  externalId: 'maria',
  handle: '@Maria',
};

describe('contactDisplayName', () => {
  it('prefers the name', () => {
    expect(contactDisplayName({ name: ' Ana ', phone: '+1' }, [tgUser])).toBe(
      'Ana'
    );
  });
  it('then @username, phone, BSUID, telegram handle / chat id', () => {
    const wa: ContactIdentity[] = [
      { kind: 'whatsapp:bsuid', externalId: 'BR.123456' },
      { kind: 'whatsapp:phone', externalId: '+5511999' },
      { kind: 'whatsapp:username', externalId: 'zed' },
    ];
    expect(contactDisplayName({ name: '' }, wa)).toBe('@zed');
    expect(contactDisplayName({ name: '' }, wa.slice(0, 2))).toBe('+5511999');
    expect(contactDisplayName({ name: '' }, wa.slice(0, 1))).toBe('BR.123456');
    expect(contactDisplayName({ name: '' }, [tgChat, tgUser])).toBe('@Maria');
    expect(contactDisplayName({ name: '' }, [tgChat])).toBe('4242');
  });
  it('is empty only with no identity at all', () => {
    expect(contactDisplayName({ name: '', phone: '' })).toBe('');
  });
});

describe('subtitle / primary identity / initial', () => {
  it('keeps the phone as the subtitle for WhatsApp contacts', () => {
    expect(contactSubtitle({ phone: '+5511999' }, [])).toBe('+5511999');
  });
  it('uses the primary identity without a phone', () => {
    expect(contactSubtitle({ phone: '' }, [tgChat, tgUser])).toBe('@Maria');
    expect(primaryIdentity({ phone: '' }, [tgChat, tgUser])).toEqual({
      label: '@Maria',
      channelType: 'telegram',
    });
    expect(contactSubtitle({ phone: '' }, [])).toBe('');
  });
  it('never yields an empty initial', () => {
    expect(contactInitial('@maria')).toBe('M');
    expect(contactInitial('')).toBe('?');
  });
});

describe('matchesContactSearch', () => {
  const tg = { name: '', phone: '', identities: [tgChat, tgUser] };
  it('matches name, phone, identity handle and id', () => {
    expect(matchesContactSearch({ name: 'Ana', phone: '+55' }, 'ana')).toBe(
      true
    );
    expect(matchesContactSearch({ name: 'Ana', phone: '+55' }, '+55')).toBe(
      true
    );
    expect(matchesContactSearch(tg, '@maria')).toBe(true);
    expect(matchesContactSearch(tg, 'maria')).toBe(true);
    expect(matchesContactSearch(tg, '4242')).toBe(true);
    expect(matchesContactSearch(tg, 'joao')).toBe(false);
  });
  it('empty query matches; missing contact does not match text', () => {
    expect(matchesContactSearch(tg, '  ')).toBe(true);
    expect(matchesContactSearch(null, 'x')).toBe(false);
  });
});

describe('normalizeConversation with identities', () => {
  const base = { id: 'c1', contact_id: 'p1' } as never;
  it('maps the embed and keeps tags flattening', () => {
    const out = normalizeConversation({
      ...(base as object),
      contact: {
        id: 'p1',
        phone: '',
        contact_tags: [{ tags: { id: 't1' } }, { tags: null }],
        contact_identities: [
          { kind: 'telegram:chat_id', external_id: '4242', handle: null },
        ],
      },
    } as never);
    expect(out.contact?.identities).toEqual([
      { kind: 'telegram:chat_id', externalId: '4242', handle: null },
    ]);
    expect(out.contact?.tags?.map((t) => t.id)).toEqual(['t1']);
  });
  it('tolerates a missing embed', () => {
    const out = normalizeConversation({
      ...(base as object),
      contact: { id: 'p1', phone: '+1', contact_tags: [] },
    } as never);
    expect(out.contact?.identities).toBeUndefined();
  });
});

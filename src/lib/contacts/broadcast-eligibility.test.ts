import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isBroadcastEligible,
  partitionBroadcastAudience,
  fetchIneligibleContacts,
  type BroadcastConnectionContext,
} from './broadcast-eligibility';

const waConnection: BroadcastConnectionContext = {
  connectionId: 'conn-wa',
  channelType: 'whatsapp_cloud',
  initiate: 'template',
};

const wa = { id: '1', name: 'Ana', phone: '+5511999990000' };
const tg = {
  id: '2',
  name: '',
  phone: '',
  contact_identities: [
    { kind: 'telegram:chat_id', external_id: '42', handle: '@maria' },
  ],
};
const bsuid = {
  id: '3',
  phone: '',
  contact_identities: [
    { kind: 'whatsapp:bsuid', external_id: 'US.ABC12345', handle: null },
  ],
};
const nothing = { id: '5', phone: '  ', contact_identities: [] };

describe('isBroadcastEligible - template channel (capabilities.initiate === "template")', () => {
  it('is eligible with a phone', () => {
    expect(isBroadcastEligible(wa, waConnection)).toBe(true);
  });
  it('is eligible with a WhatsApp BSUID identity', () => {
    expect(isBroadcastEligible(bsuid, waConnection)).toBe(true);
  });
  it('is eligible with a whatsapp:phone identity and no phone column', () => {
    expect(
      isBroadcastEligible(
        {
          id: '6',
          phone: '',
          contact_identities: [
            { kind: 'whatsapp:phone', external_id: '5511', handle: null },
          ],
        },
        waConnection
      )
    ).toBe(true);
  });
  it('is not eligible when Telegram-only or without any identity', () => {
    expect(isBroadcastEligible(tg, waConnection)).toBe(false);
    expect(isBroadcastEligible(nothing, waConnection)).toBe(false);
  });
});

describe('partitionBroadcastAudience - template channel', () => {
  it('splits eligible from ineligible preserving order', () => {
    const { eligible, ineligible } = partitionBroadcastAudience(
      [wa, tg, bsuid, nothing],
      waConnection
    );
    expect(eligible.map((c) => c.id)).toEqual(['1', '3']);
    expect(ineligible.map((c) => c.id)).toEqual(['2', '5']);
  });
});

const botA: BroadcastConnectionContext = {
  connectionId: 'bot-a-conn',
  channelType: 'telegram',
  initiate: 'after_inbound',
};
const botB: BroadcastConnectionContext = {
  connectionId: 'bot-b-conn',
  channelType: 'telegram',
  initiate: 'after_inbound',
};

describe('isBroadcastEligible - non-template channel (capabilities.initiate !== "template")', () => {
  it('is eligible only when a conversation exists with THIS connection', () => {
    expect(
      isBroadcastEligible({ id: '1', hasConversationWithConnection: true }, botA)
    ).toBe(true);
    expect(
      isBroadcastEligible({ id: '2', hasConversationWithConnection: false }, botA)
    ).toBe(false);
    expect(isBroadcastEligible({ id: '3' }, botA)).toBe(false);
  });

  it('a WhatsApp phone or a general channel identity is not enough on its own', () => {
    expect(
      isBroadcastEligible(
        {
          id: '4',
          phone: '+5511999990000',
          contact_identities: [
            { kind: 'telegram:chat_id', external_id: '99', handle: '@x' },
          ],
          hasConversationWithConnection: false,
        },
        botA
      )
    ).toBe(false);
  });
});

/**
 * Chainable Supabase stub. `.then()` resolves per-table, filtering
 * `conversations` by whatever `.eq('connection_id', …)` was actually called
 * with — so the test exercises the SAME connection-id filter the real query
 * sends, not just canned per-table data.
 */
function fakeDb(rows: {
  contacts: {
    id: string;
    name?: string | null;
    phone?: string | null;
    contact_identities?: { kind: string; external_id: string; handle?: string | null }[];
  }[];
  conversations: { contact_id: string; connection_id: string }[];
}): SupabaseClient {
  return {
    from(table: string) {
      let connectionIdFilter: string | null = null;
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, val: string) => {
          if (col === 'connection_id') connectionIdFilter = val;
          return builder;
        },
        in: () => builder,
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'contacts') {
            return Promise.resolve({ data: rows.contacts, error: null }).then(
              resolve
            );
          }
          if (table === 'conversations') {
            const data = connectionIdFilter
              ? rows.conversations.filter(
                  (r) => r.connection_id === connectionIdFilter
                )
              : rows.conversations;
            return Promise.resolve({ data, error: null }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

describe('fetchIneligibleContacts - non-template channel, per-connection conversations', () => {
  const contacts = [
    { id: 'c1', name: 'Only Bot A', phone: '' },
    { id: 'c2', name: 'Only Bot B', phone: '' },
  ];
  const conversations = [
    { contact_id: 'c1', connection_id: 'bot-a-conn' },
    { contact_id: 'c2', connection_id: 'bot-b-conn' },
  ];

  it('a contact who only talked to Bot A is not eligible for Bot B', async () => {
    const db = fakeDb({ contacts, conversations });
    const ineligible = await fetchIneligibleContacts(db, botB);
    expect(ineligible.map((c) => c.id)).toContain('c1');
    expect(ineligible.map((c) => c.id)).not.toContain('c2');
  });

  it('the same contact IS eligible for Bot A', async () => {
    const db = fakeDb({ contacts, conversations });
    const ineligible = await fetchIneligibleContacts(db, botA);
    expect(ineligible.map((c) => c.id)).not.toContain('c1');
    expect(ineligible.map((c) => c.id)).toContain('c2');
  });
});

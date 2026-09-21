import { describe, it, expect } from 'vitest';
import {
  isBroadcastEligible,
  partitionBroadcastAudience,
} from './broadcast-eligibility';

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
const legacyBsuid = { id: '4', phone: '', wa_user_id: 'US.ZZZ99999' };
const nothing = { id: '5', phone: '  ', contact_identities: [] };

describe('isBroadcastEligible', () => {
  it('is eligible with a phone', () => {
    expect(isBroadcastEligible(wa)).toBe(true);
  });
  it('is eligible with a WhatsApp BSUID identity or legacy wa_user_id', () => {
    expect(isBroadcastEligible(bsuid)).toBe(true);
    expect(isBroadcastEligible(legacyBsuid)).toBe(true);
  });
  it('is eligible with a whatsapp:phone identity and no phone column', () => {
    expect(
      isBroadcastEligible({
        id: '6',
        phone: '',
        contact_identities: [
          { kind: 'whatsapp:phone', external_id: '5511', handle: null },
        ],
      })
    ).toBe(true);
  });
  it('is not eligible when Telegram-only or without any identity', () => {
    expect(isBroadcastEligible(tg)).toBe(false);
    expect(isBroadcastEligible(nothing)).toBe(false);
  });
});

describe('partitionBroadcastAudience', () => {
  it('splits eligible from ineligible preserving order', () => {
    const { eligible, ineligible } = partitionBroadcastAudience([
      wa,
      tg,
      bsuid,
      nothing,
    ]);
    expect(eligible.map((c) => c.id)).toEqual(['1', '3']);
    expect(ineligible.map((c) => c.id)).toEqual(['2', '5']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  contactSecondaryLine,
  identitiesFromRows,
  matchesContactSearch,
  withIdentities,
  firstOf,
} from './display-name';

const channelName = (t: string) => (t === 'telegram' ? 'Telegram' : undefined);
const tg = identitiesFromRows([
  { kind: 'telegram:chat_id', external_id: '42', handle: null },
  { kind: 'telegram:username', external_id: 'maria', handle: '@maria' },
]);

describe('contactSecondaryLine', () => {
  it('shows the phone exactly as stored when there is one', () => {
    expect(
      contactSecondaryLine({ phone: '+5511999990000' }, tg, channelName)
    ).toBe('+5511999990000');
  });
  it('falls back to the primary identity with its channel', () => {
    expect(contactSecondaryLine({ phone: '' }, tg, channelName)).toBe(
      '@maria · Telegram'
    );
  });
  it('omits the channel when it cannot be named', () => {
    expect(contactSecondaryLine({ phone: '' }, tg)).toBe('@maria');
  });
  it('is empty when there is nothing at all', () => {
    expect(contactSecondaryLine({ phone: '' }, [], channelName)).toBe('');
  });
});

describe('identity search predicate', () => {
  it('finds a Telegram contact by handle or chat id', () => {
    const c = { name: '', phone: '', identities: tg };
    expect(matchesContactSearch(c, '@mar')).toBe(true);
    expect(matchesContactSearch(c, '42')).toBe(true);
    expect(matchesContactSearch(c, 'zzz')).toBe(false);
  });
});

describe('withIdentities / firstOf', () => {
  it('hydrates and drops the raw embed', () => {
    const row = withIdentities({
      id: 'a',
      contact_identities: [
        { kind: 'telegram:chat_id', external_id: '1', handle: null },
      ],
    });
    expect(row.identities).toEqual([
      { kind: 'telegram:chat_id', externalId: '1', handle: null },
    ]);
    expect('contact_identities' in row).toBe(false);
  });
  it('tolerates a missing embed and array to-one', () => {
    expect(withIdentities({ id: 'a' }).identities).toEqual([]);
    expect(firstOf([{ a: 1 }])).toEqual({ a: 1 });
    expect(firstOf(null)).toBeNull();
  });
});

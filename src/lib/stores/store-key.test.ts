import { describe, expect, it } from 'vitest';

import { buildStoreKey, normalizeStoreKey } from './store-key';

describe('buildStoreKey', () => {
  it('joins the three parts as typed', () => {
    expect(
      buildStoreKey({
        store_code: '89',
        store_acronym: 'RPA',
        business_acronym: 'BLC',
      })
    ).toBe('89/RPA/BLC');
  });

  it('is null unless all three parts are filled', () => {
    expect(
      buildStoreKey({ store_code: '89', store_acronym: 'RPA' })
    ).toBeNull();
    expect(
      buildStoreKey({
        store_code: '89',
        store_acronym: ' ',
        business_acronym: 'BLC',
      })
    ).toBeNull();
    expect(buildStoreKey({})).toBeNull();
  });
});

describe('normalizeStoreKey', () => {
  it('ignores case and edge spaces', () => {
    expect(normalizeStoreKey(' 89/rpa/Blc ')).toBe('89/rpa/blc');
    expect(normalizeStoreKey('89 / RPA / BLC')).toBe('89/rpa/blc');
    expect(normalizeStoreKey('89/RPA/BLC')).toBe(
      normalizeStoreKey('89/rpa/blc')
    );
  });

  it('keeps different businesses apart', () => {
    expect(normalizeStoreKey('89/RPA/BLC')).not.toBe(
      normalizeStoreKey('89/RPA/PZA')
    );
  });

  it('rejects anything that is not three non-empty parts', () => {
    for (const bad of [
      '89/RPA',
      '89/RPA/BLC/X',
      '89//BLC',
      '',
      '  ',
      null,
      7,
    ]) {
      expect(normalizeStoreKey(bad)).toBeNull();
    }
  });
});

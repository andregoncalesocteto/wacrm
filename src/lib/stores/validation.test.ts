import { describe, expect, it } from 'vitest';

import { parseStoreInput } from './validation';

describe('parseStoreInput: store key fields', () => {
  it('trims the three parts and turns blank into null', () => {
    const r = parseStoreInput(
      {
        name: 'A',
        store_code: ' 89 ',
        store_acronym: 'RPA',
        business_acronym: '  ',
      },
      false
    );
    expect(r).toMatchObject({
      ok: true,
      value: { store_code: '89', store_acronym: 'RPA', business_acronym: null },
    });
  });

  it('refuses "/" and over-long parts', () => {
    for (const key of ['store_code', 'store_acronym', 'business_acronym']) {
      expect(parseStoreInput({ name: 'A', [key]: 'a/b' }, false).ok).toBe(
        false
      );
      expect(parseStoreInput({ [key]: 'x'.repeat(41) }, true).ok).toBe(false);
      expect(parseStoreInput({ [key]: 'x'.repeat(40) }, true).ok).toBe(true);
      expect(parseStoreInput({ [key]: 5 }, true).ok).toBe(false);
    }
  });

  it('PATCH only touches the fields that are present', () => {
    expect(parseStoreInput({ store_code: '1' }, true)).toEqual({
      ok: true,
      value: { store_code: '1' },
    });
  });
});

describe('parseStoreInput: notification_connection_id', () => {
  const id = '3f2b1c64-7a5e-4c1d-9b8a-0e1f2a3b4c5d';

  it('accepts a uuid, and clears on null or blank', () => {
    expect(parseStoreInput({ notification_connection_id: id }, true)).toEqual({
      ok: true,
      value: { notification_connection_id: id },
    });
    for (const v of [null, '']) {
      expect(parseStoreInput({ notification_connection_id: v }, true)).toEqual({
        ok: true,
        value: { notification_connection_id: null },
      });
    }
  });

  it('rejects anything else', () => {
    for (const v of ['abc', 7, {}]) {
      expect(parseStoreInput({ notification_connection_id: v }, true).ok).toBe(
        false
      );
    }
  });
});

import { describe, it, expect } from 'vitest';
import { filterQuickRepliesForStore, shouldShowScopeUi } from './conversations';

describe('shouldShowScopeUi', () => {
  it('hides the scope UI while unknown, empty or with a single connection', () => {
    expect(shouldShowScopeUi(null)).toBe(false);
    expect(shouldShowScopeUi(undefined)).toBe(false);
    expect(shouldShowScopeUi([])).toBe(false);
    expect(shouldShowScopeUi([{ id: 'a' }])).toBe(false);
  });

  it('shows it with two or more connections, disabled ones included', () => {
    expect(shouldShowScopeUi([{ id: 'a' }, { id: 'b' }])).toBe(true);
    expect(
      shouldShowScopeUi([
        { id: 'a' },
        { id: 'b', disabled_at: 'x' },
        { id: 'c' },
      ])
    ).toBe(true);
  });
});

describe('filterQuickRepliesForStore', () => {
  const replies = [
    { id: 'net', store_id: null },
    { id: 'absent' },
    { id: 's1', store_id: 'store-1' },
    { id: 's2', store_id: 'store-2' },
  ];
  const ids = (r: { id: string }[]) => r.map((x) => x.id);

  it('keeps network-wide replies and the conversation store only', () => {
    expect(ids(filterQuickRepliesForStore(replies, 'store-1'))).toEqual([
      'net',
      'absent',
      's1',
    ]);
    expect(ids(filterQuickRepliesForStore(replies, 'store-2'))).toEqual([
      'net',
      'absent',
      's2',
    ]);
  });

  it('gives only network-wide replies when the store is unknown', () => {
    expect(ids(filterQuickRepliesForStore(replies, null))).toEqual([
      'net',
      'absent',
    ]);
    expect(ids(filterQuickRepliesForStore(replies, undefined))).toEqual([
      'net',
      'absent',
    ]);
  });
});

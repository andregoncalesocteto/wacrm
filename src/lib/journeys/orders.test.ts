import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, canChangeOrderStatus } from './orders';

describe('canChangeOrderStatus (what may notify the customer)', () => {
  it('a cancelled order never moves again, so no later status message is sent', () => {
    for (const s of ORDER_STATUSES)
      expect(canChangeOrderStatus('cancelled', s)).toBe(false);
  });

  it('a late (older or equal) status is ignored', () => {
    expect(canChangeOrderStatus('preparing', 'received')).toBe(false);
    expect(canChangeOrderStatus('preparing', 'preparing')).toBe(false);
  });

  it('a newer status and cancellation are accepted', () => {
    expect(canChangeOrderStatus('received', 'preparing')).toBe(true);
    expect(canChangeOrderStatus('preparing', 'cancelled')).toBe(true);
  });
});

/**
 * Delivery-status ladder for `broadcast_recipients` (US-021). Same rules as
 * the WhatsApp webhook route's private copy (which US-022 retires):
 *
 *   pending -> sent -> delivered -> read -> replied, forward only.
 *   `failed` is a terminal side branch, accepted only from pending/sent.
 *
 * Applies ONLY to broadcast recipients. The `messages` mirror has no order
 * guard (pinned by the US-002 characterization tests).
 */
const RECIPIENT_STATUS_LADDER = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
] as const;

export function ladderLevel(s: string): number {
  const idx = (RECIPIENT_STATUS_LADDER as readonly string[]).indexOf(s);
  return idx < 0 ? -1 : idx;
}

export function isValidStatusTransition(
  current: string,
  incoming: string
): boolean {
  if (incoming === 'failed') {
    return current === 'pending' || current === 'sent';
  }
  if (current === 'failed') return false;
  const ci = ladderLevel(current);
  const ii = ladderLevel(incoming);
  if (ii < 0) return false;
  if (ci < 0) return true;
  return ii > ci;
}

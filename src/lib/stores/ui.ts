// Pure helpers for the stores settings screen (no React, no i18n).

import { STORE_LIMITS } from './validation';

export type ConnectionChipState =
  'connected' | 'degraded' | 'disconnected' | 'needs_action' | 'disabled';

/** A disabled connection wins over whatever status it had when disabled. */
export function connectionChipState(c: {
  status: string;
  disabled_at: string | null;
}): ConnectionChipState {
  if (c.disabled_at) return 'disabled';
  switch (c.status) {
    case 'connected':
    case 'degraded':
    case 'needs_action':
      return c.status;
    default:
      return 'disconnected';
  }
}

/** Free-text hours live in `business_hours` as `{ text }`; blank means null. */
export function hoursToText(bh: Record<string, unknown> | null): string {
  return bh && typeof bh.text === 'string' ? bh.text : '';
}

export function textToHours(text: string): { text: string } | null {
  const t = text.trim();
  return t ? { text: t } : null;
}

export interface StoreDraft {
  name: string;
  address: string;
  phone: string;
  hours: string;
  manager_name: string;
}

export type DraftError = 'nameRequired' | 'nameTooLong' | 'fieldTooLong' | null;

export function validateDraft(d: StoreDraft): DraftError {
  if (!d.name.trim()) return 'nameRequired';
  if (d.name.trim().length > STORE_LIMITS.name) return 'nameTooLong';
  if (
    d.address.trim().length > STORE_LIMITS.address ||
    d.phone.trim().length > STORE_LIMITS.phone ||
    d.manager_name.trim().length > STORE_LIMITS.manager_name
  ) {
    return 'fieldTooLong';
  }
  return null;
}

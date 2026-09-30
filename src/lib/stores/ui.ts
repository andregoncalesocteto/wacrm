// Pure helpers for the stores settings screen (no React, no i18n).

import { STORE_LIMITS, isValidMenuUrl } from './validation';

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
  menu_url: string;
  store_code: string;
  store_acronym: string;
  business_acronym: string;
  /** Connection id, or '' for none. */
  notification_connection_id: string;
}

export type DraftError =
  | 'nameRequired'
  | 'nameTooLong'
  | 'fieldTooLong'
  | 'menuUrlInvalid'
  | 'keyPartInvalid'
  | null;

const KEY_PARTS = ['store_code', 'store_acronym', 'business_acronym'] as const;

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
  for (const k of KEY_PARTS) {
    const v = d[k].trim();
    if (v.length > STORE_LIMITS[k]) return 'fieldTooLong';
    if (v.includes('/')) return 'keyPartInvalid';
  }
  const menu = d.menu_url.trim();
  if (menu && !isValidMenuUrl(menu)) return 'menuUrlInvalid';
  return null;
}

/**
 * The channel type the settings screen treats as reachable by phone (the
 * candidates for the "notices" default). The server re-validates through the
 * providers' declared capabilities; this only decides what to offer.
 */
export function notificationCandidates<
  C extends { channel_type: string; disabled_at: string | null },
>(connections: C[]): C[] {
  return connections.filter(
    (c) => c.channel_type === 'whatsapp_cloud' && !c.disabled_at
  );
}

import type { ContactIdentity } from '@/lib/channels/types';

/**
 * Client-safe contact display helpers (US-018, US-052). Pure: no server-only
 * imports, so inbox components can use them. `identity.ts` re-exports
 * `contactDisplayName` for the older server-side imports.
 */

type DisplayContact = {
  name?: string | null;
  phone?: string | null;
};

/** Lower rank = more recognisable to a human. */
function rank(kind: string, handle?: string | null): number {
  if (kind.endsWith(':username') || handle?.startsWith('@')) return 0;
  if (kind.endsWith(':phone')) return 1;
  if (kind.endsWith(':bsuid')) return 2;
  return 3;
}

/** Identities ordered from most to least recognisable (username, phone, BSUID, other). */
export function sortIdentities<
  T extends { kind: string; handle?: string | null },
>(list: T[]): T[] {
  return [...list].sort(
    (a, b) => rank(a.kind, a.handle) - rank(b.kind, b.handle)
  );
}

/** How an identity reads to a person: `@username`, phone, BSUID, chat id. */
export function identityLabel(i: ContactIdentity): string {
  if (i.kind.endsWith(':username')) {
    const u = (i.handle ?? i.externalId).trim().replace(/^@/, '');
    return u ? `@${u}` : '';
  }
  return (i.handle?.trim() || i.externalId || '').trim();
}

/**
 * Name to show for a contact: its own name, else the primary identity
 * (`@username`, phone, BSUID, Telegram handle / chat id), else the phone
 * column. Empty only when the contact carries no identity at all.
 */
export function contactDisplayName(
  contact: DisplayContact,
  identities: ContactIdentity[] = []
): string {
  if (contact.name?.trim()) return contact.name.trim();
  for (const i of sortIdentities(identities)) {
    const label = identityLabel(i);
    if (label) return label;
  }
  return contact.phone?.trim() ? contact.phone : '';
}

/**
 * The identity that best says "who is this" without a phone number, with the
 * channel type it belongs to (`whatsapp_cloud` | `telegram`, the keys of
 * Settings.channels.type). Null when the contact has no identity to show.
 */
export function primaryIdentity(
  contact: DisplayContact,
  identities: ContactIdentity[] = []
): { label: string; channelType: string | null } | null {
  for (const i of sortIdentities(identities)) {
    const label = identityLabel(i);
    if (label) return { label, channelType: identityChannelType(i.kind) };
  }
  const phone = contact.phone?.trim() ? contact.phone : '';
  return phone ? { label: phone, channelType: 'whatsapp_cloud' } : null;
}

/** `whatsapp:phone` -> `whatsapp_cloud`, `telegram:chat_id` -> `telegram`. */
export function identityChannelType(kind: string): string | null {
  const prefix = kind.split(':')[0];
  if (prefix === 'whatsapp') return 'whatsapp_cloud';
  return prefix || null;
}

/**
 * Secondary line under a contact's name: the phone when there is one (exactly
 * what the inbox always showed), else the primary identity. Empty string only
 * when the contact has nothing at all (callers then omit the line).
 */
export function contactSubtitle(
  contact: DisplayContact,
  identities: ContactIdentity[] = []
): string {
  if (contact.phone?.trim()) return contact.phone;
  return primaryIdentity(contact, identities)?.label ?? '';
}

/** Avatar letter: first character of the label ignoring a leading `@`; never empty. */
export function contactInitial(label: string): string {
  const c = label.trim().replace(/^@/, '').charAt(0).toUpperCase();
  return c || '?';
}

/**
 * Text search over a contact: name, phone and every identity's handle and external id (so `@maria` finds a Telegram
 * contact). Case-insensitive substring; an empty query matches.
 */
export function matchesContactSearch(
  contact:
    (DisplayContact & { identities?: ContactIdentity[] }) | null | undefined,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (!contact) return false;
  const fields: (string | null | undefined)[] = [
    contact.name,
    contact.phone,
  ];
  for (const i of contact.identities ?? []) {
    fields.push(i.externalId, i.handle, identityLabel(i));
  }
  return fields.some((f) => !!f && f.toLowerCase().includes(q));
}

/** PostgREST embed that hydrates what the display helpers need. Keep it lean. */
export const CONTACT_IDENTITIES_EMBED =
  'contact_identities(kind, external_id, handle)';

/** Row shape returned by {@link CONTACT_IDENTITIES_EMBED}. */
export type RawContactIdentity = {
  kind: string;
  external_id: string;
  handle?: string | null;
};

/** snake_case embed rows -> `ContactIdentity[]` (tolerates a missing embed). */
export function identitiesFromRows(
  rows: RawContactIdentity[] | null | undefined
): ContactIdentity[] {
  return (rows ?? []).map((i) => ({
    kind: i.kind,
    externalId: i.external_id,
    handle: i.handle ?? null,
  }));
}

/**
 * Contact row (or embedded contact) that still carries the raw
 * `contact_identities` embed: hydrates `identities` and drops the raw key.
 */
export function withIdentities<T extends object>(
  row: T & { contact_identities?: RawContactIdentity[] | null }
): Omit<T, 'contact_identities'> & { identities: ContactIdentity[] } {
  const { contact_identities, ...rest } = row;
  return {
    ...rest,
    identities: identitiesFromRows(contact_identities),
  } as Omit<T, 'contact_identities'> & { identities: ContactIdentity[] };
}

/** PostgREST may return an embedded to-one as an array; take the first. */
export function firstOf<T>(v: T | T[] | null | undefined): T | null {
  return (Array.isArray(v) ? v[0] : v) ?? null;
}

/**
 * Secondary identifier of a contact in lists: the phone when present (exactly
 * as before), else the primary identity plus its channel ("@maria · Telegram").
 * `channelName` translates a channel type (`telegram`); without it, or when it
 * returns nothing, only the identity is shown. Empty when there is nothing.
 */
export function contactSecondaryLine(
  contact: DisplayContact,
  identities: ContactIdentity[] = [],
  channelName?: (channelType: string) => string | undefined
): string {
  if (contact.phone?.trim()) return contact.phone;
  const primary = primaryIdentity(contact, identities);
  if (!primary) return '';
  const channel = primary.channelType
    ? channelName?.(primary.channelType)
    : undefined;
  return channel ? `${primary.label} · ${channel}` : primary.label;
}

/**
 * Whether a broadcast (WhatsApp template) can reach the contact: it has a
 * phone or a WhatsApp phone / BSUID identity.
 * Telegram-only contacts are not eligible.
 */
export function isWhatsAppReachable(
  contact: DisplayContact,
  identities: ContactIdentity[] = []
): boolean {
  if (contact.phone?.trim()) return true;
  return identities.some(
    (i) => i.kind === 'whatsapp:phone' || i.kind === 'whatsapp:bsuid'
  );
}

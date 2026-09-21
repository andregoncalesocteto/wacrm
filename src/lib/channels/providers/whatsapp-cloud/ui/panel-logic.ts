// Pure helpers for the WhatsApp connection panel (no React, no i18n).

import type { ChannelConnectionRow } from '@/lib/channels/ui';

// Meta ids are decimal digit strings, the same paste-mistake check the
// server used to do before a round-trip.
export const META_ID_RE = /^\d+$/;

export type DraftError =
  | 'displayNameRequired'
  | 'phoneNumberIdRequired'
  | 'phoneNumberIdNotNumeric'
  | 'wabaIdRequired'
  | 'wabaIdNotNumeric'
  | 'accessTokenRequired';

/** Random webhook verify token (hex), generated client-side in create mode. */
export function generateVerifyToken(
  fill: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)
): string {
  return Array.from(fill(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface Draft {
  isCreate: boolean;
  displayName: string;
  phoneNumberId: string;
  wabaId: string;
  /** The access token the user typed (empty when not replacing). */
  accessToken: string;
}

/** First problem with the form, as a `Settings.whatsapp` key; null = fine. */
export function validateDraft(d: Draft): DraftError | null {
  if (!d.displayName.trim()) return 'displayNameRequired';
  if (d.isCreate) {
    if (!d.phoneNumberId.trim()) return 'phoneNumberIdRequired';
    if (!META_ID_RE.test(d.phoneNumberId.trim())) {
      return 'phoneNumberIdNotNumeric';
    }
  }
  if (!d.wabaId.trim()) return 'wabaIdRequired';
  if (!META_ID_RE.test(d.wabaId.trim())) return 'wabaIdNotNumeric';
  if (d.isCreate && !d.accessToken.trim()) return 'accessTokenRequired';
  return null;
}

export interface CreateInput {
  storeId: string;
  displayName: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  verifyToken: string;
  mirrorMedia: boolean;
}

/** Body of POST /api/channels/connections. The PIN is NOT part of it. */
export function buildCreateBody(i: CreateInput) {
  return {
    store_id: i.storeId,
    channel_type: 'whatsapp_cloud',
    display_name: i.displayName.trim(),
    config: {
      phone_number_id: i.phoneNumberId.trim(),
      waba_id: i.wabaId.trim(),
      verify_token: i.verifyToken,
      mirror_inbound_media: i.mirrorMedia,
    },
    credentials: { access_token: i.accessToken.trim() },
  };
}

export interface PatchInput {
  displayName: string;
  wabaId: string;
  mirrorMedia: boolean;
  /** Only set when the user chose to replace the verify token. */
  newVerifyToken: string | null;
  /** Only set when the user typed a new access token. */
  newAccessToken: string | null;
}

/** Body of PATCH /api/channels/connections/{id}: secrets only when replaced. */
export function buildPatchBody(i: PatchInput) {
  const config: Record<string, unknown> = {
    waba_id: i.wabaId.trim(),
    mirror_inbound_media: i.mirrorMedia,
  };
  if (i.newVerifyToken) config.verify_token = i.newVerifyToken;
  const body: Record<string, unknown> = {
    display_name: i.displayName.trim(),
    config,
  };
  if (i.newAccessToken && i.newAccessToken.trim()) {
    body.credentials = { access_token: i.newAccessToken.trim() };
  }
  return body;
}

/** Body of PATCH that only flips the mirror switch. */
export function buildMirrorBody(next: boolean) {
  return { config: { mirror_inbound_media: next } };
}

/** Body of POST .../connect: the PIN goes here and nowhere else. */
export function buildConnectBody(pin: string) {
  const p = pin.trim();
  return p ? { pin: p } : {};
}

/** Whether saving an edit has to (re)run the registration with Meta. */
export function shouldConnect(o: {
  tokenReplaced: boolean;
  pin: string;
  wabaChanged: boolean;
  status: string;
}): boolean {
  return (
    o.tokenReplaced ||
    o.pin.trim() !== '' ||
    o.wabaChanged ||
    o.status !== 'connected'
  );
}

export interface ConnectionView {
  wabaId: string;
  mirrorMedia: boolean;
  registeredAt: string | null;
  lastRegistrationError: string | null;
  /** Credentials are considered valid while the connection is up. */
  credentialsValid: boolean;
  lastErrorMessage: string;
}

/** Reads the non-secret state the panel shows out of a connection row. */
export function connectionView(c: ChannelConnectionRow | null): ConnectionView {
  const cfg = (c?.config ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const lastError = c?.last_error as { message?: unknown } | null | undefined;
  return {
    wabaId: str(cfg.waba_id) ?? '',
    // Absent = on, like the webhook's own default.
    mirrorMedia: cfg.mirror_inbound_media !== false,
    registeredAt: str(cfg.registered_at),
    lastRegistrationError: str(cfg.last_registration_error),
    credentialsValid: c?.status === 'connected' || c?.status === 'degraded',
    lastErrorMessage: str(lastError?.message) ?? '',
  };
}

export interface HealthResult {
  state: string;
  reason: string | null;
}

/** "Live" only when the provider health says connected. */
export function healthView(h: HealthResult): {
  live: boolean;
  reason: string | null;
} {
  return { live: h.state === 'connected', reason: h.reason };
}

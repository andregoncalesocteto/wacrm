/**
 * Client-safe: imports TYPES only (never provider modules or connections.ts,
 * which pull server code). The composer gets per-channel capabilities from
 * GET /api/channels/providers (see hooks/use-channel-providers.ts) and asks
 * this helper what to show for the conversation's channel.
 */
import type { Capabilities, ChannelErrorCode, MediaKind } from './types';

export interface ProviderCapabilities {
  type: string;
  capabilities: Capabilities;
}

/** i18n keys (under `Inbox.composer`) explaining why a feature is off. */
export type ComposerReasonKey =
  | 'unsupportedTemplates'
  | 'unsupportedButtons'
  | 'unsupportedList'
  | 'unsupportedReactions'
  | 'unsupportedMedia';

export interface ComposerCapabilities {
  /** False when the provider is unknown/not loaded and defaults applied. */
  known: boolean;
  canTemplate: boolean;
  canButtons: boolean;
  canList: boolean;
  canReact: boolean;
  canMedia: boolean;
  mediaKinds: MediaKind[];
  captionMax: number;
  reasons: {
    template?: ComposerReasonKey;
    buttons?: ComposerReasonKey;
    list?: ComposerReasonKey;
    react?: ComposerReasonKey;
    media?: ComposerReasonKey;
  };
}

const ALL_MEDIA: MediaKind[] = ['image', 'video', 'document', 'audio'];

/** Conservative default for an unknown channel: text + media only. */
const CONSERVATIVE: Omit<ComposerCapabilities, 'known'> = {
  canTemplate: false,
  canButtons: false,
  canList: false,
  canReact: false,
  canMedia: true,
  mediaKinds: ALL_MEDIA,
  captionMax: 1024,
  reasons: {
    template: 'unsupportedTemplates',
    buttons: 'unsupportedButtons',
    list: 'unsupportedList',
    react: 'unsupportedReactions',
  },
};

/**
 * Used ONLY while the provider list has not loaded yet (or failed) for a
 * WhatsApp / connection-less conversation, so the WhatsApp composer never
 * flashes disabled. Mirrors whatsappCloudCapabilities.
 */
const WHATSAPP_FALLBACK: Omit<ComposerCapabilities, 'known'> = {
  canTemplate: true,
  canButtons: true,
  canList: true,
  canReact: true,
  canMedia: true,
  mediaKinds: ALL_MEDIA,
  captionMax: 1024,
  reasons: {},
};

/**
 * What the composer may offer for a conversation on `channelType`.
 * `channelType` null/undefined = legacy conversation (WhatsApp). `providers`
 * null = not loaded. An unknown type degrades to text + media only.
 */
export function composerCapabilities(
  channelType: string | null | undefined,
  providers: ProviderCapabilities[] | null | undefined
): ComposerCapabilities {
  const type = channelType ?? 'whatsapp_cloud';
  const found = providers?.find((p) => p.type === type)?.capabilities;
  if (!found) {
    if (!providers && type === 'whatsapp_cloud') {
      return { known: false, ...WHATSAPP_FALLBACK };
    }
    return { known: false, ...CONSERVATIVE };
  }
  const mediaKinds = found.mediaKinds;
  const canMedia = mediaKinds.length > 0;
  return {
    known: true,
    canTemplate: found.templates,
    canButtons: found.interactiveButtons,
    canList: found.interactiveList,
    canReact: found.reactions,
    canMedia,
    mediaKinds,
    captionMax: found.captionMaxLength,
    reasons: {
      ...(!found.templates && { template: 'unsupportedTemplates' as const }),
      ...(!found.interactiveButtons && {
        buttons: 'unsupportedButtons' as const,
      }),
      ...(!found.interactiveList && { list: 'unsupportedList' as const }),
      ...(!found.reactions && { react: 'unsupportedReactions' as const }),
      ...(!canMedia && { media: 'unsupportedMedia' as const }),
    },
  };
}

const SEND_ERROR_KEYS: Partial<
  Record<ChannelErrorCode | 'connection_disabled', string>
> = {
  unsupported: 'unsupported',
  window_closed: 'windowClosed',
  recipient_unreachable: 'recipientUnreachable',
  connection_disabled: 'connectionDisabled',
  invalid: 'invalid',
};

/**
 * Key (under `Inbox.messageThread.sendError`) for a `code` returned by the
 * send API, or null when there is no translation (caller shows the server text).
 */
export function sendErrorMessageKey(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  return Object.hasOwn(SEND_ERROR_KEYS, code)
    ? SEND_ERROR_KEYS[code as ChannelErrorCode]!
    : null;
}

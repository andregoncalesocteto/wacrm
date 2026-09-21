import { ChannelError } from '../../types';
import type {
  Capabilities,
  ChannelProvider,
  ContactIdentity,
  Connection,
  MessageRef,
  OutboundMessage,
  SendResult,
  Target,
} from '../../types';
import { getConnectionCredentials } from '../../connections';
import {
  sendInteractiveButtons,
  sendInteractiveList,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendTextMessage,
} from '@/lib/whatsapp/meta-api';
import {
  isRecipientNotAllowedError,
  phoneVariants,
} from '@/lib/whatsapp/phone-utils';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';
import { toChannelError } from './errors';
import {
  connect,
  disconnect,
  downloadMedia,
  health,
  typing,
} from './lifecycle';
import { parse, resolveConnection, verify } from './inbound';
import {
  whatsappCloudConfigSchema,
  whatsappCloudCredentialsSchema,
} from './schemas';

/**
 * WhatsApp Cloud API provider. An ADAPTER over `lib/whatsapp/*` (which stays
 * where it is and still serves production paths until the later migration
 * stories). Outbound is in this file, inbound in ./inbound.ts (status and
 * reaction parsing only; messages arrive with US-073). Lifecycle and optional
 * operations (connect, disconnect, health, downloadMedia, typing) are in
 * ./lifecycle.ts.
 */

export const PHONE_KIND = 'whatsapp:phone';
export const BSUID_KIND = 'whatsapp:bsuid';

export const whatsappCloudCapabilities: Capabilities = {
  templates: true,
  interactiveButtons: true,
  interactiveList: true,
  reactions: true,
  typingIndicator: true,
  deliveryStatus: true,
  readStatus: true,
  initiate: 'template',
  replyWindowHours: 24,
  mediaKinds: ['image', 'video', 'document', 'audio'],
  // Chat uploads are capped at 16 MB by the app (upload-media.ts; images 5 MB
  // in the composer). Meta's own ceilings are higher for documents.
  maxMediaBytes: 16 * 1024 * 1024,
  // Meta caps media captions at 1024 chars (audio carries none).
  captionMaxLength: 1024,
};

/**
 * Same semantics as `resolveContactSendTarget`: a valid E.164 phone wins,
 * otherwise a BSUID; null when neither is usable.
 */
function resolveTarget(identities: ContactIdentity[]): Target | null {
  const phone = identities.find((i) => i.kind === PHONE_KIND)?.externalId;
  const bsuid = identities.find((i) => i.kind === BSUID_KIND)?.externalId;
  const resolved = resolveContactSendTarget({ phone, wa_user_id: bsuid });
  if (!resolved) return null;
  return {
    kind: resolved.isPhone ? PHONE_KIND : BSUID_KIND,
    address: resolved.target,
  };
}

interface TemplateProviderData {
  row?: Parameters<typeof sendTemplateMessage>[0]['template'];
  messageParams?: Parameters<typeof sendTemplateMessage>[0]['messageParams'];
  params?: string[];
}

/** Performs ONE Meta call to `to`; throws whatever meta-api throws. */
async function sendOnce(
  auth: { phoneNumberId: string; accessToken: string },
  to: string,
  msg: OutboundMessage
): Promise<string> {
  const base = { ...auth, to, contextMessageId: msg.replyTo?.externalId };
  switch (msg.type) {
    case 'text':
      return (await sendTextMessage({ ...base, text: msg.text })).messageId;
    case 'media':
      return (
        await sendMediaMessage({
          ...base,
          kind: msg.kind,
          link: msg.url,
          caption: msg.caption || undefined,
          filename: msg.fileName || undefined,
        })
      ).messageId;
    case 'template': {
      const data = (msg.template.provider ?? {}) as TemplateProviderData;
      return (
        await sendTemplateMessage({
          ...base,
          templateName: msg.template.name,
          language: msg.template.language,
          template: data.row,
          messageParams: data.messageParams,
          params: data.params ?? [],
        })
      ).messageId;
    }
    case 'interactive': {
      const p = msg.interactive;
      if (p.kind === 'buttons') {
        return (
          await sendInteractiveButtons({
            ...base,
            bodyText: p.body,
            headerText: p.header || undefined,
            footerText: p.footer || undefined,
            buttons: p.buttons,
          })
        ).messageId;
      }
      return (
        await sendInteractiveList({
          ...base,
          bodyText: p.body,
          buttonLabel: p.buttonLabel,
          headerText: p.header || undefined,
          footerText: p.footer || undefined,
          sections: p.sections,
        })
      ).messageId;
    }
    case 'reaction':
      return (
        await sendReactionMessage({
          phoneNumberId: auth.phoneNumberId,
          accessToken: auth.accessToken,
          to,
          targetMessageId: msg.target.externalId,
          emoji: msg.emoji ?? '',
        })
      ).messageId;
  }
}

async function authFor(conn: Connection) {
  const creds = await getConnectionCredentials(conn.id);
  const accessToken = creds?.access_token;
  if (!accessToken) {
    throw new ChannelError('auth', 'WhatsApp connection has no access token');
  }
  return { phoneNumberId: conn.external_id, accessToken };
}

async function send(
  conn: Connection,
  target: Target,
  msg: OutboundMessage
): Promise<SendResult> {
  const auth = await authFor(conn);

  // Variants only make sense for a phone number: a BSUID is opaque and has
  // exactly one correct form, so it gets a single attempt.
  const variants =
    target.kind === PHONE_KIND
      ? phoneVariants(target.address)
      : [target.address];
  let lastError: unknown = null;

  for (const variant of variants) {
    try {
      const externalId = await sendOnce(auth, variant, msg);
      return {
        externalId,
        ...(variant !== target.address && { resolvedAddress: variant }),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Only "recipient not in allowed list" moves on to the next variant.
      if (!isRecipientNotAllowedError(message)) throw toChannelError(err);
      lastError = err;
      console.warn(
        `[whatsapp-cloud] variant "${variant}" rejected by Meta, trying next…`
      );
    }
  }
  // Every variant rejected: surface the last error.
  throw toChannelError(lastError);
}

export const whatsappCloudProvider: ChannelProvider = {
  type: 'whatsapp_cloud',
  identityKinds: [PHONE_KIND, BSUID_KIND],
  capabilities: whatsappCloudCapabilities,
  configSchema: whatsappCloudConfigSchema,
  credentialsSchema: whatsappCloudCredentialsSchema,

  connect,
  disconnect,
  health,
  downloadMedia,
  typing,
  resolveConnection,
  verify,
  parse,

  resolveTarget,
  send,
  async react(
    conn: Connection,
    target: Target,
    ref: MessageRef,
    emoji: string
  ): Promise<void> {
    await send(conn, target, { type: 'reaction', target: ref, emoji });
  },
};

import { ChannelError } from '../../types';
import type {
  Capabilities,
  ChannelProvider,
  ContactIdentity,
  Target,
} from '../../types';
import { connect, deriveExternalId, disconnect, health } from './lifecycle';
import { downloadMedia, parse, resolveConnection, verify } from './inbound';
import { telegramConfigSchema, telegramCredentialsSchema } from './schemas';

/**
 * Telegram Bot API provider. Capabilities and lifecycle (US-047), inbound
 * (US-048); outbound arrives with US-049.
 */

export const CHAT_ID_KIND = 'telegram:chat_id';

export const telegramCapabilities: Capabilities = {
  templates: false,
  interactiveButtons: true, // inline keyboard
  interactiveList: false,
  reactions: true, // one per message
  typingIndicator: true,
  deliveryStatus: false, // Bot API has no delivery receipts
  readStatus: false, // ... nor read receipts
  initiate: 'after_inbound', // a bot can only message users who started it
  replyWindowHours: null,
  mediaKinds: ['image', 'video', 'document', 'audio'],
  maxMediaBytes: 50 * 1024 * 1024,
  captionMaxLength: 1024,
};

const notYet = (what: string) => (): never => {
  throw new ChannelError(
    'unsupported',
    `Telegram ${what} is not implemented yet`
  );
};

function resolveTarget(identities: ContactIdentity[]): Target | null {
  const chat = identities.find((i) => i.kind === CHAT_ID_KIND);
  return chat ? { kind: CHAT_ID_KIND, address: chat.externalId } : null;
}

export const telegramProvider: ChannelProvider = {
  type: 'telegram',
  descriptor: {
    panel: 'form',
    fields: [
      {
        name: 'bot_token',
        target: 'credentials',
        type: 'secret',
        required: true,
      },
    ],
  },
  identityKinds: [CHAT_ID_KIND],
  capabilities: telegramCapabilities,
  configSchema: telegramConfigSchema,
  credentialsSchema: telegramCredentialsSchema,

  connect,
  disconnect,
  health,
  deriveExternalId,

  resolveConnection,
  verify,
  parse,
  downloadMedia,

  resolveTarget,
  send: notYet('outbound'),
};

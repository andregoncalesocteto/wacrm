import type { Capabilities, ChannelProvider } from '../../types';
import {
  CHAT_ID_KIND,
  acknowledgeInteraction,
  react,
  resolveTarget,
  send,
  typing,
} from './outbound';
import { connect, deriveExternalId, disconnect, health } from './lifecycle';
import { downloadMedia, parse, resolveConnection, verify } from './inbound';
import { telegramConfigSchema, telegramCredentialsSchema } from './schemas';

/**
 * Telegram Bot API provider. Capabilities and lifecycle (US-047), inbound
 * (US-048); outbound (US-049) is in ./outbound.ts.
 */

export { CHAT_ID_KIND };

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
  send,
  react,
  typing,
  acknowledgeInteraction,
};

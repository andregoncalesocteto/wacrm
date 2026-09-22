import type { ProviderDescriptor } from '../../types';

/**
 * Pure, client-safe connect-form descriptor (no server imports): shared by the
 * provider (GET /api/channels/providers) and the UI registry. The connection
 * name is asked by the generic form itself. Bot tokens look like
 * `123456789:AA...` (digits, colon, 30+ url-safe characters).
 */
export const BOT_TOKEN_PATTERN = '^\\d+:[A-Za-z0-9_-]{30,}$';

export const telegramDescriptor: ProviderDescriptor = {
  panel: 'form',
  fields: [
    {
      name: 'bot_token',
      target: 'credentials',
      type: 'secret',
      required: true,
      pattern: BOT_TOKEN_PATTERN,
    },
  ],
};

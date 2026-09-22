import { getConnectionCredentials } from '../../connections';
import { ChannelError } from '../../types';
import type {
  Connection,
  ContactIdentity,
  InboundEvent,
  InteractivePayload,
  MediaKind,
  MessageRef,
  OutboundMessage,
  SendOptions,
  SendResult,
  Target,
} from '../../types';
import { callBotApi } from './api';

/**
 * Outbound side of the Telegram provider (US-049). Bot API facts (validated
 * against core.telegram.org): sendMessage/sendPhoto/... take `chat_id`,
 * `reply_parameters` and `reply_markup` (InlineKeyboardMarkup);
 * `callback_data` is 1-64 BYTES; photo caption 0-1024; setMessageReaction
 * takes a `reaction` array (a bot may set one; empty clears);
 * sendChatAction `typing`; answerCallbackQuery(callback_query_id).
 * Never logs; the token only lives inside `callBotApi`.
 *
 * externalId of anything we send is `${chat_id}:${message_id}`, the same
 * shape inbound stores, so replies/reactions/statuses line up.
 */

export const CHAT_ID_KIND = 'telegram:chat_id';
export const CALLBACK_DATA_MAX_BYTES = 64;

const MEDIA_METHOD: Record<MediaKind, { method: string; field: string }> = {
  image: { method: 'sendPhoto', field: 'photo' },
  video: { method: 'sendVideo', field: 'video' },
  document: { method: 'sendDocument', field: 'document' },
  audio: { method: 'sendAudio', field: 'audio' },
};

interface SentMessage {
  message_id: number;
  chat?: { id: number };
}

export function resolveTarget(identities: ContactIdentity[]): Target | null {
  const chat = identities.find((i) => i.kind === CHAT_ID_KIND);
  return chat ? { kind: CHAT_ID_KIND, address: chat.externalId } : null;
}

async function tokenFor(conn: Connection, opts?: SendOptions): Promise<string> {
  const creds = opts?.credentials ?? (await getConnectionCredentials(conn.id));
  const token = creds?.bot_token;
  if (typeof token !== 'string' || !token) {
    throw new ChannelError('auth', 'Telegram connection has no bot token');
  }
  return token;
}

/** Numeric Telegram message id of a `chat:message_id` ref; null for taps (`chat:cb:...`) or junk. */
function messageIdOf(ref: MessageRef): number | null {
  const m = /^-?\d+:(\d+)$/.exec(ref.externalId);
  return m ? Number(m[1]) : null;
}

function inlineKeyboard(p: Extract<InteractivePayload, { kind: 'buttons' }>) {
  for (const b of p.buttons) {
    if (Buffer.byteLength(b.id, 'utf8') > CALLBACK_DATA_MAX_BYTES) {
      throw new ChannelError(
        'invalid',
        `Button id exceeds Telegram's ${CALLBACK_DATA_MAX_BYTES}-byte callback_data limit`
      );
    }
  }
  return {
    inline_keyboard: p.buttons.map((b) => [
      { text: b.title, callback_data: b.id },
    ]),
  };
}

export async function send(
  conn: Connection,
  target: Target,
  msg: OutboundMessage,
  opts?: SendOptions
): Promise<SendResult> {
  if (msg.type === 'template') {
    throw new ChannelError(
      'unsupported',
      'Telegram does not support template messages'
    );
  }
  if (msg.type === 'interactive' && msg.interactive.kind === 'list') {
    throw new ChannelError(
      'unsupported',
      'Telegram does not support interactive lists'
    );
  }
  const token = await tokenFor(conn, opts);
  const chatId = target.address;

  if (msg.type === 'reaction') {
    await react(conn, target, msg.target, msg.emoji ?? '', opts);
    return { externalId: msg.target.externalId };
  }

  const replyId = msg.replyTo ? messageIdOf(msg.replyTo) : null;
  const common: Record<string, unknown> = {
    chat_id: chatId,
    ...(replyId !== null && {
      reply_parameters: {
        message_id: replyId,
        allow_sending_without_reply: true,
      },
    }),
  };

  let method: string;
  let params: Record<string, unknown>;
  switch (msg.type) {
    case 'text':
      method = 'sendMessage';
      params = { ...common, text: msg.text };
      break;
    case 'media': {
      const spec = MEDIA_METHOD[msg.kind];
      if (!spec) {
        throw new ChannelError(
          'unsupported',
          `Telegram does not support ${msg.kind} messages`
        );
      }
      if (msg.caption && msg.caption.length > 1024) {
        throw new ChannelError(
          'invalid',
          'Caption exceeds the 1024-character limit'
        );
      }
      method = spec.method;
      params = {
        ...common,
        [spec.field]: msg.url,
        ...(msg.caption && { caption: msg.caption }),
      };
      break;
    }
    case 'interactive': {
      const p = msg.interactive as Extract<
        InteractivePayload,
        { kind: 'buttons' }
      >;
      method = 'sendMessage';
      params = {
        ...common,
        text: p.body,
        reply_markup: inlineKeyboard(p),
      };
      break;
    }
    default:
      throw new ChannelError('unsupported', 'Unsupported Telegram message');
  }

  const sent = await callBotApi<SentMessage>(token, method, params);
  const chat = sent.chat?.id ?? chatId;
  return { externalId: `${chat}:${sent.message_id}` };
}

export async function react(
  conn: Connection,
  target: Target,
  ref: MessageRef,
  emoji: string,
  opts?: SendOptions
): Promise<void> {
  const messageId = messageIdOf(ref);
  if (messageId === null) {
    throw new ChannelError('invalid', 'Cannot react to this message');
  }
  const token = await tokenFor(conn, opts);
  await callBotApi<true>(token, 'setMessageReaction', {
    chat_id: target.address,
    message_id: messageId,
    reaction: emoji ? [{ type: 'emoji', emoji }] : [],
  });
}

export async function typing(conn: Connection, target: Target): Promise<void> {
  const token = await tokenFor(conn);
  await callBotApi<true>(token, 'sendChatAction', {
    chat_id: target.address,
    action: 'typing',
  });
}

/** Clears the tap spinner: the callback query id is in `chat:cb:<id>`. */
export async function acknowledgeInteraction(
  conn: Connection,
  event: InboundEvent
): Promise<void> {
  if (event.kind !== 'message' || event.content.type !== 'interactive_reply') {
    return;
  }
  const m = /^-?\d+:cb:(.+)$/.exec(event.externalId);
  if (!m) return;
  const token = await tokenFor(conn);
  await callBotApi<true>(token, 'answerCallbackQuery', {
    callback_query_id: m[1],
  });
}

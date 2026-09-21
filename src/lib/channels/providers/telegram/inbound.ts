import { timingSafeEqual } from 'node:crypto';
import { getConnectionById, getConnectionCredentials } from '../../connections';
import { ChannelError } from '../../types';
import type {
  Connection,
  IdentityCandidate,
  InboundContent,
  InboundEvent,
  MediaKind,
  MediaRef,
} from '../../types';
import { callBotApi, downloadBotFile } from './api';

/**
 * Inbound side of the Telegram provider (US-048): resolveConnection, verify,
 * parse and downloadMedia. Nothing here writes to the database or logs a
 * secret, a token or a file URL.
 *
 * DECISIONS
 *  - externalId of a message is `${chat.id}:${message_id}`: Telegram message
 *    ids are only unique PER CHAT, and the core's idempotency boundary is
 *    UNIQUE (conversation_id, message_id). In a private chat one conversation
 *    is one chat, so the pair is unique there too. Replies and reaction
 *    targets use the same shape.
 *  - A button tap (callback_query) has its own id, `${chat.id}:cb:${query.id}`
 *    (a Telegram callback query id is unique per tap, so a replayed update is
 *    a duplicate and two taps of one button are two messages). The parse
 *    never calls answerCallbackQuery (no I/O here): the tap's loading spinner
 *    is cleared by the outbound side (US-049).
 *  - PRIVATE chats only. group / supergroup / channel updates are ignored
 *    (debug log without content).
 *  - edited_message and my_chat_member (bot blocked/unblocked) are IGNORED:
 *    the core has no "message edited" event and a `connection` event would
 *    misreport the bot's own health as the user's.
 *  - Media: `MediaRef.id` is `${file_unique_id}:${file_id}`. Only file_id can
 *    be downloaded, but file_ids of one bot share long prefixes and the
 *    mirror's object path keeps just the first ~40 characters of the id, so
 *    the stable file_unique_id goes first to keep paths distinct.
 */

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const CHANNEL_TYPE = 'telegram';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const rawBodies = new WeakMap<Request, Promise<string>>();

/** The body can be read once; memoised per Request like the WhatsApp provider. */
function readRawBody(req: Request): Promise<string> {
  let cached = rawBodies.get(req);
  if (!cached) {
    cached = req.text();
    rawBodies.set(req, cached);
  }
  return cached;
}

/** The connection named by the URL (`.../webhook/<connectionId>`), or null. */
export async function resolveConnection(
  req: Request
): Promise<Connection | null> {
  const id = new URL(req.url).pathname.split('/').filter(Boolean).at(-1);
  if (!id || !UUID.test(id)) return null;
  const conn = await getConnectionById(id);
  return conn && conn.channel_type === CHANNEL_TYPE ? conn : null;
}

/**
 * Compares the `X-Telegram-Bot-Api-Secret-Token` header with the stored
 * `secret_token` in constant time. Missing header, missing stored secret,
 * length mismatch or any failure reading it -> false (fail closed).
 */
export async function verify(req: Request, conn: Connection): Promise<boolean> {
  const header = req.headers.get(SECRET_HEADER);
  if (!header) return false;
  let stored: unknown;
  try {
    stored = (await getConnectionCredentials(conn.id))?.secret_token;
  } catch {
    console.error('[telegram] could not read the webhook secret');
    return false;
  }
  if (typeof stored !== 'string' || !stored) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}
interface TgFile {
  file_id: string;
  file_unique_id: string;
  mime_type?: string;
  file_name?: string;
}
interface TgMessage {
  message_id: number;
  date?: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  photo?: TgFile[];
  document?: TgFile;
  voice?: TgFile;
  audio?: TgFile;
  video?: TgFile;
  video_note?: TgFile;
  animation?: TgFile;
  sticker?: TgFile & { is_animated?: boolean; is_video?: boolean };
  location?: { latitude: number; longitude: number };
  venue?: {
    location: { latitude: number; longitude: number };
    title?: string;
    address?: string;
  };
  contact?: unknown;
  reply_to_message?: { message_id: number };
  reply_markup?: {
    inline_keyboard?: { text: string; callback_data?: string }[][];
  };
}
interface TgUpdate {
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: {
    id: string;
    from: TgUser;
    message?: TgMessage;
    data?: string;
  };
  message_reaction?: {
    chat: TgChat;
    message_id: number;
    user?: TgUser;
    date?: number;
    new_reaction?: { type: string; emoji?: string }[];
  };
}

const extId = (chatId: number, messageId: number | string) =>
  `${chatId}:${messageId}`;

const toDate = (seconds?: number) =>
  typeof seconds === 'number' ? new Date(seconds * 1000) : new Date();

function fullName(u?: { first_name?: string; last_name?: string }) {
  return [u?.first_name, u?.last_name].filter(Boolean).join(' ') || undefined;
}

function sender(
  chat: TgChat,
  from?: { username?: string }
): IdentityCandidate[] {
  const out: IdentityCandidate[] = [
    { kind: 'telegram:chat_id', externalId: String(chat.id) },
  ];
  const username = from?.username ?? chat.username;
  if (username) {
    // Usernames are case-insensitive: key on lowercase, show as typed.
    out.push({
      kind: 'telegram:username',
      externalId: username.toLowerCase(),
      handle: `@${username}`,
    });
  }
  return out;
}

function mediaContent(
  kind: MediaKind,
  file: TgFile,
  caption: string | undefined,
  mimeType: string | undefined,
  fileName?: string
): InboundContent {
  const media: MediaRef = {
    kind,
    id: `${file.file_unique_id}:${file.file_id}`,
    ...((mimeType ?? file.mime_type) && {
      mimeType: mimeType ?? file.mime_type,
    }),
    ...(fileName && { fileName }),
  };
  return { type: 'media', kind, media, ...(caption && { caption }) };
}

function contentOf(m: TgMessage): InboundContent {
  const caption = m.caption || undefined;
  if (m.text !== undefined) return { type: 'text', text: m.text };
  if (m.photo?.length) {
    // Sizes come smallest to largest; take the largest. Photos have no MIME.
    const largest = m.photo[m.photo.length - 1];
    return mediaContent('image', largest, caption, 'image/jpeg');
  }
  if (m.document) {
    const d = m.document;
    return mediaContent(
      'document',
      d,
      caption || d.file_name,
      undefined,
      d.file_name
    );
  }
  if (m.voice) {
    return mediaContent(
      'audio',
      m.voice,
      caption,
      m.voice.mime_type ?? 'audio/ogg'
    );
  }
  if (m.audio)
    return mediaContent(
      'audio',
      m.audio,
      caption,
      undefined,
      m.audio.file_name
    );
  if (m.video)
    return mediaContent(
      'video',
      m.video,
      caption,
      m.video.mime_type ?? 'video/mp4'
    );
  if (m.video_note)
    return mediaContent('video', m.video_note, undefined, 'video/mp4');
  if (m.animation)
    return mediaContent(
      'video',
      m.animation,
      caption,
      m.animation.mime_type ?? 'video/mp4'
    );
  if (m.sticker) {
    const s = m.sticker;
    // Only static (WebP) stickers are images; animated (.tgs) / video are not.
    if (!s.is_animated && !s.is_video) {
      return mediaContent('image', s, undefined, 'image/webp');
    }
    return {
      type: 'unsupported',
      description: '[sticker]',
      stored: { contentType: 'image', text: null },
    };
  }
  const loc = m.venue?.location ?? m.location;
  if (loc) {
    const name = m.venue?.title;
    const address = m.venue?.address;
    return {
      type: 'location',
      latitude: loc.latitude,
      longitude: loc.longitude,
      ...(name && { name }),
      ...(address && { address }),
      text: [name, address, `${loc.latitude},${loc.longitude}`]
        .filter(Boolean)
        .join(' - '),
    };
  }
  if (m.contact) return { type: 'unsupported', description: '[contact]' };
  return { type: 'unsupported', description: '[Unsupported message type]' };
}

function fromMessage(m: TgMessage): InboundEvent {
  return {
    kind: 'message',
    externalId: extId(m.chat.id, m.message_id),
    sender: sender(m.chat, m.from),
    at: toDate(m.date),
    content: contentOf(m),
    ...(m.reply_to_message && {
      replyToExternalId: extId(m.chat.id, m.reply_to_message.message_id),
    }),
    ...(fullName(m.from ?? m.chat) && {
      senderName: fullName(m.from ?? m.chat),
    }),
  };
}

/**
 * Update JSON -> events (one Update yields at most one event). Malformed JSON,
 * unknown update types and non-private chats yield none.
 */
export async function parse(
  req: Request,
  _conn: Connection
): Promise<InboundEvent[]> {
  void _conn;
  let update: TgUpdate;
  try {
    const parsed = JSON.parse(await readRawBody(req));
    if (!parsed || typeof parsed !== 'object') return [];
    update = parsed as TgUpdate;
  } catch {
    return [];
  }

  const isPrivate = (chat?: TgChat) => {
    if (chat?.type === 'private') return true;
    console.debug('[telegram] ignoring update from a non-private chat');
    return false;
  };

  if (update.message) {
    return isPrivate(update.message.chat) ? [fromMessage(update.message)] : [];
  }

  const cb = update.callback_query;
  if (cb?.message && cb.data !== undefined) {
    const msg = cb.message;
    if (!isPrivate(msg.chat)) return [];
    const button = msg.reply_markup?.inline_keyboard
      ?.flat()
      .find((b) => b.callback_data === cb.data);
    return [
      {
        kind: 'message',
        externalId: extId(msg.chat.id, `cb:${cb.id}`),
        sender: sender(msg.chat, cb.from),
        at: new Date(),
        content: {
          type: 'interactive_reply',
          id: cb.data,
          title: button?.text || cb.data,
        },
        replyToExternalId: extId(msg.chat.id, msg.message_id),
        ...(fullName(cb.from) && { senderName: fullName(cb.from) }),
      },
    ];
  }

  const r = update.message_reaction;
  if (r) {
    if (!isPrivate(r.chat)) return [];
    const news = r.new_reaction ?? [];
    // Removal = empty list. A list holding only custom emoji has no emoji
    // we can show: ignored rather than misread as a removal.
    const emoji = news.find((x) => x.type === 'emoji' && x.emoji)?.emoji;
    if (news.length > 0 && !emoji) return [];
    return [
      {
        kind: 'reaction',
        externalId: extId(r.chat.id, r.message_id),
        sender: sender(r.chat, r.user),
        emoji: emoji ?? null,
        ...(r.date && { at: toDate(r.date) }),
      },
    ];
  }

  // edited_message, my_chat_member, ...: ignored (see the header).
  return [];
}

/**
 * getFile -> download, entirely server-side. Returns the bytes as a Blob;
 * the token-bearing file URL never leaves `downloadBotFile`.
 */
export async function downloadMedia(
  conn: Connection,
  ref: MediaRef
): Promise<Blob> {
  const creds = await getConnectionCredentials(conn.id);
  const token = creds?.bot_token;
  if (typeof token !== 'string' || !token) {
    throw new ChannelError('auth', 'Telegram connection has no bot token');
  }
  const fileId = ref.id.slice(ref.id.indexOf(':') + 1);
  const file = await callBotApi<{ file_path?: string }>(token, 'getFile', {
    file_id: fileId,
  });
  if (!file.file_path) {
    throw new ChannelError('invalid', 'Telegram returned no file path');
  }
  const blob = await downloadBotFile(token, file.file_path);
  return blob.type || !ref.mimeType
    ? blob
    : new Blob([blob], { type: ref.mimeType });
}

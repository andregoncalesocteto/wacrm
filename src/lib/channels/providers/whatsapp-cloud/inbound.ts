import type {
  ChannelErrorInfo,
  InboundContent,
  MediaKind,
  Connection,
  IdentityCandidate,
  InboundEvent,
} from '../../types';
import { getConnectionByExternalId } from '../../connections';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import {
  hasUsableIdentity,
  resolveInboundIdentity,
  type WaContactPayload,
  type WaIdentity,
} from '@/lib/whatsapp/wa-identity';
import { classifyMetaCode } from './errors';

/**
 * Inbound side of the WhatsApp Cloud provider: resolveConnection, verify and
 * parse (statuses, reactions and messages).
 *
 * BODY READ-ONCE: a Request body can be consumed a single time, but the
 * contract has three methods that each need the raw text (resolveConnection
 * reads the phone_number_id, verify hashes the exact bytes, parse reads the
 * events). Instead of changing the contract, the raw text is read lazily and
 * memoised per Request object in a WeakMap, so the three calls can be made in
 * any order on the same Request and the body is read exactly once. Nothing
 * needs `req.clone()`; entries vanish with the Request.
 *
 * NOT wired to the production webhook yet (that keeps its own code until
 * US-022). Nothing here writes to the database.
 */

const SIGNATURE_HEADER = 'x-hub-signature-256';
const CHANNEL_TYPE = 'whatsapp_cloud';

const rawBodies = new WeakMap<Request, Promise<string>>();

function readRawBody(req: Request): Promise<string> {
  let cached = rawBodies.get(req);
  if (!cached) {
    cached = req.text();
    rawBodies.set(req, cached);
  }
  return cached;
}

interface MetaStatusError {
  code: number;
  title: string;
  message?: string;
  error_data?: { details?: string };
}

interface MetaStatus {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: MetaStatusError[];
}

interface MetaMessage {
  id: string;
  from?: string;
  from_user_id?: string;
  from_parent_user_id?: string;
  timestamp?: string;
  type: string;
  reaction?: { message_id?: string; emoji?: string };
  text?: { body?: string };
  image?: MetaMedia;
  video?: MetaMedia;
  document?: MetaMedia & { filename?: string };
  audio?: MetaMedia;
  sticker?: MetaMedia;
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { text?: string; payload?: string };
  context?: { id?: string };
}

interface MetaMedia {
  id?: string;
  mime_type?: string;
  caption?: string;
}

interface MetaValue {
  metadata?: { phone_number_id?: string };
  contacts?: WaContactPayload[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

interface MetaPayload {
  entry?: { changes?: { field?: string; value?: MetaValue }[] }[];
}

async function readPayload(req: Request): Promise<MetaPayload | null> {
  try {
    const parsed = JSON.parse(await readRawBody(req));
    return parsed && typeof parsed === 'object'
      ? (parsed as MetaPayload)
      : null;
  } catch {
    return null;
  }
}

function values(payload: MetaPayload): MetaValue[] {
  const out: MetaValue[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.value) out.push(change.value);
    }
  }
  return out;
}

/**
 * The connection the payload belongs to, by `metadata.phone_number_id`
 * (first one found; Meta sends one number per delivery). Null for a body that
 * is not JSON, carries no phone_number_id, or matches no connection.
 */
export async function resolveConnection(
  req: Request
): Promise<Connection | null> {
  const payload = await readPayload(req);
  if (!payload) return null;
  const phoneNumberId = values(payload).find((v) => v.metadata?.phone_number_id)
    ?.metadata?.phone_number_id;
  if (!phoneNumberId) return null;
  return getConnectionByExternalId(CHANNEL_TYPE, phoneNumberId);
}

/**
 * HMAC-SHA256 over the raw body with `META_APP_SECRET` (comma-separated list
 * accepted, constant-time compare, fail closed when unset): delegated to the
 * same helper the production webhook uses. Not tied to `conn`: the secret is
 * app-level in this template.
 */
export async function verify(
  req: Request,
  _conn: Connection
): Promise<boolean> {
  void _conn;
  return verifyMetaWebhookSignature(
    await readRawBody(req),
    req.headers.get(SIGNATURE_HEADER)
  );
}

function toDate(timestamp: string | undefined): Date | undefined {
  if (!timestamp) return undefined;
  const seconds = parseInt(timestamp, 10);
  return Number.isNaN(seconds) ? undefined : new Date(seconds * 1000);
}

/** Types whose "[type]" preview differs from the stored content type. */
const EMPTY_PREVIEW: Record<string, string> = {
  sticker: '[sticker]',
  button: '[button]',
};

const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/**
 * Mirrors handleStatusUpdate: Meta's first error becomes the failure reason,
 * carrying code, title and details, and `message` is the same text the
 * broadcast mirror stores in `error_message` ("[code] title: details").
 */
function failureOf(status: MetaStatus): ChannelErrorInfo | undefined {
  const first = status.errors?.[0];
  if (status.status !== 'failed' || !first) return undefined;
  const details = first.error_data?.details ?? null;
  return {
    code: classifyMetaCode(first.code) ?? 'unknown',
    message: `[${first.code}] ${first.title}` + (details ? `: ${details}` : ''),
    providerCode: first.code,
    title: first.title,
    details,
  };
}

function reactionSender(
  message: MetaMessage,
  contact: WaContactPayload | undefined
): IdentityCandidate[] {
  const id = resolveInboundIdentity(message, contact);
  const out: IdentityCandidate[] = [];
  if (id.phone) out.push({ kind: 'whatsapp:phone', externalId: id.phone });
  if (id.waUserId)
    out.push({ kind: 'whatsapp:bsuid', externalId: id.waUserId });
  if (id.waUsername) {
    out.push({ kind: 'whatsapp:username', externalId: id.waUsername });
  }
  return out;
}

function messageSender(identity: WaIdentity): IdentityCandidate[] {
  const out: IdentityCandidate[] = [];
  if (identity.phone) {
    out.push({ kind: 'whatsapp:phone', externalId: identity.phone });
  }
  if (identity.waUserId) {
    out.push({ kind: 'whatsapp:bsuid', externalId: identity.waUserId });
  }
  if (identity.waUsername) {
    out.push({
      kind: 'whatsapp:username',
      externalId: identity.waUsername,
      handle: `@${identity.waUsername}`,
    });
  }
  return out;
}

function mediaContent(
  kind: MediaKind,
  m: MetaMedia | undefined,
  caption: string | undefined,
  fileName?: string
): InboundContent | null {
  if (!m?.id) return null;
  return {
    type: 'media',
    kind,
    media: {
      kind,
      id: m.id,
      ...(m.mime_type && { mimeType: m.mime_type }),
      ...(fileName && { fileName }),
    },
    ...(caption && { caption }),
  };
}

/**
 * Mirrors parseMessageContent (without the media download/mirror, which the
 * core does through `downloadMedia`). `caption` is the text the webhook stores
 * as content_text: the caption, and for a document the filename when there is
 * no caption. Stickers are images. A media message without an id, an
 * interactive reply without a tapped option and any unknown type become
 * `unsupported` carrying the placeholder text the webhook stores.
 */
function contentOf(m: MetaMessage): InboundContent {
  switch (m.type) {
    case 'text':
      return { type: 'text', text: m.text?.body ?? '' };
    case 'image':
    case 'video':
    case 'audio':
    case 'sticker': {
      const kind = m.type === 'sticker' ? 'image' : m.type;
      const media = m[m.type];
      const caption =
        m.type === 'image' || m.type === 'video' ? media?.caption : undefined;
      return (
        mediaContent(kind, media, caption) ?? {
          type: 'unsupported',
          description: `[${m.type}]`,
          stored: { contentType: kind, text: null },
        }
      );
    }
    case 'document': {
      const d = m.document;
      return (
        mediaContent('document', d, d?.caption || d?.filename, d?.filename) ?? {
          type: 'unsupported',
          description: '[document]',
          stored: { contentType: 'document', text: null },
        }
      );
    }
    case 'location': {
      const loc = m.location;
      if (!loc) {
        return {
          type: 'unsupported',
          description: '[location]',
          stored: { contentType: 'location', text: null },
        };
      }
      return {
        type: 'location',
        latitude: loc.latitude,
        longitude: loc.longitude,
        ...(loc.name && { name: loc.name }),
        ...(loc.address && { address: loc.address }),
        text: [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
          .filter(Boolean)
          .join(' - '),
      };
    }
    case 'interactive': {
      const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
      if (reply?.id) {
        return {
          type: 'interactive_reply',
          id: reply.id,
          title: reply.title || reply.id,
        };
      }
      return {
        type: 'unsupported',
        description: '[Interactive reply]',
        stored: { contentType: 'interactive', text: '[Interactive reply]' },
      };
    }
    case 'button': {
      // Template quick-reply tap: payload routes, text displays, each
      // falling back to the other.
      const payload = m.button?.payload || '';
      const label = m.button?.text || '';
      return {
        type: 'interactive_reply',
        id: payload || label,
        title: label || payload,
      };
    }
    default:
      return {
        type: 'unsupported',
        description: `[Unsupported message type: ${m.type}]`,
      };
  }
}

/**
 * Status, reaction and message events of the payload, in delivery order. Message
 * template-lifecycle fields carry no statuses/messages and yield nothing.
 * Statuses Meta may add beyond the four
 * we model (e.g. "deleted") are dropped, as are reactions without a target or
 * without any usable sender identity (the webhook skips those too).
 *
 * Events for one `value` are ordered statuses first, then messages, like
 * processWebhook. A message whose sender has neither a phone nor a valid BSUID
 * is DROPPED (no event), exactly as processMessage drops it: there is no key to
 * find or create a contact under. Candidates: whatsapp:phone (digits only, as
 * the dedupe normalizes), whatsapp:bsuid, whatsapp:username (handle "@name");
 * the portfolio-level BSUID has no candidate kind. `senderName` is the profile
 * name; `replyToExternalId` is `context.id`. Reaction `externalId` is the TARGET message's id
 * (`reaction.message_id`), an empty emoji becomes `null` (removal).
 */
export async function parse(
  req: Request,
  _conn: Connection
): Promise<InboundEvent[]> {
  void _conn;
  const payload = await readPayload(req);
  if (!payload) return [];
  const events: InboundEvent[] = [];

  for (const value of values(payload)) {
    for (const s of value.statuses ?? []) {
      if (!STATUSES.has(s.status)) continue;
      const error = failureOf(s);
      events.push({
        kind: 'status',
        externalId: s.id,
        status: s.status as 'sent' | 'delivered' | 'read' | 'failed',
        ...(error && { error }),
        ...(toDate(s.timestamp) && { at: toDate(s.timestamp) }),
        ...(s.recipient_id && { recipient: s.recipient_id }),
      });
    }

    const messages = value.messages ?? [];
    const contacts = value.contacts ?? [];
    messages.forEach((m, i) => {
      if (m.type !== 'reaction') {
        const contact = contacts[i] || contacts[0];
        const identity = resolveInboundIdentity(m, contact);
        if (!hasUsableIdentity(identity)) return;
        events.push({
          kind: 'message',
          externalId: m.id,
          sender: messageSender(identity),
          at: toDate(m.timestamp) ?? new Date(),
          content: contentOf(m),
          ...(m.context?.id && { replyToExternalId: m.context.id }),
          ...(identity.name && { senderName: identity.name }),
          ...(EMPTY_PREVIEW[m.type] && { emptyPreview: EMPTY_PREVIEW[m.type] }),
          ...(identity.waParentUserId && {
            parentExternalId: identity.waParentUserId,
          }),
        });
        return;
      }
      if (!m.reaction?.message_id) return;
      const sender = reactionSender(m, contacts[i] || contacts[0]);
      if (sender.length === 0) return;
      events.push({
        kind: 'reaction',
        externalId: m.reaction.message_id,
        sender,
        emoji: m.reaction.emoji ? m.reaction.emoji : null,
        ...(toDate(m.timestamp) && { at: toDate(m.timestamp) }),
      });
    });
  }
  return events;
}

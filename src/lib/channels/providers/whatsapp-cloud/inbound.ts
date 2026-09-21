import type {
  ChannelErrorInfo,
  Connection,
  IdentityCandidate,
  InboundEvent,
} from '../../types';
import { getConnectionByExternalId } from '../../connections';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import {
  resolveInboundIdentity,
  type WaContactPayload,
} from '@/lib/whatsapp/wa-identity';
import { classifyMetaCode } from './errors';

/**
 * Inbound side of the WhatsApp Cloud provider: resolveConnection, verify and
 * parse (statuses + reactions; message parsing is US-073).
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

/**
 * Status and reaction events of the payload, in delivery order. Message
 * events are NOT produced here (US-073); template-lifecycle fields carry no
 * statuses/messages and yield nothing. Statuses Meta may add beyond the four
 * we model (e.g. "deleted") are dropped, as are reactions without a target or
 * without any usable sender identity (the webhook skips those too).
 *
 * Events for one `value` are ordered statuses first, then messages, like
 * processWebhook. Reaction `externalId` is the TARGET message's id
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
      if (m.type !== 'reaction' || !m.reaction?.message_id) return;
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

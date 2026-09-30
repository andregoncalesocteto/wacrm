// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template through the
//                        connection's provider (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `external_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getConnectionById,
  getConnectionCredentials,
  type ChannelConnection,
} from '@/lib/channels/connections';
import { getProvider } from '@/lib/channels/registry';
import { registerBuiltinProviders } from '@/lib/channels/providers';
import {
  ChannelError,
  CONNECTION_DISABLED_CODE,
  ConnectionDisabledError,
  type ContactIdentity,
  type MediaKind,
  type OutboundMessage,
  type Target,
} from '@/lib/channels/types';
import { WA_PHONE_KIND } from '@/lib/channels/identity';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow, renderTemplateBody } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import {
  contactsWithConsent,
  NO_MARKETING_CONSENT_ERROR,
} from '@/lib/consent/consent';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  /**
   * Which connection sends this broadcast — any channel_type, resolved
   * generically (US-004). The caller (route) picks it; createBroadcast
   * never infers one on its own.
   */
  connectionId: string;
  /**
   * Approved template name. Mutually exclusive with `messageText`/
   * `messageMediaUrl` — exactly one content shape must be given (mirrors
   * the `broadcasts_content_exclusive_check` CHECK from migration 052).
   */
  templateName?: string | null;
  templateLanguage?: string | null;
  /** Campaign-level variable mapping; optional, either content shape. */
  templateVariables?: Record<string, unknown> | null;
  /** Free-message body. Mutually exclusive with `templateName`. */
  messageText?: string | null;
  /** Free-message media. Mutually exclusive with `templateName`. */
  messageMediaUrl?: string | null;
  recipients: BroadcastRecipientInput[];
}

interface PlannedRecipient {
  recipientRowId: string;
  contactId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  /** The connection that sends this broadcast; the provider reads its credentials. */
  connection: ChannelConnection;
  /** Informational (validated at plan time); sending goes through `connection`. */
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  /**
   * Free-message content (US-005) — absent/null on the template path.
   * The body still carries unresolved `{{1}}` tokens; `deliverBroadcast`
   * renders them per recipient with that recipient's frozen `params`.
   */
  messageText?: string | null;
  messageMediaUrl?: string | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const {
    name,
    connectionId,
    templateName,
    messageText,
    messageMediaUrl,
    recipients,
  } = params;

  // Exactly one content shape — mirrors the `broadcasts_content_exclusive_check`
  // CHECK (migration 052) so a bad request gets a clean 400 here instead of
  // an opaque DB constraint error from the RPC below.
  const hasTemplate = !!templateName;
  const hasMessage = !!(messageText || messageMediaUrl);
  if (hasTemplate === hasMessage) {
    throw new BroadcastError(
      'content_required',
      "Provide either 'template_name' or 'message_text'/'message_media_url' — never both, never neither",
      400
    );
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Connection: resolved generically by id (US-004) — any channel_type, no
  // WhatsApp-only inference. Same lookup + ownership check as
  // POST /api/v1/messages' pickConnection.
  const conn = await getConnectionById(connectionId, db);
  if (!conn || conn.account_id !== accountId) {
    throw new BroadcastError('not_found', 'Connection not found', 404);
  }
  if (conn.disabled_at) {
    throw new BroadcastError(
      CONNECTION_DISABLED_CODE,
      new ConnectionDisabledError().message,
      409
    );
  }
  const credentials = await getConnectionCredentials(conn.id);
  const accessToken =
    typeof credentials?.access_token === 'string' ? credentials.access_token : '';

  // Template row (once) for header/button components; guard a malformed
  // local row rather than N identical opaque failures. Only resolved on
  // the template path — a free-message broadcast has no approved template
  // to look up.
  let templateRow: MessageTemplate | null = null;
  let templateLanguage = '';
  if (hasTemplate) {
    const resolvedTemplate = await resolveTemplateRow(
      db,
      accountId,
      templateName!,
      params.templateLanguage
    );
    if (resolvedTemplate.malformed) {
      throw new BroadcastError(
        'template_malformed',
        'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        500
      );
    }
    templateRow = resolvedTemplate.row;
    templateLanguage = resolvedTemplate.language;
  }

  // Resolve each recipient to a contact. Invalid phones are dropped
  // (counted as rejected) rather than aborting the whole broadcast.
  const resolved: { contactId: string; phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(
      typeof r.to === 'string' ? r.to : ''
    );
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: sanitized,
    });
    resolved.push({
      contactId: id,
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  // Collapse recipients that resolved to the SAME contact (the caller
  // listed a phone twice, or two numbers fuzzy-matched to one contact).
  // Keep the first occurrence so the contact is messaged once and its
  // params aren't silently overwritten by a later duplicate — and so
  // the row↔params pairing below (keyed by contact_id) is unambiguous.
  const seenContact = new Set<string>();
  const deduped = resolved.filter((r) => {
    if (seenContact.has(r.contactId)) return false;
    seenContact.add(r.contactId);
    return true;
  });

  if (deduped.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name:
        name ||
        (hasTemplate ? `API broadcast (${templateName})` : 'API broadcast'),
      p_template_name: hasTemplate ? templateName : null,
      p_template_language: hasTemplate ? templateLanguage : null,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: deduped.map((r) => r.params),
      // The connection that sends this broadcast (migration 046).
      p_connection_id: conn.id,
      // Free-message content (migration 054) — null on the template path.
      p_message_text: hasMessage ? (messageText ?? null) : null,
      p_message_media_url: hasMessage ? (messageMediaUrl ?? null) : null,
      p_template_variables: params.templateVariables ?? null,
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return {
        recipientRowId: row.recipient_id,
        contactId: row.contact_id,
        phone: r.phone,
        params: r.params,
      };
    }
  );

  return {
    broadcastId,
    // '' on the free-message path — deliverBroadcast reads messageText/
    // messageMediaUrl instead for that path (US-005).
    templateName: hasTemplate ? templateName! : '',
    templateLanguage,
    connection: conn,
    phoneNumberId: conn.external_id,
    accessToken,
    templateRow,
    messageText: hasMessage ? (messageText ?? null) : null,
    messageMediaUrl: hasMessage ? (messageMediaUrl ?? null) : null,
    planned,
    rejected,
  };
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
const VIDEO_EXTENSIONS = new Set(['mp4', '3gp', 'mov']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'ogg', 'opus', 'm4a', 'aac', 'amr']);

/**
 * Guess a free-message attachment's `MediaKind` from its URL extension —
 * `broadcasts.message_media_url` (migration 052) has no separate kind
 * column. Falls back to 'document' (the broadest accepted kind) for an
 * unknown or missing extension.
 */
export function inferMediaKind(url: string): MediaKind {
  const ext = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(url)?.[1]?.toLowerCase() ?? '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return 'document';
}

/**
 * Load a contact's `contact_identities` rows for `provider.resolveTarget`
 * (US-009). Unlike `loadIdentities` in `lib/channels/send.ts`, this has no
 * whatsapp_cloud/`contacts.phone` fallback — it is only ever used on the
 * non-template path (`capabilities.initiate !== 'template'`), and no
 * built-in provider with that capability resolves a target off `contacts.phone`.
 */
export async function loadRecipientIdentities(
  db: SupabaseClient,
  contactId: string
): Promise<ContactIdentity[]> {
  const { data } = await db
    .from('contact_identities')
    .select('kind, external_id, handle')
    .eq('contact_id', contactId);
  return (
    (data as { kind: string; external_id: string; handle: string | null }[] | null) ?? []
  ).map((r) => ({ kind: r.kind, externalId: r.external_id, handle: r.handle }));
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 *
 * CONSENT: a broadcast is marketing. Recipients without `marketing` consent on
 * the broadcast's connection (an explicit revocation such as "PARAR", or
 * someone who never wrote to that number) are NOT sent: their row is stamped
 * `failed` with {@link NO_MARKETING_CONSENT_ERROR} and they are counted in the
 * returned `skippedNoConsent`. The check runs here, at send time, so resume/
 * retry and a broadcast saved before a "PARAR" honour it too.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<{ skippedNoConsent: number }> {
  // Resolve the provider ONCE, before touching any recipient.
  // US-078: a disabled connection sends nothing (the broadcast is bound to it).
  if (plan.connection.disabled_at) {
    await db
      .from('broadcasts')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', plan.broadcastId);
    throw new ConnectionDisabledError();
  }

  registerBuiltinProviders();
  const provider = getProvider(plan.connection.channel_type);
  // Only a `template`-capability channel (WhatsApp) sends the template
  // payload; anything else (`after_inbound`/`free`, e.g. Telegram) sends
  // the free message composed at plan time (US-005) — no more up-front
  // rejection here.
  const isTemplatePath = provider.capabilities.initiate === 'template';

  // Credentials are read (and decrypted) ONCE for the whole delivery and
  // handed to every send. `{}` when the connection has none: the provider then
  // fails each recipient with its own auth error, without re-reading.
  const credentials =
    (await getConnectionCredentials(plan.connection.id)) ?? {};

  const consented = await contactsWithConsent(
    db,
    plan.connection.account_id,
    plan.planned.map((r) => r.contactId),
    'marketing',
    { connectionId: plan.connection.id }
  );
  let skippedNoConsent = 0;

  for (const recipient of plan.planned) {
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    if (!consented.has(recipient.contactId)) {
      skippedNoConsent++;
      await db
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: NO_MARKETING_CONSENT_ERROR })
        .eq('id', recipient.recipientRowId);
      continue;
    }

    const message: OutboundMessage = isTemplatePath
      ? {
          type: 'template',
          template: {
            name: plan.templateName,
            language: plan.templateLanguage,
            provider: {
              row: plan.templateRow ?? undefined,
              params: recipient.params,
            },
          },
        }
      : plan.messageMediaUrl
        ? {
            type: 'media',
            kind: inferMediaKind(plan.messageMediaUrl),
            url: plan.messageMediaUrl,
            caption: plan.messageText
              ? renderTemplateBody(plan.messageText, recipient.params)
              : undefined,
          }
        : {
            type: 'text',
            text: renderTemplateBody(plan.messageText ?? '', recipient.params),
          };

    // Target resolution: the template (WhatsApp) path keeps resolving by
    // phone exactly as before (RNF-01, zero behavior change). A non-template
    // channel (Telegram, ...) has no reliable `contacts.phone` — its target
    // is resolved from the contact's `contact_identities` via the provider's
    // own `resolveTarget`, the same method `lib/channels/send.ts` uses for a
    // regular conversation send (US-009).
    const target: Target | null = isTemplatePath
      ? { kind: WA_PHONE_KIND, address: recipient.phone }
      : provider.resolveTarget(
          await loadRecipientIdentities(db, recipient.contactId)
        );

    // The provider owns the phone-variant retry (only "recipient not allowed"
    // moves on to the next variant) and throws the last error.
    if (!target) {
      lastError = 'No reachable address on this channel';
    } else {
      try {
        const result = await provider.send(plan.connection, target, message, {
          credentials,
        });
        sentMessageId = result.externalId;
      } catch (error) {
        // A non-Error rejection was wrapped by the provider; keep the old text.
        const wrappedNonError =
          error instanceof ChannelError &&
          error.cause !== undefined &&
          !(error.cause instanceof Error);
        lastError =
          error instanceof Error && !wrappedNonError
            ? error.message
            : 'Unknown error';
      }
    }

    if (sentMessageId) {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          external_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  if (skippedNoConsent > 0) {
    console.info(
      `[broadcast-core] ${plan.broadcastId}: ${skippedNoConsent} recipient(s) skipped, no marketing consent`
    );
  }
  await finalizeBroadcastStatus(db, plan.broadcastId);
  return { skippedNoConsent };
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}

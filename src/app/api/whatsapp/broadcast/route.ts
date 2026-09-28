import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getProvider } from '@/lib/channels/registry'
import { registerBuiltinProviders } from '@/lib/channels/providers'
import {
  ChannelError,
  CONNECTION_DISABLED_CODE,
  ConnectionDisabledError,
  type OutboundMessage,
  type Target,
} from '@/lib/channels/types'
import { WA_PHONE_KIND } from '@/lib/channels/identity'
import { getConnectionById, getConnectionCredentials } from '@/lib/channels/connections'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import {
  resolveTemplateRow,
  renderTemplateBody,
} from '@/lib/whatsapp/template-body'
import { inferMediaKind, loadRecipientIdentities } from '@/lib/whatsapp/broadcast-core'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import type { MessageTemplate } from '@/types'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

interface BroadcastResult {
  contact_id?: string
  phone: string
  status: 'sent' | 'failed'
  external_message_id?: string
  error?: string
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution and a
 *   non-template channel):
 *     {
 *       connection_id: string,
 *       recipients: Array<{ phone?: string; contact_id?: string; params: string[] }>,
 *       template_name?, template_language?,        // template content
 *       message_text?, message_media_url?          // OR free-message content
 *     }
 *
 *   LEGACY (all phones receive the same params; template-only — kept so
 *   existing callers don't break):
 *     {
 *       connection_id: string,
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * `connection_id` is now required for both shapes (US-013): the route no
 * longer assumes "the" WhatsApp connection — it resolves whichever
 * connection the caller picked, the same generic lookup broadcast-core.ts
 * uses (no channel_type filter).
 */
interface NewRecipient {
  phone?: string
  /** Needed to resolve a target on a non-template channel (US-009's identity-based resolveTarget). */
  contact_id?: string
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[]
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). Template path only — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams
}

export async function POST(request: Request) {
  try {
    // Requires the 'agent' role — `canSendMessages` in lib/auth/roles is
    // explicit that running broadcasts is a write operation and that
    // viewers are read-only.
    //
    // This endpoint writes NOTHING to the database: it reads the connection
    // and template, then calls the provider directly. So unlike the rest of
    // the app there was no RLS policy backstopping a missing role check —
    // resolving `account_id` straight off the profile (which only needs
    // 'viewer') was the ONLY gate, and it let a viewer blast a template
    // to arbitrary phone numbers from the account's WhatsApp number.
    // Nothing about that is recoverable after the fact, so the check has
    // to happen here.
    const { supabase, accountId, userId } = await requireRole('agent')

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const body = await request.json()
    const {
      connection_id,
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      message_text,
      message_media_url,
    } = body

    // Normalize to a list of {phone, contact_id, params} regardless of shape.
    let recipients: NewRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!connection_id || typeof connection_id !== 'string') {
      return NextResponse.json(
        { error: 'connection_id is required', code: 'connection_id_required' },
        { status: 400 }
      )
    }

    // Exactly one content shape — mirrors the `broadcasts_content_exclusive_check`
    // CHECK (migration 052) / createBroadcast's own validation, so a bad
    // request gets a clean 400 here instead of an opaque failure downstream.
    const hasTemplate = !!template_name
    const hasMessage = !!(message_text || message_media_url)
    if (hasTemplate === hasMessage) {
      return NextResponse.json(
        {
          error:
            "Provide either 'template_name' or 'message_text'/'message_media_url' — never both, never neither",
          code: 'content_required',
        },
        { status: 400 }
      )
    }

    // Connection: resolved generically by id (US-004's pattern) — any
    // channel_type, no WhatsApp-only inference.
    const conn = await getConnectionById(connection_id, supabase)
    if (!conn || conn.account_id !== accountId) {
      return NextResponse.json(
        { error: 'Connection not found', code: 'not_found' },
        { status: 404 }
      )
    }

    // US-078: a broadcast is bound to one connection; refuse a disabled one
    // before any send (409, same code as the other send paths).
    if (conn.disabled_at) {
      return NextResponse.json(
        {
          error: new ConnectionDisabledError().message,
          code: CONNECTION_DISABLED_CODE,
        },
        { status: 409 }
      )
    }

    registerBuiltinProviders()
    const provider = getProvider(conn.channel_type)
    const isTemplatePath = provider.capabilities.initiate === 'template'

    // A template can only go out on a channel that actually supports
    // template-initiated sends — a free-message-only channel (e.g.
    // Telegram) would otherwise silently be asked to send content it has
    // no way to render.
    if (hasTemplate && !isTemplatePath) {
      return NextResponse.json(
        {
          error: 'This connection cannot send template messages',
          code: 'connection_channel_mismatch',
        },
        { status: 400 }
      )
    }

    const credentials = (await getConnectionCredentials(conn.id)) ?? {}

    // Load the template row once so sendTemplateMessage can build
    // header + button components on each iteration. Loading inside
    // the loop would N+1 against Supabase for every recipient.
    // Guard against a malformed local row crashing every send in
    // the loop with the same opaque TypeError — fail loudly once.
    // Only resolved on the template path — a free-message broadcast has
    // no approved template to look up.
    let templateRow: MessageTemplate | null = null
    let resolvedLanguage = ''
    if (hasTemplate) {
      const resolvedTemplate = await resolveTemplateRow(
        supabase,
        accountId,
        template_name,
        template_language,
      )
      if (resolvedTemplate.malformed) {
        return NextResponse.json(
          {
            error:
              'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
          },
          { status: 500 },
        )
      }
      templateRow = resolvedTemplate.row
      resolvedLanguage = resolvedTemplate.language
    }

    const results: BroadcastResult[] = []
    let sentCount = 0
    let failedCount = 0

    for (const recipient of recipients) {
      let sentMessageId: string | null = null
      let lastError: string | null = null
      let target: Target | null = null

      if (isTemplatePath) {
        // Template path (WhatsApp): resolve the target by phone exactly
        // as before — zero behavior change (RNF-01).
        const sanitized = sanitizePhoneForMeta(recipient.phone ?? '')
        if (!isValidE164(sanitized)) {
          results.push({
            contact_id: recipient.contact_id,
            phone: recipient.phone ?? '',
            status: 'failed',
            error: 'Invalid phone number format',
          })
          failedCount++
          continue
        }
        target = { kind: WA_PHONE_KIND, address: sanitized }
      } else {
        // Free-message path (e.g. Telegram): a contact may have no phone
        // at all — resolve the target from its contact_identities instead
        // (US-009's provider.resolveTarget), never from contacts.phone.
        target = recipient.contact_id
          ? provider.resolveTarget(
              await loadRecipientIdentities(supabase, recipient.contact_id)
            )
          : null
        if (!target) {
          lastError = 'No reachable address on this channel'
        }
      }

      const message: OutboundMessage = isTemplatePath
        ? {
            type: 'template',
            template: {
              name: template_name,
              language: resolvedLanguage,
              provider: {
                row: templateRow ?? undefined,
                messageParams: recipient.messageParams,
                params: recipient.params ?? [],
              },
            },
          }
        : message_media_url
          ? {
              type: 'media',
              kind: inferMediaKind(message_media_url),
              url: message_media_url,
              caption: message_text
                ? renderTemplateBody(message_text, recipient.params ?? [])
                : undefined,
            }
          : {
              type: 'text',
              text: renderTemplateBody(message_text ?? '', recipient.params ?? []),
            }

      if (target) {
        try {
          const result = await provider.send(conn, target, message, {
            credentials,
          })
          sentMessageId = result.externalId
        } catch (error) {
          // A non-Error rejection was wrapped by the provider; keep the old text.
          const wrappedNonError =
            error instanceof ChannelError &&
            error.cause !== undefined &&
            !(error.cause instanceof Error)
          lastError =
            error instanceof Error && !wrappedNonError
              ? error.message
              : 'Unknown error'
        }
      }

      if (sentMessageId) {
        results.push({
          contact_id: recipient.contact_id,
          phone: recipient.phone ?? '',
          status: 'sent',
          external_message_id: sentMessageId,
        })
        sentCount++
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.contact_id ?? recipient.phone}:`,
          lastError
        )
        results.push({
          contact_id: recipient.contact_id,
          phone: recipient.phone ?? '',
          status: 'failed',
          error: lastError || 'Unknown error',
        })
        failedCount++
      }
    }

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    })
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp broadcast POST:', error)
    return toErrorResponse(error)
  }
}

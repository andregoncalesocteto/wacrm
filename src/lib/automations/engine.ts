import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  JourneyEventTriggerConfig,
  OrderStatusChangedTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from './admin-client'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain'
import { engineSendText, engineSendTemplate, engineSendInteractive } from './send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { getProvider, hasProvider } from '@/lib/channels/registry'
import { registerBuiltinProviders } from '@/lib/channels/providers'
import type { Capabilities } from '@/lib/channels/types'
import {
  hasMenuLinkVariable,
  replaceMenuLinkVariable,
  resolveMenuLink,
  recordMenuLinkSent,
  findOpenJourney,
  JOURNEY_STAGES,
  isJourneyFlag,
  isJourneyFlagSet,
  claimJourneyFlag,
  releaseJourneyFlag,
  type JourneyRow,
  type JourneyFlag,
  type ResolvedMenuLink,
} from '@/lib/journeys'

import { orderVariable, type AutomationOrderContext } from './order-vars'
import { gateSend, stepConsentPurpose } from './send-gate'

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
  /** Journey the event belongs to, for journey_event (also read by the
   *  journey conditions, which then look at THAT Journey's current state). */
  journey_id?: string
  /** Name of the accepted Journey event, for journey_event. */
  journey_event_name?: string
  /** Client-supplied id of the accepted Journey event. */
  journey_event_id?: string
  /** Validated properties of the accepted Journey event (cart, order...). */
  journey_event_properties?: Record<string, unknown>
  /** Journey stage right after the event. */
  journey_stage?: string
  /** Connection the Journey runs on. */
  connection_id?: string
  /** When the menu link was sent, for menu_link_sent. Its presence marks a run
   *  born from a link send (a `{{menu_link}}` step in it would loop). */
  menu_link_sent_at?: string
  /** The order this run is about: order_status_changed (status change) or a
   *  Purchase journey_event. Feeds `{{order_id}}`/`{{order_status}}`/`{{order_value}}`. */
  order?: AutomationOrderContext
  /** Store of a direct event (no conversation yet): lets a send step create the
   *  conversation on the store's notification connection, after the consent
   *  check. Absent for runs that already have a conversation. */
  store_id?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    const db = supabaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return
    }
    if (!automations || automations.length === 0) return

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        // A renewed link (or a new cart / checkout event) starts the
        // automation's timers over: park-and-resume runs from the previous
        // one must not also fire, so the wait always counts from the LAST.
        // The old runs are cancelled only AFTER the new one has started (its
        // log exists): if it cannot start, the old timers keep counting. The
        // window in between is closed at resume time (`isSuperseded`).
        const supersedeIds =
          isSupersedingTrigger(input.triggerType) && input.contactId
            ? await findPendingRunIds(db, automation, input.contactId)
            : []
        const started = await executeAutomation(automation, input)
        if (started && supersedeIds.length > 0) {
          await cancelPendingRuns(db, automation, supersedeIds)
        }
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
  /** Conversation the run was parked on (US-028). Wins over the context's
   *  conversation_id; NULL for rows parked before it existed or without one. */
  conversation_id?: string | null
  /** Connection of that conversation at park time (informational: the send
   *  resolves the connection from the conversation). */
  connection_id?: string | null
}): Promise<void> {
  const db = supabaseAdmin()
  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed')
    return
  }

  // A run claimed by the cron (`running`) cannot be cancelled by a newer
  // trigger, so the old chain checks here that it is still the current one.
  if (await isSuperseded(db, automation as Automation, pending)) {
    await markPending(pending.id, 'cancelled')
    return
  }

  try {
    await executeStepsFrom({
      automation: automation as Automation,
      contactId: pending.contact_id,
      context: pending.conversation_id
        ? { ...(pending.context ?? {}), conversation_id: pending.conversation_id }
        : (pending.context ?? {}),
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
      startPosition: pending.next_step_position,
      logId: pending.log_id,
      triggerEvent: 'resumed_wait',
      resumeRoot: true,
    })
    await markPending(pending.id, 'done')
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed')
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

/** Triggers whose new firing restarts the automation's timers. */
function isSupersedingTrigger(triggerType: string): boolean {
  return triggerType === 'menu_link_sent' || triggerType === 'journey_event'
}

/** The automation's parked (not yet claimed) runs for this contact. */
async function findPendingRunIds(
  db: SupabaseClient,
  automation: Automation,
  contactId: string,
): Promise<string[]> {
  const { data, error } = await db
    .from('automation_pending_executions')
    .select('id')
    .eq('automation_id', automation.id)
    .eq('account_id', automation.account_id)
    .eq('contact_id', contactId)
    .eq('status', 'pending')
  if (error) {
    console.error('[automations] supersede lookup failed:', error)
    return []
  }
  return ((data ?? []) as { id: string }[]).map((r) => r.id)
}

/** Cancel exactly those runs, and only while still parked. */
async function cancelPendingRuns(db: SupabaseClient, automation: Automation, ids: string[]) {
  const { error } = await db
    .from('automation_pending_executions')
    .update({ status: 'cancelled' })
    .in('id', ids)
    .eq('account_id', automation.account_id)
    .eq('status', 'pending')
  if (error) console.error('[automations] supersede pending failed:', error)
}

/**
 * Whether a newer run of the same automation started for this contact since
 * the parked run's own (its log row). Only for the superseding triggers: other
 * automations legitimately run overlapping chains.
 */
async function isSuperseded(
  db: SupabaseClient,
  automation: Automation,
  pending: { contact_id: string | null; log_id: string | null },
): Promise<boolean> {
  if (!isSupersedingTrigger(automation.trigger_type) || !pending.contact_id || !pending.log_id) {
    return false
  }
  const { data: own } = await db
    .from('automation_logs')
    .select('created_at')
    .eq('id', pending.log_id)
    .maybeSingle()
  const ownAt = (own as { created_at?: string } | null)?.created_at
  if (!ownAt) return false
  const { data: latest } = await db
    .from('automation_logs')
    .select('id, created_at')
    .eq('automation_id', automation.id)
    .eq('account_id', automation.account_id)
    .eq('contact_id', pending.contact_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const row = latest as { id: string; created_at: string } | null
  return !!row && row.id !== pending.log_id && row.created_at > ownAt
}

/** Returns whether the run started (its log row was created). */
async function executeAutomation(automation: Automation, input: DispatchInput): Promise<boolean> {
  const db = supabaseAdmin()

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      // Explicit so "start of this run" (customer_replied_since) has a fixed
      // instant that survives waits: resumes reuse this same log row.
      created_at: new Date().toISOString(),
      // Seeded pessimistically. The row is written BEFORE any step runs,
      // and every terminal path below overwrites it (`appendResults` at
      // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
      // run that died mid-flight — the process frozen, the pod recycled —
      // left a permanent `status: 'success'` with `steps_executed: []`,
      // indistinguishable from an automation that genuinely had nothing
      // to do. 'failed' inverts that: the status only becomes success if
      // execution actually reached the end. See issue #409.
      status: 'failed',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return false
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
  return true
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
  /** First scope of a run resumed from a wait: it owns the log's final status
   *  even when the wait was inside a branch (parentStepId !== null). */
  resumeRoot?: boolean
}

type RunStatus = 'success' | 'partial' | 'failed'

async function executeStepsFrom(args: ExecuteArgs): Promise<RunStatus> {
  const db = supabaseAdmin()

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped

  if (stepsErr) {
    await finalizeLog(args.logId, 'failed', stepsErr.message)
    return 'failed'
  }
  if (!steps || steps.length === 0) {
    if ((args.parentStepId === null || args.resumeRoot) && args.logId) {
      await finalizeLog(args.logId, 'success', null)
    }
    return 'success'
  }

  const results: AutomationLogStepResult[] = []
  let status: 'success' | 'partial' | 'failed' = 'success'
  let errorMessage: string | null = null

  for (const step of steps as AutomationStep[]) {
    // `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      // Remember WHICH conversation (and connection) the run is on so the
      // resume sends through it, whatever the customer's other threads do.
      // `automation_pending_executions.conversation_id`/`.connection_id` are
      // NOT NULL (US-070), so a trigger with no conversation in context
      // (time-based, tag-based, new-contact) resolves the contact's most
      // recent one, same rule as a send step (design.md R4); a contact with
      // none at all fails the step, same as a send that can't resolve one.
      // A direct event (customer who never wrote) has a store but no
      // conversation: the run parks WITHOUT one (columns are nullable since
      // 066) and the send step creates it, closed, after the consent check.
      let waitConversationId: string | null = null
      if (!args.context.conversation_id && args.context.store_id) {
        // no conversation to resolve
      } else {
        try {
          waitConversationId = await resolveConversationId(args, 'text')
        } catch (err) {
          if (err instanceof ExecutionIgnored) {
            results.push({
              step_id: step.id,
              step_type: step.step_type,
              status: 'skipped',
              detail: `ignored: ${err.message}`,
            })
            break
          }
          const msg = err instanceof Error ? err.message : String(err)
          results.push({
            step_id: step.id,
            step_type: step.step_type,
            status: 'failed',
            detail: msg,
          })
          status = 'failed'
          errorMessage = msg
          break
        }
      }
      let waitConnectionId: string | null = null
      if (waitConversationId) {
        const { data: convRow } = await db
          .from('conversations')
          .select('connection_id')
          .eq('id', waitConversationId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        waitConnectionId =
          (convRow as { connection_id?: string | null } | null)?.connection_id ?? null
      }
      await db.from('automation_pending_executions').insert({
        automation_id: args.automation.id,
        // Tenancy: account_id required NOT NULL post-017.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        contact_id: args.contactId,
        log_id: args.logId,
        parent_step_id: args.parentStepId,
        branch: args.branch,
        next_step_position: step.position + 1,
        context: args.context,
        conversation_id: waitConversationId,
        connection_id: waitConnectionId,
        run_at: new Date(Date.now() + ms).toISOString(),
        status: 'pending',
      })
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      status = 'partial'
      await appendResults(args.logId, results, status, errorMessage)
      return 'partial'
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        const nested = await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
          resumeRoot: false,
        })
        // A failed send inside a branch fails the run; the branch already
        // recorded the step and its error message.
        if (nested === 'failed') status = 'failed'
        // A wait parked inside the branch is still pending: the run is not
        // finished, so the log must not end as 'success'.
        else if (nested === 'partial' && status === 'success') status = 'partial'
        continue
      }

      const detail = await runStep(step, args)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      if (err instanceof ExecutionIgnored) {
        // Not a failure: there is nowhere valid to send. Recorded with the
        // reason (no send, nothing thrown, run ends without error).
        results.push({
          step_id: step.id,
          step_type: step.step_type,
          status: 'skipped',
          detail: `ignored: ${err.message}`,
        })
        break
      }
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      status = 'failed'
      errorMessage = msg
      break
    }
  }

  if (args.parentStepId === null || args.resumeRoot) {
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    // Nested branch — just append results; parent scope decides final status.
    await appendResults(args.logId, results, null, errorMessage)
  }
  return status
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = supabaseAdmin()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const contactId = args.contactId
      args = await gateSendStep(args, contactId, cfg.consent_purpose)
      // `{{menu_link}}` resolves conversation -> connection -> store -> menu_url
      // and mints/renews the Tracking token BEFORE the send; a failure there
      // throws, so nothing is sent. The Journey opens only after the send.
      const usesMenuLink = hasMenuLinkVariable(cfg.text)
      if (usesMenuLink && args.context.menu_link_sent_at) {
        // Sending a link fires menu_link_sent: this run would trigger itself.
        throw new Error('{{menu_link}} is not allowed in a menu_link_sent automation')
      }
      // `{{store_name}}`: conversation -> connection -> store, read now. No
      // store (or no conversation) leaves it empty and warns, never fails.
      const usesStoreName = STORE_NAME_VARIABLE.test(cfg.text)
      let storeName = ''
      let warning = ''
      if (usesStoreName) {
        const store = await storeOfConversation(
          args,
          await resolveConversationId(args, 'text'),
        )
        storeName = store?.name ?? ''
        if (!storeName.trim()) {
          storeName = ''
          warning = '; warning: {{store_name}} is empty (the conversation has no store)'
        }
      }
      const extra = { store_name: storeName }
      const preText = usesMenuLink ? cfg.text : interpolate(cfg.text, args, extra)
      if (!preText.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args, 'text')
      let menuLink: ResolvedMenuLink | null = null
      let text = preText
      if (usesMenuLink) {
        menuLink = await resolveMenuLink(db, {
          accountId: args.automation.account_id,
          userId: args.automation.user_id,
          conversationId,
          contactId,
        })
        text = interpolate(replaceMenuLinkVariable(cfg.text, menuLink.url), args, extra)
      }
      // One-shot mark: claim it atomically BEFORE sending, so a second run
      // (or a concurrent one) finds it taken and sends nothing.
      let claimed: { journeyId: string; flag: JourneyFlag } | null = null
      if (cfg.mark_journey_flag) {
        if (!isJourneyFlag(cfg.mark_journey_flag)) {
          throw new Error(`unknown journey flag: ${String(cfg.mark_journey_flag)}`)
        }
        const journey = await currentJourney(args)
        if (!journey) throw new Error('mark_journey_flag needs a Journey')
        const won = await claimJourneyFlag(db, {
          accountId: args.automation.account_id,
          journeyId: journey.id,
          flag: cfg.mark_journey_flag,
        })
        if (!won) return `skipped: ${cfg.mark_journey_flag} already set on the Journey`
        claimed = { journeyId: journey.id, flag: cfg.mark_journey_flag }
      }
      let whatsapp_message_id: string | undefined
      try {
        ;({ whatsapp_message_id } = await engineSendText({
          accountId: args.automation.account_id,
          userId: args.automation.user_id,
          conversationId,
          contactId,
          text,
          // A template fallback would replace the text and drop the link, so a
          // link message never falls back: outside the window it fails visibly.
          fallbackTemplate: !menuLink && cfg.fallback_template?.name
            ? {
                name: cfg.fallback_template.name,
                // '' = unspecified: the core resolves it from the template row.
                language: cfg.fallback_template.language ?? '',
                provider: { params: templateParams(cfg.fallback_template.variables) },
              }
            : null,
        }))
      } catch (err) {
        // Nothing went out: give the mark back so a later trigger can retry.
        if (claimed) {
          await releaseJourneyFlag(db, {
            accountId: args.automation.account_id,
            ...claimed,
          })
        }
        throw err
      }
      if (menuLink) {
        await recordMenuLinkSent(db, {
          accountId: args.automation.account_id,
          userId: args.automation.user_id,
          conversationId,
          contactId,
          connectionId: menuLink.connectionId,
        })
      }
      return `sent via Meta (${whatsapp_message_id})${warning}`
    }

    case 'send_buttons':
    case 'send_list': {
      const { consent_purpose, ...payload } = step.step_config as
        | SendButtonsStepConfig
        | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      const contactId = args.contactId
      args = await gateSendStep(args, contactId, consent_purpose)
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(
        args,
        payload.kind === 'list' ? 'interactiveList' : 'interactiveButtons',
      )
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const contactId = args.contactId
      args = await gateSendStep(args, contactId, cfg.consent_purpose)
      const conversationId = await resolveConversationId(args, 'templates')
      const params = templateParams(cfg.variables)
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      })
      if (!added) return `tag ${cfg.tag_id} already present`

      const depth = getTagChainDepth(args.context)
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          tagId: cfg.tag_id,
          depth,
        })
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      })
      return `tag ${cfg.tag_id} added and tag_added dispatched`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id)
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the automation's author; preserving that
        // shape until a real round-robin algorithm replaces it.
        const { data: profiles } = await db
          .from('profiles')
          .select('user_id')
          .eq('account_id', args.automation.account_id)
          .limit(1)
        agentId = profiles?.[0]?.user_id
      }
      if (!agentId) return 'no agent resolved'
      await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: args.contactId, custom_field_id: customFieldId, value },
            { onConflict: 'contact_id,custom_field_id' },
          )
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed')
      }
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/** The run has nowhere valid to send; recorded as ignored, not failed. */
class ExecutionIgnored extends Error {}

/**
 * Consent + conversation gate of a send step (see `gateSend`). Ignores the step
 * with the reason when there is no consent for its purpose (or no notification
 * connection for a direct event); otherwise returns the args to send with: the
 * conversation created/found for a store-only run is put in the context.
 */
async function gateSendStep(
  args: ExecuteArgs,
  contactId: string,
  declaredPurpose: unknown,
): Promise<ExecuteArgs> {
  const gate = await gateSend(supabaseAdmin(), {
    accountId: args.automation.account_id,
    userId: args.automation.user_id,
    contactId,
    purpose: stepConsentPurpose(declaredPurpose),
    conversationId: args.context.conversation_id,
    storeId: args.context.store_id,
  })
  if (!gate.ok) throw new ExecutionIgnored(gate.reason)
  if (!gate.conversationId || args.context.conversation_id) return args
  return {
    ...args,
    context: {
      ...args.context,
      conversation_id: gate.conversationId,
      ...(gate.connectionId ? { connection_id: gate.connectionId } : {}),
    },
  }
}

type SendNeed = 'text' | keyof Pick<Capabilities, 'templates' | 'interactiveButtons' | 'interactiveList'>

function connectionSupports(channelType: string, need: SendNeed): boolean {
  if (need === 'text') return true
  registerBuiltinProviders()
  if (!hasProvider(channelType)) return false
  return getProvider(channelType).capabilities[need] === true
}

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (or the one a wait step saved); otherwise (time-based,
 * tag-based, new-contact triggers) take the contact's MOST RECENT
 * conversation on a connection that supports the step (US-028). A contact
 * with no conversation at all is still a failed step; a contact whose
 * conversations are all on connections that cannot do this step is ignored,
 * with the reason.
 */
async function resolveConversationId(args: ExecuteArgs, need: SendNeed): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const accountId = args.automation.account_id
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('conversations')
    .select('id, connection_id')
    .eq('account_id', accountId)
    .eq('contact_id', args.contactId)
    .order('last_message_at', { ascending: false })
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  const rows = (data ?? []) as { id: string; connection_id: string | null }[]
  if (rows.length === 0) {
    const prefix = args.triggerEvent === 'tag_added'
      ? 'tag_added automation cannot send'
      : 'cannot send'
    throw new Error(`${prefix}: contact has no existing conversation`)
  }

  const connectionIds = [
    ...new Set(rows.map((r) => r.connection_id).filter((c): c is string => !!c)),
  ]
  const typeById = new Map<string, string>()
  let skippedDisabled = false
  if (connectionIds.length > 0) {
    const { data: conns, error: connErr } = await db
      .from('channel_connections')
      .select('id, channel_type, disabled_at')
      .eq('account_id', accountId)
      .in('id', connectionIds)
    if (connErr) throw new Error(`connection lookup failed: ${connErr.message}`)
    for (const c of (conns ?? []) as {
      id: string
      channel_type: string
      disabled_at: string | null
    }[]) {
      // A disabled connection refuses every send (US-078): never pick its
      // conversations, they would only fail in sendOutbound.
      if (c.disabled_at) skippedDisabled = true
      else typeById.set(c.id, c.channel_type)
    }
  }
  for (const row of rows) {
    // Conversations without a connection are legacy WhatsApp threads.
    const type = row.connection_id ? typeById.get(row.connection_id) : 'whatsapp_cloud'
    if (type && connectionSupports(type, need)) return row.id
  }
  throw new ExecutionIgnored(
    `contact has no conversation on ${skippedDisabled ? 'an enabled' : 'a'} connection that supports ${need}`,
  )
}

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/**
 * Whole-word keyword test, behind `match_type: 'word'` (issue #409 — a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Exported for direct unit testing of the escaping / boundary edges.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false,
): boolean {
  if (!keyword) return false
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu',
  )
  return pattern.test(text)
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive),
      )
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  // Fires for the accepted Journey event's name (any one of the configured).
  if (automation.trigger_type === 'journey_event') {
    const cfg = automation.trigger_config as JourneyEventTriggerConfig
    const name = ctx?.journey_event_name
    if (!name || !Array.isArray(cfg?.event_names) || cfg.event_names.length === 0) {
      return false
    }
    return cfg.event_names.includes(name)
  }

  // Fires for the status the order just moved to (any one of the configured).
  if (automation.trigger_type === 'order_status_changed') {
    const cfg = automation.trigger_config as OrderStatusChangedTriggerConfig
    const status = ctx?.order?.status
    if (!status || !Array.isArray(cfg?.statuses) || cfg.statuses.length === 0) {
      return false
    }
    return cfg.statuses.includes(status)
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    const tagId = ctx?.tag_id
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId)
  }

  return true
}

/**
 * `contact_field` equality. A contact without a phone stores phone = '',
 * which counts as "not set": it never equals anything (not even ''),
 * mirroring how the flows engine treats an empty field. Other fields keep
 * the plain comparison.
 */
export function contactFieldMatches(
  field: string | undefined,
  raw: unknown,
  expected: string | undefined,
): boolean {
  if (raw == null) return false
  if (field === 'phone' && String(raw) === '') return false
  return String(raw) === String(expected ?? '')
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand)
      return (count ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return contactFieldMatches(cfg.operand, v, cfg.value)
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    case 'journey_open': {
      const journey = await currentJourney(args)
      return journey?.state === 'open'
    }
    case 'journey_stage': {
      // The Journey's funnel position NOW ("is X" / "is before X"). A closed
      // Journey sits at won/lost, past every open stage, so "before cart" also
      // means it is still open.
      const journey = await currentJourney(args)
      if (!journey) return false
      const target = stageRank(cfg.operand)
      const current = stageRank(journey.stage)
      if (target < 0 || current < 0) return false
      if (cfg.value === 'is') return current === target
      if (cfg.value === 'before') return current < target
      return false
    }
    case 'conversation_unattended': {
      // No human owns the conversation and the AI has not handed it off.
      const conv = await conditionConversation(args)
      // No conversation yet (a direct event): nobody attends the customer.
      if (!conv) return true
      return !conv.assigned_agent_id && !conv.ai_autoreply_disabled
    }
    case 'journey_flag': {
      // The one-shot mark is read NOW, so a send by a concurrent run counts.
      if (!isJourneyFlag(cfg.operand)) return false
      return isJourneyFlagSet(await currentJourney(args), cfg.operand)
    }
    case 'business_acronym_is': {
      // The store's acronym is read NOW (conversation -> connection -> store),
      // so it also holds after a wait resumes. No store or no acronym: false.
      const wanted = (cfg.operand ?? '').trim().toLowerCase()
      if (!wanted) return false
      // The store of the event (direct runs) wins over the conversation's.
      const conv = args.context.store_id ? null : await conditionConversation(args)
      const store = args.context.store_id
        ? await storeById(args, args.context.store_id)
        : conv
          ? await storeOfConversation(args, conv.id)
          : null
      const acronym = (store?.business_acronym ?? '').trim().toLowerCase()
      return acronym !== '' && acronym === wanted
    }
    case 'customer_replied_since': {
      // Both sides are read from the database NOW (this runs when the step
      // executes, also after a wait resumes), never from a scheduling snapshot.
      const since = await replyReferenceInstant(cfg.operand, args)
      if (since === null) return false
      const conv = await conditionConversation(args)
      // No conversation: the customer never wrote, so there is no reply.
      if (!conv) return false
      const { data } = await db
        .from('messages')
        .select('created_at')
        .eq('conversation_id', conv.id)
        .eq('sender_type', 'customer')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const last = (data as { created_at?: string } | null)?.created_at
      if (!last) return false
      return Date.parse(last) > since
    }
    default:
      return false
  }
}

interface ConditionConversation {
  id: string
  connection_id: string | null
  assigned_agent_id: string | null
  ai_autoreply_disabled: boolean | null
}

const STORE_NAME_VARIABLE = /\{\{\s*store_name\s*\}\}/

/** A store of the automation's account, or null. */
async function storeById(
  args: ExecuteArgs,
  storeId: string,
): Promise<{ name: string | null; business_acronym: string | null } | null> {
  const { data } = await supabaseAdmin()
    .from('stores')
    .select('name, business_acronym')
    .eq('id', storeId)
    .eq('account_id', args.automation.account_id)
    .maybeSingle()
  return (data as { name: string | null; business_acronym: string | null } | null) ?? null
}

/** The store of a conversation (conversation -> connection -> store), or null. */
async function storeOfConversation(
  args: ExecuteArgs,
  conversationId: string,
): Promise<{ name: string | null; business_acronym: string | null } | null> {
  const db = supabaseAdmin()
  const accountId = args.automation.account_id
  const { data: conv } = await db
    .from('conversations')
    .select('connection_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  const connectionId = (conv as { connection_id: string | null } | null)?.connection_id
  if (!connectionId) return null
  const { data: conn } = await db
    .from('channel_connections')
    .select('store_id')
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .maybeSingle()
  const storeId = (conn as { store_id: string | null } | null)?.store_id
  if (!storeId) return null
  const { data: store } = await db
    .from('stores')
    .select('name, business_acronym')
    .eq('id', storeId)
    .eq('account_id', accountId)
    .maybeSingle()
  return (store as { name: string | null; business_acronym: string | null } | null) ?? null
}

/** Position of a stage in the funnel, or -1 when it is not one. */
function stageRank(stage: string | undefined): number {
  return JOURNEY_STAGES.findIndex((s) => s.key === stage)
}

/** Conversation (and its connection) the journey conditions look at. */
async function conditionConversation(
  args: ExecuteArgs,
): Promise<ConditionConversation | null> {
  const db = supabaseAdmin()
  const accountId = args.automation.account_id
  const fromCtx = args.context.conversation_id
  if (fromCtx) {
    const { data } = await db
      .from('conversations')
      .select('id, connection_id, assigned_agent_id, ai_autoreply_disabled')
      .eq('id', fromCtx)
      .eq('account_id', accountId)
      .maybeSingle()
    return (data as ConditionConversation | null) ?? null
  }
  if (!args.contactId) return null
  let query = db
    .from('conversations')
    .select('id, connection_id, assigned_agent_id, ai_autoreply_disabled')
    .eq('account_id', accountId)
    .eq('contact_id', args.contactId)
  // A direct run carries its store: the fallback conversation must belong to
  // a connection of THAT store. A conversation of another store is not this
  // event's conversation (no conversation there means "no conversation").
  const storeId = args.context.store_id
  if (storeId) {
    const { data: conns } = await db
      .from('channel_connections')
      .select('id')
      .eq('account_id', accountId)
      .eq('store_id', storeId)
    const ids = ((conns ?? []) as { id: string }[]).map((c) => c.id)
    if (ids.length === 0) return null
    query = query.in('connection_id', ids)
  }
  const { data } = await query
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as ConditionConversation | null) ?? null
}

/**
 * The Journey the run is about: the one the trigger named (`journey_id`, so a
 * Purchase that just closed it reads as closed), otherwise the contact's open
 * Journey on the conversation's connection. Always read fresh.
 */
async function currentJourney(args: ExecuteArgs): Promise<JourneyRow | null> {
  const db = supabaseAdmin()
  const accountId = args.automation.account_id
  const journeyId = args.context.journey_id
  if (journeyId) {
    const { data } = await db
      .from('journeys')
      .select('*')
      .eq('id', journeyId)
      .eq('account_id', accountId)
      .maybeSingle()
    return (data as JourneyRow | null) ?? null
  }
  if (!args.contactId) return null
  const conv = await conditionConversation(args)
  if (!conv?.connection_id) return null
  return findOpenJourney(db, {
    accountId,
    contactId: args.contactId,
    connectionId: conv.connection_id,
  })
}

/** Epoch ms of `customer_replied_since`'s reference, or null if unknown. */
async function replyReferenceInstant(
  reference: string | undefined,
  args: ExecuteArgs,
): Promise<number | null> {
  let iso: string | null | undefined
  if (reference === 'link_sent') {
    iso = (await currentJourney(args))?.link_sent_at
  } else if (reference === 'run_start') {
    if (!args.logId) return null
    const { data } = await supabaseAdmin()
      .from('automation_logs')
      .select('created_at')
      .eq('id', args.logId)
      .maybeSingle()
    iso = (data as { created_at?: string } | null)?.created_at
  }
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isNaN(ms) ? null : ms
}

// Meta templates use positional {{1}}, {{2}}, … placeholders, so we MUST emit
// params in strict numeric order. Lexicographic sort of "1", "2", …, "10"
// yields "1", "10", "2", … which silently scrambles every template with ≥10
// variables.
function templateParams(variables: Record<string, string> | undefined): string[] {
  if (!variables) return []
  return Object.keys(variables)
    .sort((a, b) => {
      const na = Number(a)
      const nb = Number(b)
      const aNum = Number.isFinite(na)
      const bNum = Number.isFinite(nb)
      if (aNum && bNum) return na - nb
      if (aNum) return -1
      if (bNum) return 1
      return a.localeCompare(b)
    })
    .map((k) => String(variables[k]))
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(
  s: string,
  args: ExecuteArgs,
  extra?: { store_name?: string },
): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    if (key === 'store_name') return extra?.store_name ?? ''
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    if (key === 'order_id' || key === 'order_status' || key === 'order_value') {
      return orderVariable(
        args.context.order,
        key,
        process.env.NEXT_PUBLIC_APP_LOCALE || 'en',
      )
    }
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const db = supabaseAdmin()
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single()
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Record<string, unknown> = { steps_executed: merged }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status
  }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId)
}

async function markPending(id: string, status: 'done' | 'failed' | 'cancelled') {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status })
    .eq('id', id)
}

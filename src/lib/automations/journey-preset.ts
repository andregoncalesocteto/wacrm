import type { SupabaseClient } from '@supabase/supabase-js';
import type { TemplateStepSeed } from './templates';
import { ORDER_TRIGGER_STATUSES } from './trigger-meta';

// ------------------------------------------------------------
// "Jornada de pedido" preset: the Resumptions, the abandoned-cart message,
// the thank-you and one notification per order status, as ordinary
// automations (data only, no engine change). Installing it creates them
// INACTIVE and idempotently; the operator reviews the texts, sets the
// WhatsApp `fallback_template` and turns them on in the normal builder.
// ------------------------------------------------------------

export const JOURNEY_PRESET_PREFIX = 'order_journey.';

/** Customer-facing texts and automation names, from `messages/*.json`. */
export interface JourneyPresetCatalog {
  automations: Record<string, { name: string; description: string }>;
  texts: Record<string, string>;
}

export interface PresetAutomation {
  preset_key: string;
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  steps: TemplateStepSeed[];
}

const send = (
  text: string,
  extra: Record<string, unknown> = {},
  parent?: number,
  branch?: 'yes' | 'no'
): TemplateStepSeed => ({
  step_type: 'send_message',
  step_config: { text, ...extra },
  ...(parent === undefined ? {} : { parent_index: parent, branch }),
});

const cond = (
  config: Record<string, unknown>,
  parent?: number,
  branch?: 'yes' | 'no'
): TemplateStepSeed => ({
  step_type: 'condition',
  step_config: config,
  ...(parent === undefined ? {} : { parent_index: parent, branch }),
});

const wait = (
  amount: number,
  parent?: number,
  branch?: 'yes' | 'no'
): TemplateStepSeed => ({
  step_type: 'wait',
  step_config: { amount, unit: 'minutes' },
  ...(parent === undefined ? {} : { parent_index: parent, branch }),
});

/**
 * Step seeds for the Resumption chain (#9): wait 10 -> unattended -> before
 * cart -> no reply since the link -> R1 -> wait 20 (same branch) -> the same
 * three checks -> R2. There is no negation, so each send lives in the "no"
 * branch of the reply check. The texts never carry `{{menu_link}}`: a step
 * with it inside a `menu_link_sent` automation is refused (it would re-fire
 * itself).
 */
function resumptionSteps(r1: string, r2: string): TemplateStepSeed[] {
  return [
    wait(10), // 0
    cond({ subject: 'conversation_unattended' }), // 1
    cond(
      { subject: 'journey_stage', operand: 'cart', value: 'before' },
      1,
      'yes'
    ), // 2
    cond({ subject: 'customer_replied_since', operand: 'link_sent' }, 2, 'yes'), // 3
    send(r1, {}, 3, 'no'), // 4
    wait(20, 3, 'no'), // 5
    cond({ subject: 'conversation_unattended' }, 3, 'no'), // 6
    cond(
      { subject: 'journey_stage', operand: 'cart', value: 'before' },
      6,
      'yes'
    ), // 7
    cond({ subject: 'customer_replied_since', operand: 'link_sent' }, 7, 'yes'), // 8
    send(r2, {}, 8, 'no'), // 9
  ];
}

/** Abandoned-cart chain (#10): once per Journey, counted from the last event. */
function abandonedCartSteps(text: string): TemplateStepSeed[] {
  return [
    wait(10), // 0
    cond({ subject: 'conversation_unattended' }), // 1
    cond({ subject: 'journey_open' }, 1, 'yes'), // 2
    cond({ subject: 'customer_replied_since', operand: 'run_start' }, 2, 'yes'), // 3
    cond({ subject: 'journey_flag', operand: 'abandoned_cart_sent' }, 3, 'no'), // 4
    send(text, { mark_journey_flag: 'abandoned_cart_sent' }, 4, 'no'), // 5
  ];
}

export function buildJourneyPreset(
  catalog: JourneyPresetCatalog
): PresetAutomation[] {
  const make = (
    shortKey: string,
    trigger_type: string,
    trigger_config: Record<string, unknown>,
    steps: TemplateStepSeed[]
  ): PresetAutomation => {
    const meta = catalog.automations[shortKey];
    return {
      preset_key: JOURNEY_PRESET_PREFIX + shortKey,
      name: meta.name,
      description: meta.description,
      trigger_type,
      trigger_config,
      steps,
    };
  };

  // The order notices declare `notifications`; the abandoned cart and the
  // resumptions declare nothing on purpose (strict `marketing` default; the
  // abandoned cart is settled in its own ticket).
  const notice = (text: string) => send(text, { consent_purpose: 'notifications' });
  return [
    make(
      'resumption',
      'menu_link_sent',
      {},
      resumptionSteps(catalog.texts.resumption1, catalog.texts.resumption2)
    ),
    make(
      'abandoned_cart',
      'journey_event',
      { event_names: ['AddToCart', 'InitiateCheckout'] },
      abandonedCartSteps(catalog.texts.abandonedCart)
    ),
    make('thank_you', 'journey_event', { event_names: ['Purchase'] }, [
      notice(catalog.texts.thankYou),
    ]),
    ...ORDER_TRIGGER_STATUSES.map((status) =>
      make(`status_${status}`, 'order_status_changed', { statuses: [status] }, [
        notice(catalog.texts[`status_${status}`]),
      ])
    ),
  ];
}

/** Texts for the deployment locale (`NEXT_PUBLIC_APP_LOCALE`), English fallback. */
export async function loadJourneyPresetCatalog(
  locale: string | undefined = process.env.NEXT_PUBLIC_APP_LOCALE
): Promise<JourneyPresetCatalog> {
  let messages: { Automations: { journeyPreset: JourneyPresetCatalog } };
  try {
    messages = (await import(`../../../messages/${locale || 'en'}.json`))
      .default;
  } catch {
    messages = (await import('../../../messages/en.json')).default;
  }
  return messages.Automations.journeyPreset;
}

// ------------------------------------------------------------
// Install (idempotent)
// ------------------------------------------------------------

export interface InstallResult {
  created: string[];
  existing: string[];
  /** Existing automations that only got the missing `consent_purpose` filled. */
  backfilled: string[];
}

function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === '23505';
}

/**
 * An automation installed before `consent_purpose` existed: fill ONLY that
 * property on its send steps that lack it (with the purpose the preset
 * declares), keeping every other key, so edited texts and templates survive.
 * Returns whether any step changed.
 */
async function backfillConsentPurpose(
  db: SupabaseClient,
  automationId: string,
  preset: PresetAutomation
): Promise<boolean> {
  const purpose = preset.steps
    .map((s) => (s.step_config as { consent_purpose?: string }).consent_purpose)
    .find((p) => !!p);
  if (!purpose) return false;
  const { data: steps, error: stepsErr } = await db
    .from('automation_steps')
    .select('id, step_config')
    .eq('automation_id', automationId)
    .eq('step_type', 'send_message');
  if (stepsErr) throw new Error(stepsErr.message);
  let changed = false;
  for (const step of (steps ?? []) as { id: string; step_config: Record<string, unknown> | null }[]) {
    const cfg = step.step_config ?? {};
    if (cfg.consent_purpose) continue;
    const { error: upErr } = await db
      .from('automation_steps')
      .update({ step_config: { ...cfg, consent_purpose: purpose } })
      .eq('id', step.id);
    if (upErr) throw new Error(upErr.message);
    changed = true;
  }
  return changed;
}

/**
 * Creates the preset automations the account does not have yet, identified by
 * `preset_key`. Existing ones (even renamed, edited or activated) are left
 * untouched; the unique index turns a concurrent install into a no-op for the
 * loser. Everything is created inactive.
 */
export async function installJourneyPreset(
  db: SupabaseClient,
  args: {
    accountId: string;
    userId: string;
    catalog: JourneyPresetCatalog;
  }
): Promise<InstallResult> {
  const wanted = buildJourneyPreset(args.catalog);

  const { data: present, error: readErr } = await db
    .from('automations')
    .select('id, preset_key')
    .eq('account_id', args.accountId)
    .like('preset_key', `${JOURNEY_PRESET_PREFIX}%`);
  if (readErr) throw new Error(readErr.message);
  const have = new Map(
    ((present ?? []) as { id: string; preset_key: string }[]).map((r) => [
      r.preset_key,
      r.id,
    ])
  );

  const result: InstallResult = { created: [], existing: [], backfilled: [] };
  for (const preset of wanted) {
    if (have.has(preset.preset_key)) {
      result.existing.push(preset.preset_key);
      if (await backfillConsentPurpose(db, have.get(preset.preset_key)!, preset)) {
        result.backfilled.push(preset.preset_key);
      }
      continue;
    }
    const { data: automation, error } = await db
      .from('automations')
      .insert({
        account_id: args.accountId,
        user_id: args.userId,
        preset_key: preset.preset_key,
        name: preset.name,
        description: preset.description,
        trigger_type: preset.trigger_type,
        trigger_config: preset.trigger_config,
        is_active: false,
      })
      .select('id')
      .single();
    if (isUniqueViolation(error)) {
      result.existing.push(preset.preset_key);
      continue;
    }
    if (error || !automation) {
      throw new Error(error?.message ?? 'could not create automation');
    }

    const ids = preset.steps.map(() => crypto.randomUUID());
    const positions = new Map<string, number>();
    const rows = preset.steps.map((seed, i) => {
      const scope = `${seed.parent_index ?? 'root'}:${seed.branch ?? ''}`;
      const position = positions.get(scope) ?? 0;
      positions.set(scope, position + 1);
      return {
        id: ids[i],
        automation_id: (automation as { id: string }).id,
        parent_step_id:
          seed.parent_index == null ? null : ids[seed.parent_index],
        branch: seed.parent_index == null ? null : (seed.branch ?? 'yes'),
        step_type: seed.step_type,
        step_config: seed.step_config,
        position,
      };
    });
    const { error: stepsErr } = await db.from('automation_steps').insert(rows);
    if (stepsErr) {
      // Do not leave a step-less automation: it would count as installed.
      await db
        .from('automations')
        .delete()
        .eq('id', (automation as { id: string }).id);
      throw new Error(stepsErr.message);
    }
    result.created.push(preset.preset_key);
  }
  return result;
}

// ------------------------------------------------------------
// What is still missing
// ------------------------------------------------------------

export interface JourneyPresetStatus {
  /** Preset automations the account has / the preset defines. */
  installed: number;
  total: number;
  /** Installed ones the operator has not turned on yet. */
  inactive: { id: string; name: string }[];
  /** Stores with no `menu_url`: `{{menu_link}}` fails for them. */
  storesWithoutMenuUrl: { id: string; name: string }[];
  /**
   * Send steps without `fallback_template` (outside the 24 h WhatsApp window
   * the send fails visibly), grouped by automation.
   */
  missingFallbackTemplate: { id: string; name: string; steps: number }[];
}

export function summarizeJourneyPreset(input: {
  automations: { id: string; name: string; is_active: boolean }[];
  steps: { automation_id: string; step_type: string; step_config: unknown }[];
  stores: { id: string; name: string; menu_url: string | null }[];
  total: number;
}): JourneyPresetStatus {
  const missing = new Map<string, number>();
  for (const s of input.steps) {
    if (s.step_type !== 'send_message') continue;
    const tpl = (
      s.step_config as { fallback_template?: { name?: string } } | null
    )?.fallback_template;
    if (!tpl?.name?.trim()) {
      missing.set(s.automation_id, (missing.get(s.automation_id) ?? 0) + 1);
    }
  }
  return {
    installed: input.automations.length,
    total: input.total,
    inactive: input.automations
      .filter((a) => !a.is_active)
      .map(({ id, name }) => ({ id, name })),
    storesWithoutMenuUrl: input.stores
      .filter((s) => !s.menu_url?.trim())
      .map(({ id, name }) => ({ id, name })),
    missingFallbackTemplate: input.automations
      .filter((a) => missing.has(a.id))
      .map((a) => ({ id: a.id, name: a.name, steps: missing.get(a.id)! })),
  };
}

export async function loadJourneyPresetStatus(
  db: SupabaseClient,
  accountId: string
): Promise<JourneyPresetStatus> {
  const { data: automations, error } = await db
    .from('automations')
    .select('id, name, is_active')
    .eq('account_id', accountId)
    .like('preset_key', `${JOURNEY_PRESET_PREFIX}%`);
  if (error) throw new Error(error.message);
  const list = (automations ?? []) as {
    id: string;
    name: string;
    is_active: boolean;
  }[];

  let steps: {
    automation_id: string;
    step_type: string;
    step_config: unknown;
  }[] = [];
  if (list.length > 0) {
    const { data, error: stepsErr } = await db
      .from('automation_steps')
      .select('automation_id, step_type, step_config')
      .in(
        'automation_id',
        list.map((a) => a.id)
      );
    if (stepsErr) throw new Error(stepsErr.message);
    steps = data ?? [];
  }

  const { data: stores, error: storesErr } = await db
    .from('stores')
    .select('id, name, menu_url')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true });
  if (storesErr) throw new Error(storesErr.message);

  return summarizeJourneyPreset({
    automations: list,
    steps,
    stores: (stores ?? []) as {
      id: string;
      name: string;
      menu_url: string | null;
    }[],
    total: 3 + ORDER_TRIGGER_STATUSES.length,
  });
}

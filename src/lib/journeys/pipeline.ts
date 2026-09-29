import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import {
  JOURNEY_PIPELINE_KEY,
  JOURNEY_PIPELINE_NAME,
  JOURNEY_STAGES,
  type JourneyStage,
} from './constants';

export interface JourneyPipeline {
  pipelineId: string;
  /** Pipeline stage id per funnel stage key. */
  stageIds: Record<JourneyStage, string>;
}

/**
 * Find the account's "Jornada de Pedido" pipeline and its six stages, creating
 * whatever is missing. Idempotent: the pipeline and each stage carry a stable
 * `system_key` (unique per account / pipeline), so a rename by the operator
 * does not spawn a duplicate and a concurrent creator loses the race cleanly.
 */
export async function ensureJourneyPipeline(
  db: SupabaseClient,
  args: { accountId: string; userId: string }
): Promise<JourneyPipeline> {
  const pipelineId = await ensurePipelineRow(db, args);

  const { data: existing, error } = await db
    .from('pipeline_stages')
    .select('id, system_key')
    .eq('pipeline_id', pipelineId);
  if (error) throw new Error(`journey stages lookup failed: ${error.message}`);
  const byKey = new Map<string, string>();
  for (const s of (existing ?? []) as {
    id: string;
    system_key: string | null;
  }[]) {
    if (s.system_key) byKey.set(s.system_key, s.id);
  }

  for (const [position, stage] of JOURNEY_STAGES.entries()) {
    if (byKey.has(stage.key)) continue;
    const { data, error: insErr } = await db
      .from('pipeline_stages')
      .insert({
        pipeline_id: pipelineId,
        name: stage.name,
        position,
        color: stage.color,
        system_key: stage.key,
      })
      .select('id')
      .single();
    if (insErr && !isUniqueViolation(insErr)) {
      throw new Error(`journey stage creation failed: ${insErr.message}`);
    }
    let id = (data as { id: string } | null)?.id;
    if (!id) {
      const { data: raced } = await db
        .from('pipeline_stages')
        .select('id')
        .eq('pipeline_id', pipelineId)
        .eq('system_key', stage.key)
        .maybeSingle();
      id = (raced as { id: string } | null)?.id;
    }
    if (!id)
      throw new Error(`journey stage '${stage.key}' could not be created`);
    byKey.set(stage.key, id);
  }

  return {
    pipelineId,
    stageIds: Object.fromEntries(byKey) as Record<JourneyStage, string>,
  };
}

async function ensurePipelineRow(
  db: SupabaseClient,
  args: { accountId: string; userId: string }
): Promise<string> {
  const find = async () => {
    const { data, error } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', args.accountId)
      .eq('system_key', JOURNEY_PIPELINE_KEY)
      .maybeSingle();
    if (error)
      throw new Error(`journey pipeline lookup failed: ${error.message}`);
    return (data as { id: string } | null)?.id ?? null;
  };

  const found = await find();
  if (found) return found;

  const { data, error } = await db
    .from('pipelines')
    .insert({
      account_id: args.accountId,
      user_id: args.userId,
      name: JOURNEY_PIPELINE_NAME,
      system_key: JOURNEY_PIPELINE_KEY,
    })
    .select('id')
    .single();
  if (error && !isUniqueViolation(error)) {
    throw new Error(`journey pipeline creation failed: ${error.message}`);
  }
  const id = (data as { id: string } | null)?.id ?? (await find());
  if (!id) throw new Error('journey pipeline could not be created');
  return id;
}

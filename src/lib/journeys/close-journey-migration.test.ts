// Migration 069 is SQL, and the unit tests run on an in-memory fake that has no
// triggers, so what protects it here is (1) this guard on the pieces that make
// it work and (2) supabase/ci/verify-schema.sql, which the CI runs on a replay
// of every migration (it fails when the trigger or SECURITY DEFINER is gone).
// The behaviour itself was exercised against Postgres in a rolled-back
// transaction (see .projects/order-journey-recovery/implementation-notes.md).

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (...p: string[]) =>
  readFileSync(path.join(process.cwd(), ...p), 'utf8');

const sql = read(
  'supabase',
  'migrations',
  '069_close_journey_when_deal_closed.sql'
);

describe('069_close_journey_when_deal_closed', () => {
  it('writes as the owner: agents have no UPDATE policy on journeys', () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = public/);
  });

  it('fires only when the status or the stage of a deal that has a Journey changes', () => {
    expect(sql).toMatch(/AFTER UPDATE OF status, stage_id ON public\.deals/);
    expect(sql).toMatch(/NEW\.journey_id IS NOT NULL/);
    expect(sql).toMatch(/NEW\.status IS DISTINCT FROM OLD\.status/);
    expect(sql).toMatch(/NEW\.stage_id IS DISTINCT FROM OLD\.stage_id/);
  });

  it('closes only an OPEN Journey, with the outcome as state and stage', () => {
    expect(sql).toMatch(/state = v_outcome/);
    expect(sql).toMatch(/stage = v_outcome/);
    expect(sql).toMatch(/closed_at = now\(\)/);
    // the app closes the Journey first and the deal second: never touch a closed one
    expect(sql).toMatch(/AND state = 'open'/);
  });

  it('reads the outcome from the status, or else from the won/lost stage', () => {
    expect(sql).toMatch(/NEW\.status IN \('won', 'lost'\)/);
    expect(sql).toMatch(/s\.system_key IN \('won', 'lost'\)/);
  });

  it('backfills the Journeys that were already stuck open', () => {
    expect(sql).toMatch(/UPDATE public\.journeys j/);
    expect(sql).toMatch(/AND j\.state = 'open'/);
  });

  it('is idempotent (can be re-applied)', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(sql).toMatch(
      /DROP TRIGGER IF EXISTS trg_close_journey_when_deal_closed/
    );
  });

  it('is asserted by the CI schema verification', () => {
    const verify = read('supabase', 'ci', 'verify-schema.sql');
    expect(verify).toContain('trg_close_journey_when_deal_closed');
    expect(verify).toMatch(/prosecdef/);
  });
});

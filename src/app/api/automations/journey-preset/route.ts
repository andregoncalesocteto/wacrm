import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  installJourneyPreset,
  loadJourneyPresetCatalog,
  loadJourneyPresetStatus,
} from '@/lib/automations/journey-preset';

/**
 * GET  /api/automations/journey-preset — what the "Jornada de pedido" preset
 *                                        still needs (any member).
 * POST /api/automations/journey-preset — create the missing preset automations,
 *                                        inactive and idempotent (agent+).
 */

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const status = await loadJourneyPresetStatus(supabase, accountId);
    return NextResponse.json({ status });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST() {
  try {
    // Service-role insert below bypasses RLS, so enforce the role here.
    const { userId, accountId } = await requireRole('agent');
    const db = supabaseAdmin();
    const result = await installJourneyPreset(db, {
      accountId,
      userId,
      catalog: await loadJourneyPresetCatalog(),
    });
    const status = await loadJourneyPresetStatus(db, accountId);
    return NextResponse.json({ ...result, status }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

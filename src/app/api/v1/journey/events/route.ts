// ============================================================
// POST /api/v1/journey/events — the Digital menu reports what a customer
// does (scope: events:write, exclusive to this endpoint).
//
// One event per call. `event_id` is unique per account: a repeat answers
// with the original response and `Idempotent-Replayed: true` and repeats no
// effect. Contract: .projects/order-journey-recovery/prd-menu-events-contract.md
// ============================================================

import { NextResponse } from 'next/server';

import { requireApiKey } from '@/lib/auth/api-context';
import { badRequest, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { processJourneyEvent } from '@/lib/journeys';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'events:write');

    const body = await request.json().catch(() => {
      throw badRequest('Request body must be valid JSON');
    });

    const result = await processJourneyEvent(ctx.supabase, {
      accountId: ctx.accountId,
      body,
      resolveUserId: () => resolveAuditUserId(ctx.supabase, ctx.accountId),
    });

    return NextResponse.json(
      { data: result },
      {
        status: 200,
        headers: result.duplicate
          ? { 'Idempotent-Replayed': 'true' }
          : undefined,
      }
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { journeyFunnel } from '@/lib/journeys';

/**
 * GET /api/journeys/funnel — order Journey conversion funnel of the caller's
 * account, overall and by channel type and store (any member, as for deals).
 * Runs with the caller's RLS-bound client.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    return NextResponse.json(await journeyFunnel(supabase, { accountId }));
  } catch (err) {
    return toErrorResponse(err);
  }
}

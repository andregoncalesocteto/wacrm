import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

// POST /api/contacts/merge { survivor_id, duplicate_id }
//
// Joins two contacts of the same customer: everything hanging off the
// duplicate (conversations, deals, notes, tags, custom values, identities,
// runs, ...) is re-pointed to the survivor and the duplicate is deleted.
// The work is one SQL function (migration 049, merge_contacts) so it is
// atomic; it is callable by service_role only, so the account and role
// checks live here. Responds with the moved counts.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const survivorId = body?.survivor_id;
  const duplicateId = body?.duplicate_id;
  if (
    typeof survivorId !== 'string' ||
    typeof duplicateId !== 'string' ||
    !UUID_RE.test(survivorId) ||
    !UUID_RE.test(duplicateId)
  ) {
    return NextResponse.json(
      { error: 'survivor_id and duplicate_id must be contact ids' },
      { status: 400 }
    );
  }
  if (survivorId === duplicateId) {
    return NextResponse.json(
      { error: 'Choose two different contacts' },
      { status: 400 }
    );
  }

  // Both contacts must be visible to the caller (RLS) AND in their account.
  const { data: found, error: findError } = await ctx.supabase
    .from('contacts')
    .select('id')
    .eq('account_id', ctx.accountId)
    .in('id', [survivorId, duplicateId]);
  if (findError) {
    return NextResponse.json({ error: findError.message }, { status: 500 });
  }
  if ((found ?? []).length !== 2) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin().rpc('merge_contacts', {
    p_account_id: ctx.accountId,
    p_survivor_id: survivorId,
    p_duplicate_id: duplicateId,
  });
  if (error) {
    if (error.message?.includes('contact_not_found')) {
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 });
    }
    console.error('[contacts/merge] rpc failed:', error.message);
    return NextResponse.json(
      { error: 'Could not merge contacts' },
      { status: 500 }
    );
  }

  return NextResponse.json({ survivor_id: survivorId, moved: data });
}

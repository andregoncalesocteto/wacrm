// ============================================================
// Access check for the operator manuals (/settings/manuals/**).
//
// The middleware only proves there is a session (`/settings` is a protected
// prefix). The ROLE is checked here, in the page itself: owner and admin read
// the manual, agents and viewers get a 404, a missing session goes to /login.
// Hiding the rail item is cosmetics; this is the barrier (ADR-003).
//
// First server-rendered page of the dashboard area: it sets the pattern.
// ============================================================

import { notFound, redirect } from 'next/navigation';

import {
  ForbiddenError,
  requireRole,
  UnauthorizedError,
  type AccountContext,
} from '@/lib/auth/account';

export async function requireManualsAccess(): Promise<AccountContext> {
  try {
    return await requireRole('admin');
  } catch (err) {
    if (err instanceof UnauthorizedError) redirect('/login');
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
}

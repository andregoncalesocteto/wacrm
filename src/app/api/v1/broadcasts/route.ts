// ============================================================
// POST /api/v1/broadcasts — launch a template broadcast
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                 // optional label
//     "connection_id": "uuid",              // optional — see below
//     "template_name": "promo_july",        // required, approved template
//     "template_language": "en_US",         // optional (default en_US)
//     "recipients": [                        // required, 1..1000
//       { "to": "+14155550123", "params": ["Jane"] },
//       { "to": "+14155550124" }
//     ]
//   }
//
// `connection_id` (US-004) may be omitted only when the account has
// exactly one active connection — same convention as POST /api/v1/messages'
// addressing. createBroadcast itself always requires a resolved id; this
// route is what supplies the single-connection default so existing callers
// (incl. the MCP server's send_broadcast tool) keep working unchanged.
//
// The broadcast + its recipient rows are persisted synchronously, then
// the Meta fan-out runs in `after()` so the request returns fast. Poll
// `GET /api/v1/broadcasts/{id}` for progress.
//
// Response (202):
//   { "data": { "broadcast_id", "status": "sending",
//               "total_recipients", "accepted", "rejected" } }
// ============================================================

import { after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { requireApiKey } from '@/lib/auth/api-context';
import { listConnectionsByAccount } from '@/lib/channels/connections';

// The `after()` fan-out below sends to every recipient sequentially and
// runs within this route's max duration (the same constraint the
// webhook route documents). Give it headroom beyond the platform
// default so a modest batch isn't cut off mid-send — which would leave
// recipient rows 'pending' and the broadcast stuck 'sending'. This is a
// bound, not a guarantee: a near-cap (MAX_RECIPIENTS) audience can
// still exceed 60s, so very large sends should be split across
// requests. A durable queue/cron drain is the complete fix (follow-up).
export const maxDuration = 60;
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  createBroadcast,
  deliverBroadcast,
  BroadcastError,
} from '@/lib/whatsapp/broadcast-core';

/**
 * Resolve which connection a broadcast sends through. Mirrors
 * POST /api/v1/messages' pickConnection: an explicit id is passed straight
 * through (createBroadcast owns the existence/ownership/disabled checks);
 * omitted, it falls back to the account's one active connection, or a
 * typed error when that's ambiguous or there's nothing to send through.
 */
async function resolveConnectionId(
  db: SupabaseClient,
  accountId: string,
  connectionIdInput: string
): Promise<string> {
  if (connectionIdInput) return connectionIdInput;
  const all = await listConnectionsByAccount(accountId, db);
  const active = all.filter((c) => c.disabled_at == null);
  if (active.length === 1) return active[0].id;
  if (active.length > 1) {
    throw new BroadcastError(
      'connection_required',
      "'connection_id' is required when the account has more than one active connection",
      400
    );
  }
  if (all.length > 0) return all[0].id; // createBroadcast's own check turns this into 409 connection_disabled
  throw new BroadcastError(
    'whatsapp_not_configured',
    'No channel connected. Please set up a connection first.',
    400
  );
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const connectionId = await resolveConnectionId(
      ctx.supabase,
      ctx.accountId,
      typeof body.connection_id === 'string' ? body.connection_id : ''
    );
    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const plan = await createBroadcast(ctx.supabase, ctx.accountId, auditUserId, {
      name: typeof body.name === 'string' ? body.name : null,
      connectionId,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : null,
      recipients: recipients.map((r) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        params: Array.isArray(r?.params) ? r.params : undefined,
      })),
    });

    // Fan out after the response is sent. Uses the same service-role
    // client — no request-scoped auth needed for the Meta calls or
    // the account-scoped row updates.
    after(() => deliverBroadcast(ctx.supabase, plan));

    return ok(
      {
        broadcast_id: plan.broadcastId,
        status: 'sending',
        total_recipients: plan.planned.length,
        accepted: plan.planned.length,
        rejected: plan.rejected,
      },
      202
    );
  } catch (err) {
    if (err instanceof BroadcastError) {
      return fail(err.code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}

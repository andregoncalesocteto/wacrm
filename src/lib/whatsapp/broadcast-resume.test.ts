import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';

import { BroadcastError, deliverBroadcast } from './broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

// Connection resolution now goes through the same generic
// getConnectionById/getConnectionCredentials idiom createBroadcast uses
// (US-004/US-008) — mocked directly, like
// broadcast-core.connection-resolution.test.ts does, rather than faking the
// `channel_connections` query shape.
const h = vi.hoisted(() => ({
  getConnectionById: vi.fn(),
  getConnectionCredentials: vi.fn(),
}));
vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionById: h.getConnectionById,
  getConnectionCredentials: h.getConnectionCredentials,
}));

// Real telegram provider (registered via registerBuiltinProviders inside
// deliverBroadcast) for the Telegram resume test below — only the Bot API
// call at the bottom is stubbed, same as broadcast-core.provider.test.ts.
const tg = vi.hoisted(() => ({ callBotApi: vi.fn() }));
vi.mock('@/lib/channels/providers/telegram/api', () => ({
  callBotApi: tg.callBotApi,
}));

beforeEach(() => {
  h.getConnectionById.mockReset();
  h.getConnectionCredentials.mockReset();
  h.getConnectionById.mockResolvedValue(whatsappConnectionRow('acct-1', 'pn-1'));
  h.getConnectionCredentials.mockResolvedValue({ access_token: 'decrypted:tok' });
});

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );

    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].update.delivery_locked_at).toBe(
      '2026-08-11T12:00:00.000Z',
    );
  });

  it('refuses when another pass already holds the lock', async () => {
    // The UPDATE's WHERE didn't match — someone else got there first.
    const ok = await claimBroadcastDelivery(
      claimDb([], []),
      'acct-1',
      'bc-1',
    );
    expect(ok).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z'),
    );
    // 30 minutes before "now" — a pass whose process died is recoverable
    // without touching the database by hand.
    expect(calls[0].or).toBe(
      'delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:30:00.000Z',
    );
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(claimDb([], calls), 'acct-9', 'bc-1');
    expect(calls[0].filters.account_id).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  templates?: Record<string, unknown>[];
}

interface PlanWrites {
  statusFilter?: unknown;
  failedIds?: unknown;
  failedUpdate?: Record<string, unknown>;
}

function planDb(fx: PlanFixture, writes: PlanWrites = {}): SupabaseClient {
  return {
    from(table: string) {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id') writes.failedIds = vals;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          writes.failedUpdate = row;
          return b;
        },
        maybeSingle: async () => ({
          data: fx.broadcast === undefined ? null : fx.broadcast,
          error: null,
        }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'broadcast_recipients') {
            return resolve({ data: fx.recipients ?? [], error: null });
          }
          if (table === 'message_templates') {
            return resolve({ data: fx.templates ?? [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
  connection_id: 'conn-acct-1',
};

function recipient(
  id: string,
  phone: string | null,
  params: unknown = ['A123'],
) {
  return {
    id,
    contact_id: `c-${id}`,
    template_params: params,
    contact: phone ? { phone } : null,
  };
}

describe('planBroadcastResume', () => {
  it('plans the outstanding recipients with their frozen params', async () => {
    const writes: PlanWrites = {};
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          recipients: [
            recipient('r1', '+15551234567', ['A123', 'Friday']),
            recipient('r2', '+15559876543', ['B456', 'Monday']),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    expect(writes.statusFilter).toEqual(['pending']);
    // Phones are stored sanitized (no leading '+'), same as the shape
    // createBroadcast plans — deliverBroadcast feeds them to
    // phoneVariants from here.
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        contactId: 'c-r1',
        phone: '15551234567',
        params: ['A123', 'Friday'],
      },
      {
        recipientRowId: 'r2',
        contactId: 'c-r2',
        phone: '15559876543',
        params: ['B456', 'Monday'],
      },
    ]);
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    const failedWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          recipients: [recipient('r1', '+15551234567')],
        },
        failedWrites,
      ),
      'acct-1',
      'bc-1',
      'failed',
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          recipients: [recipient('r1', '+15551234567')],
        },
        allWrites,
      ),
      'acct-1',
      'bc-1',
      'all',
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        recipients: [
          // Rows created before migration 038 carry NULL.
          recipient('r1', '+15551234567', null),
          recipient('r2', '+15559876543', 'not-an-array'),
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          recipients: [
            recipient('r1', '+15551234567'),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes,
      ),
      'acct-1',
      'bc-1',
      'pending',
    );

    // Left 'pending', these would keep the broadcast in 'sending'
    // forever — the exact symptom being fixed.
    expect(unsendable).toBe(2);
    expect(writes.failedIds).toEqual(['r2', 'r3']);
    expect(writes.failedUpdate?.status).toBe('failed');
    expect(plan.planned).toHaveLength(1);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0')),
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, recipients: many }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    // Surfaced to the caller rather than silently dropped.
    expect(remaining).toBe(25);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: null }),
        'acct-1',
        'bc-1',
        'pending',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed',
      ),
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('resolves the template row for header + button components', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, template_language: 'en_US' },
        recipients: [recipient('r1', '+15551234567')],
        templates: [
          {
            id: 'tpl-1',
            user_id: 'u-1',
            name: 'order_update',
            // Synced from Meta as bare 'en' — the resolver bridges it.
            language: 'en',
            body_text: 'Your order {{1}} ships on {{2}}',
          },
        ],
      }),
      'acct-1',
      'bc-1',
      'pending',
    );
    expect(plan.templateRow?.language).toBe('en');
  });
});

// ============================================================
// Generic resume — a free-message broadcast on a channel without the
// template capability (US-008: broadcast-resume.ts no longer assumes
// WhatsApp).
// ============================================================

interface TelegramResumeFixture {
  broadcast: Record<string, unknown>;
  recipients: Record<string, unknown>[];
  /** contact_id -> contact_identities rows (US-009: deliverBroadcast's non-template target resolution). */
  identities?: Record<string, { kind: string; external_id: string }[]>;
}

function telegramResumeDb(fx: TelegramResumeFixture) {
  const recipientUpdates: { id: string; patch: Record<string, unknown> }[] =
    [];
  let broadcastUpdate: Record<string, unknown> | null = null;

  const db = {
    from(table: string) {
      if (table === 'broadcasts') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: fx.broadcast, error: null }),
          update: (patch: Record<string, unknown>) => {
            broadcastUpdate = patch;
            return b;
          },
        };
        return b;
      }
      if (table === 'broadcast_recipients') {
        let isCountQuery = false;
        let pendingPatch: Record<string, unknown> | null = null;
        const b: Record<string, unknown> = {
          select: (_cols?: string, opts?: { head?: boolean }) => {
            isCountQuery = !!opts?.head;
            return b;
          },
          eq: (col: string, val: unknown) => {
            if (col === 'id' && pendingPatch) {
              recipientUpdates.push({ id: val as string, patch: pendingPatch });
              pendingPatch = null;
            }
            return b;
          },
          in: () => b,
          order: () => b,
          update: (patch: Record<string, unknown>) => {
            pendingPatch = patch;
            return b;
          },
          then: (resolve: (v: unknown) => void) => {
            if (isCountQuery) return resolve({ count: 0, error: null });
            return resolve({ data: fx.recipients, error: null });
          },
        };
        return b;
      }
      // deliverBroadcast's non-template target resolution (US-009): each
      // recipient's contact_identities, looked up by contact_id.
      if (table === 'contact_identities') {
        let contactId: string | undefined;
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (col: string, val: unknown) => {
            if (col === 'contact_id') contactId = val as string;
            return b;
          },
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: fx.identities?.[contactId ?? ''] ?? [] }),
        };
        return b;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  return {
    db,
    recipientUpdates,
    finalBroadcastUpdate: () => broadcastUpdate,
  };
}

describe('planBroadcastResume + deliverBroadcast — Telegram resume (US-008)', () => {
  it('resumes an abandoned Telegram broadcast: delivers the pending recipients and finalizes the campaign', async () => {
    const telegramConn = {
      ...whatsappConnectionRow('acct-1', '555000111'),
      id: 'conn-tg',
      channel_type: 'telegram',
    };
    h.getConnectionById.mockResolvedValue(telegramConn);
    h.getConnectionCredentials.mockResolvedValue({ bot_token: 'tg-tok' });
    tg.callBotApi
      .mockResolvedValueOnce({ message_id: 10, chat: { id: 555 } })
      .mockResolvedValueOnce({ message_id: 11, chat: { id: 556 } });

    // A free-message broadcast (US-005): no template_name, connection_id
    // already recorded (US-004), some recipients still pending.
    const broadcast = {
      id: 'bc-tg',
      template_name: null,
      template_language: null,
      connection_id: 'conn-tg',
      message_text: 'Hi {{1}}, welcome!',
      message_media_url: null,
    };
    // r2 is an eligible Telegram contact with phone='' — the AC's literal
    // case: it must NOT be dropped as "unsendable" (that phone check is
    // WhatsApp/template-only now) and its target must resolve from
    // contact_identities, not from `contacts.phone` (US-009).
    const recipients = [
      recipient('r1', '+15550001111', ['Maria']),
      { id: 'r2', contact_id: 'c-r2', template_params: ['João'], contact: { phone: '' } },
    ];

    const { db, recipientUpdates, finalBroadcastUpdate } = telegramResumeDb({
      broadcast,
      recipients,
      identities: {
        'c-r1': [{ kind: 'telegram:chat_id', external_id: '555' }],
        'c-r2': [{ kind: 'telegram:chat_id', external_id: '556' }],
      },
    });

    const { plan } = await planBroadcastResume(db, 'acct-1', 'bc-tg', 'pending');

    // resolveTemplateRow was never called (no message_templates table wired
    // into telegramResumeDb — it would throw "unexpected table" if it had
    // been), matching the AC: only called when template_name IS NOT NULL.
    expect(plan.templateName).toBe('');
    expect(plan.templateRow).toBeNull();
    expect(plan.messageText).toBe('Hi {{1}}, welcome!');
    expect(plan.connection.channel_type).toBe('telegram');

    await deliverBroadcast(db, plan);

    expect(tg.callBotApi).toHaveBeenCalledTimes(2);
    // r2's chat_id came from contact_identities (its resolved target), not
    // from `contacts.phone` — which was '' and would otherwise fail to
    // resolve anything (US-009).
    expect(tg.callBotApi).toHaveBeenCalledWith(
      'tg-tok',
      'sendMessage',
      expect.objectContaining({ chat_id: '556' })
    );
    expect(recipientUpdates).toContainEqual({
      id: 'r1',
      patch: expect.objectContaining({
        status: 'sent',
        external_message_id: '555:10',
      }),
    });
    expect(recipientUpdates).toContainEqual({
      id: 'r2',
      patch: expect.objectContaining({
        status: 'sent',
        external_message_id: '556:11',
      }),
    });

    // deliverBroadcast finalizes in-line (finalizeBroadcastStatus, called
    // once every recipient is stamped) — the campaign flips out of
    // 'sending' rather than being left abandoned again.
    expect(finalBroadcastUpdate()).toMatchObject({ status: 'sent' });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { deliverBroadcast, type BroadcastPlan } from './broadcast-core';
import { NO_MARKETING_CONSENT_ERROR } from '@/lib/consent/consent';

const h = vi.hoisted(() => ({
  getCredentials: vi.fn(),
  sendTemplateMessage: vi.fn(),
  contactsWithConsent: vi.fn(),
}));

vi.mock('@/lib/consent/consent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  contactsWithConsent: h.contactsWithConsent,
}));
vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionCredentials: h.getCredentials,
}));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: h.sendTemplateMessage,
}));

function fakeDb() {
  const updates: { table: string; patch: unknown; id?: unknown }[] = [];
  const db = {
    from(table: string) {
      let patch: unknown;
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) => resolve({ count: 0 }),
        update(p: unknown) {
          patch = p;
          return chain;
        },
        eq(_c: string, id: unknown) {
          if (patch) updates.push({ table, patch, id });
          return chain;
        },
        select: () => chain,
      };
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

const plan = {
  broadcastId: 'bc-1',
  templateName: 'promo',
  templateLanguage: 'pt_BR',
  templateRow: null,
  connection: {
    id: 'conn-1',
    account_id: 'acct-1',
    channel_type: 'whatsapp_cloud',
    external_id: 'PNID-1',
  },
  planned: ['ok', 'revoked', 'menu-only'].map((c, i) => ({
    recipientRowId: `r-${c}`,
    contactId: c,
    phone: `+55119999000${i}`,
    params: [],
  })),
} as unknown as BroadcastPlan;

beforeEach(() => {
  h.getCredentials.mockResolvedValue({ access_token: 'tok' });
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
  h.contactsWithConsent.mockResolvedValue(new Set(['ok']));
});

describe('deliverBroadcast consent gate', () => {
  it('sends only to contacts with marketing consent on the broadcast connection, in one batch', async () => {
    const { db } = fakeDb();
    await deliverBroadcast(db, plan);

    expect(h.contactsWithConsent).toHaveBeenCalledTimes(1);
    expect(h.contactsWithConsent).toHaveBeenCalledWith(
      db,
      'acct-1',
      ['ok', 'revoked', 'menu-only'],
      'marketing',
      { connectionId: 'conn-1' }
    );
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it('stamps the skipped rows with the reason and returns their count, without failing the batch', async () => {
    const { db, updates } = fakeDb();
    const r = await deliverBroadcast(db, plan);

    expect(r).toEqual({ skippedNoConsent: 2 });
    const skipped = updates.filter(
      (u) =>
        (u.patch as { error_message?: string }).error_message ===
        NO_MARKETING_CONSENT_ERROR
    );
    expect(skipped.map((u) => u.id).sort()).toEqual([
      'r-menu-only',
      'r-revoked',
    ]);
    expect(
      updates.some(
        (u) =>
          u.id === 'r-ok' && (u.patch as { status?: string }).status === 'sent'
      )
    ).toBe(true);
  });

  it('sends nothing when nobody has consent', async () => {
    h.contactsWithConsent.mockResolvedValue(new Set());
    const { db } = fakeDb();
    const r = await deliverBroadcast(db, plan);
    expect(r).toEqual({ skippedNoConsent: 3 });
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });
});

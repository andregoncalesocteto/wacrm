import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { whatsappConnectionRow } from './credentials-admin.fake';
import {
  loadWhatsAppSendConnection,
  resolveWhatsAppConnection,
} from './whatsapp-connection';

const h = vi.hoisted(() => ({ credentials: null as unknown }));

vi.mock('./admin-client', async () => {
  const { fakeCredentialsAdmin } = await import('./credentials-admin.fake');
  return {
    supabaseAdmin: () =>
      fakeCredentialsAdmin(
        () =>
          h.credentials as {
            secrets_encrypted: string;
            secrets_format: string;
          } | null
      ),
  };
});
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `dec:${v}`,
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}));

const A = whatsappConnectionRow('acct-1', 'pn-A', { id: 'conn-A' });
const B = whatsappConnectionRow('acct-1', 'pn-B', { id: 'conn-B' });
const TG = whatsappConnectionRow('acct-1', 'tg-1', {
  id: 'conn-TG',
  channel_type: 'telegram_bot',
});
const OTHER = whatsappConnectionRow('acct-2', 'pn-X', { id: 'conn-X' });

function fakeDb(
  connections: Record<string, unknown>[],
  conversationConnectionId: string | null = null
) {
  return {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const b: Record<string, unknown> = {
        select: () => b,
        order: () => b,
        eq: (c: string, v: unknown) => (filters.push([c, v]), b),
        maybeSingle: async () => {
          if (table === 'conversations') {
            return {
              data: { connection_id: conversationConnectionId },
              error: null,
            };
          }
          const id = filters.find(([c]) => c === 'id')?.[1];
          return {
            data: connections.find((c) => c.id === id) ?? null,
            error: null,
          };
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: connections.filter((c) =>
              filters.every(([col, v]) => c[col] === v)
            ),
            error: null,
          }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('resolveWhatsAppConnection', () => {
  it('prefers the connection_id it is given', async () => {
    const c = await resolveWhatsAppConnection(fakeDb([A, B]), 'acct-1', {
      connectionId: 'conn-B',
    });
    expect(c?.id).toBe('conn-B');
  });

  it("reads the conversation's connection_id when only the conversation is known", async () => {
    const c = await resolveWhatsAppConnection(
      fakeDb([A, B], 'conn-B'),
      'acct-1',
      {
        conversationId: 'cv-1',
      }
    );
    expect(c?.id).toBe('conn-B');
  });

  it('falls back to the enabled account connection when connection_id is null', async () => {
    const disabled = { ...A, disabled_at: '2026-01-01T00:00:00Z' };
    const c = await resolveWhatsAppConnection(fakeDb([disabled, B]), 'acct-1', {
      conversationId: 'cv-1',
    });
    expect(c?.id).toBe('conn-B');
  });

  it('ignores a connection of another channel or account and falls back', async () => {
    expect(
      (
        await resolveWhatsAppConnection(fakeDb([TG, A]), 'acct-1', {
          connectionId: 'conn-TG',
        })
      )?.id
    ).toBe('conn-A');
    expect(
      (
        await resolveWhatsAppConnection(fakeDb([OTHER, A]), 'acct-1', {
          connectionId: 'conn-X',
        })
      )?.id
    ).toBe('conn-A');
  });

  it('returns null when the account has no WhatsApp connection', async () => {
    expect(await resolveWhatsAppConnection(fakeDb([TG]), 'acct-1')).toBeNull();
  });
});

describe('loadWhatsAppSendConnection', () => {
  it('returns phone_number_id (external_id) and the decrypted token', async () => {
    h.credentials = {
      secrets_encrypted: 'cipher',
      secrets_format: 'wa_token_v0',
    };
    const r = await loadWhatsAppSendConnection(fakeDb([A]), 'acct-1');
    expect(r).toMatchObject({
      phoneNumberId: 'pn-A',
      accessToken: 'dec:cipher',
    });
  });

  it('returns null without credentials or without a connection', async () => {
    h.credentials = null;
    expect(await loadWhatsAppSendConnection(fakeDb([A]), 'acct-1')).toBeNull();
    expect(await loadWhatsAppSendConnection(fakeDb([]), 'acct-1')).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// US-078: a reaction through a disabled connection is refused (409,
// connection_disabled) before Meta is called and before anything is mirrored.

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadConn: vi.fn(),
  sendReactionMessage: vi.fn(),
  writes: [] as string[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: () => Response.json({ error: 'x' }, { status: 500 }),
}));
vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendReactionMessage: h.sendReactionMessage,
}));
vi.mock('@/lib/channels/whatsapp-connection', () => ({
  loadWhatsAppSendConnection: h.loadConn,
}));

import { POST } from './route';

function supabase() {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = chain;
      b.eq = chain;
      b.maybeSingle = async () =>
        table === 'messages'
          ? {
              data: { id: 'm1', message_id: 'wamid.1', conversation_id: 'cv1' },
              error: null,
            }
          : {
              data: {
                id: 'cv1',
                account_id: 'acct-1',
                connection_id: 'conn-1',
                contact: { phone: '15551234567', wa_user_id: null },
              },
              error: null,
            };
      b.upsert = async () => {
        h.writes.push(`${table}:upsert`);
        return { error: null };
      };
      b.delete = () => {
        h.writes.push(`${table}:delete`);
        return b;
      };
      return b;
    },
  };
}

beforeEach(() => {
  h.writes = [];
  h.sendReactionMessage.mockReset().mockResolvedValue({ messageId: 'x' });
  h.requireRole.mockResolvedValue({
    supabase: supabase(),
    accountId: 'acct-1',
    userId: `user-${Math.random()}`,
  });
});

const react = () =>
  POST(
    new Request('http://x/api/whatsapp/react', {
      method: 'POST',
      body: JSON.stringify({ message_id: 'm1', emoji: '👍' }),
    })
  );

describe('POST /api/whatsapp/react', () => {
  it('409s connection_disabled, never calls Meta and mirrors nothing', async () => {
    h.loadConn.mockResolvedValue({
      connection: { id: 'conn-1', disabled_at: '2026-09-01T00:00:00Z' },
      phoneNumberId: 'PNID-1',
      accessToken: 'tok',
    });
    const res = await react();
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('connection_disabled');
    expect(h.sendReactionMessage).not.toHaveBeenCalled();
    expect(h.writes).toHaveLength(0);
  });

  it('still reacts through an enabled connection', async () => {
    h.loadConn.mockResolvedValue({
      connection: { id: 'conn-1', disabled_at: null },
      phoneNumberId: 'PNID-1',
      accessToken: 'tok',
    });
    const res = await react();
    expect(res.status).toBe(200);
    expect(h.sendReactionMessage).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual(['message_reactions:upsert']);
  });
});

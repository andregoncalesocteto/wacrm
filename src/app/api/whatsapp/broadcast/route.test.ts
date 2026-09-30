import { beforeEach, describe, expect, it, vi } from 'vitest';

// Characterization of POST /api/whatsapp/broadcast (dashboard route): request
// shapes, HTTP responses and per-recipient result semantics that
// use-broadcast-sending.ts relies on. Meta/Telegram are mocked at their
// respective API modules; the connection is resolved generically (US-013),
// same idiom as createBroadcast/deliverBroadcast (US-004/US-009).

import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';

const h = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(),
  callBotApi: vi.fn(),
  requireRole: vi.fn(),
  getConnectionById: vi.fn(),
  getConnectionCredentials: vi.fn(),
  resolveTemplateRow: vi.fn(),
  contactsWithConsent: vi.fn(),
}));

vi.mock('@/lib/consent/consent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  contactsWithConsent: h.contactsWithConsent,
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: h.sendTemplateMessage,
}));
vi.mock('@/lib/channels/providers/telegram/api', () => ({
  callBotApi: h.callBotApi,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: unknown) =>
    Response.json(
      { error: e instanceof Error ? e.message : 'x' },
      { status: e instanceof Error && e.message === 'Forbidden' ? 403 : 500 }
    ),
}));
vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionById: h.getConnectionById,
  getConnectionCredentials: h.getConnectionCredentials,
}));
vi.mock('@/lib/whatsapp/template-body', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/template-body')>()),
  resolveTemplateRow: h.resolveTemplateRow,
}));
// contact_id -> contact_identities rows for the non-template target
// resolution (loadRecipientIdentities, reused from broadcast-core.ts).
const IDENTITIES: Record<string, { kind: string; external_id: string }[]> = {
  c1: [{ kind: 'telegram:chat_id', external_id: '555' }],
  c2: [{ kind: 'telegram:chat_id', external_id: '556' }],
};
// contacts of the account found by normalized phone (legacy phone-only shape).
const LEGACY_CONTACTS = [
  { id: 'L1', phone_normalized: '5511999990000' },
  { id: 'L2', phone_normalized: '5511888880000' },
];
function fakeSupabase() {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = { select: () => chain };
      let contactId: string | undefined;
      chain.eq = (col: string, val: unknown) => {
        if (table === 'contact_identities' && col === 'contact_id') {
          contactId = val as string;
        }
        return chain;
      };
      chain.in = () => chain;
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({
          data:
            table === 'contacts'
              ? LEGACY_CONTACTS
              : (IDENTITIES[contactId ?? ''] ?? []),
        });
      return chain;
    },
  };
}

import { POST } from './route';

const WA_CONNECTION = whatsappConnectionRow('acct-1', 'PNID-1', { id: 'conn-1' });
const TG_CONNECTION = whatsappConnectionRow('acct-1', '123456', {
  id: 'conn-tg',
  channel_type: 'telegram',
});
let userSeq = 0;

function req(body: unknown) {
  return new Request('http://x/api/whatsapp/broadcast', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  userSeq++;
  h.requireRole.mockResolvedValue({
    supabase: fakeSupabase(),
    accountId: 'acct-1',
    userId: `user-${userSeq}`,
  });
  h.getConnectionById.mockResolvedValue(WA_CONNECTION);
  h.getConnectionCredentials.mockResolvedValue({ access_token: 'tok' });
  h.resolveTemplateRow.mockResolvedValue({
    row: { name: 'promo' },
    language: 'pt_BR',
    malformed: false,
  });
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
  h.callBotApi.mockResolvedValue({ message_id: 999, chat: { id: 555 } });
  // Everyone has consent unless a test says otherwise.
  h.contactsWithConsent.mockImplementation(
    async (_db: unknown, _acct: string, ids: string[]) => new Set(ids)
  );
});

describe('POST /api/whatsapp/broadcast', () => {
  it('400s without recipients or phone_numbers', async () => {
    const res = await POST(
      req({ connection_id: 'conn-1', template_name: 'promo' })
    );
    expect(res.status).toBe(400);
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('400s connection_id_required when missing', async () => {
    const res = await POST(
      req({
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('connection_id_required');
  });

  it('400s content_required without template_name or message content', async () => {
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
      })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('content_required');
  });

  it('400s content_required when both template and message content are sent', async () => {
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
        template_name: 'promo',
        message_text: 'hi',
      })
    );
    expect((await res.json()).code).toBe('content_required');
  });

  it('404s when the connection does not exist / belongs to another account', async () => {
    h.getConnectionById.mockResolvedValue(null);
    const res = await POST(
      req({
        connection_id: 'conn-missing',
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.code).toBe('not_found');
  });

  it('400s connection_channel_mismatch when a template is sent to a non-template connection', async () => {
    h.getConnectionById.mockResolvedValue(TG_CONNECTION);
    const res = await POST(
      req({
        connection_id: 'conn-tg',
        recipients: [{ phone: '', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('connection_channel_mismatch');
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('500s on a malformed local template row', async () => {
    h.resolveTemplateRow.mockResolvedValue({ malformed: true });
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    expect(res.status).toBe(500);
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('propagates a role failure', async () => {
    h.requireRole.mockRejectedValue(new Error('Forbidden'));
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    expect(res.status).toBe(403);
  });

  it('sends per-recipient params and reports sent results', async () => {
    h.sendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid.A' })
      .mockResolvedValueOnce({ messageId: 'wamid.B' });
    const mp = { headerText: 'H' };
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [
          { phone: '+5511999990000', contact_id: 'c1', params: ['Ana'] },
          { phone: '5511888880000', contact_id: 'c2', messageParams: mp },
        ],
        template_name: 'promo',
        template_language: 'pt_BR',
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      total: 2,
      sent: 2,
      failed: 0,
      skipped_no_consent: 0,
      results: [
        {
          contact_id: 'c1',
          phone: '+5511999990000',
          status: 'sent',
          external_message_id: 'wamid.A',
        },
        {
          contact_id: 'c2',
          phone: '5511888880000',
          status: 'sent',
          external_message_id: 'wamid.B',
        },
      ],
    });
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(h.sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      phoneNumberId: 'PNID-1',
      accessToken: 'tok',
      to: '5511999990000',
      templateName: 'promo',
      language: 'pt_BR',
      template: { name: 'promo' },
      params: ['Ana'],
    });
    expect(h.sendTemplateMessage.mock.calls[1][0]).toMatchObject({
      to: '5511888880000',
      messageParams: mp,
      params: [],
    });
  });

  it('legacy shape shares template_params across phones', async () => {
    const res = await POST(
      req({
        connection_id: 'conn-1',
        phone_numbers: ['+5511999990000', '+5511888880000'],
        template_params: ['X'],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(json.sent).toBe(2);
    for (const c of h.sendTemplateMessage.mock.calls) {
      expect(c[0].params).toEqual(['X']);
    }
  });

  it('skips recipients without marketing consent on the connection, in one batch, and reports the count', async () => {
    h.contactsWithConsent.mockResolvedValue(new Set(['c1']));
    h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.A' });
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [
          { phone: '+5511999990000', contact_id: 'c1' },
          { phone: '+5511888880000', contact_id: 'c2' },
        ],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(json).toMatchObject({
      total: 2,
      sent: 1,
      failed: 1,
      skipped_no_consent: 1,
    });
    expect(json.results[1]).toEqual({
      contact_id: 'c2',
      phone: '+5511888880000',
      status: 'failed',
      error: 'Skipped: no marketing consent',
    });
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(h.contactsWithConsent).toHaveBeenCalledTimes(1);
    expect(h.contactsWithConsent.mock.calls[0].slice(1)).toEqual([
      'acct-1',
      ['c1', 'c2'],
      'marketing',
      { connectionId: 'conn-1' },
    ]);
  });

  it('a legacy phone-only recipient with no contact has no consent to show', async () => {
    const res = await POST(
      req({
        connection_id: 'conn-1',
        phone_numbers: ['+5599000000000'],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(json).toMatchObject({ sent: 0, skipped_no_consent: 1 });
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('marks an invalid phone as failed without calling Meta', async () => {
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [{ phone: 'abc', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(json.results).toEqual([
      {
        contact_id: 'c1',
        phone: 'abc',
        status: 'failed',
        error: 'Invalid phone number format',
      },
    ]);
    expect(json).toMatchObject({ total: 1, sent: 0, failed: 1 });
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('a failure on one recipient does not abort the others; error text is Meta message', async () => {
    h.sendTemplateMessage
      .mockRejectedValueOnce(new Error('Template paused'))
      .mockResolvedValueOnce({ messageId: 'wamid.OK' });
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [
          { phone: '+5511999990000', contact_id: 'c1' },
          { phone: '+5511888880000', contact_id: 'c2' },
        ],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(json).toMatchObject({ total: 2, sent: 1, failed: 1 });
    expect(json.results[0]).toEqual({
      contact_id: 'c1',
      phone: '+5511999990000',
      status: 'failed',
      error: 'Template paused',
    });
    expect(json.results[1].status).toBe('sent');
  });

  it('maps a non-Error rejection to "Unknown error"', async () => {
    h.sendTemplateMessage.mockRejectedValueOnce('boom');
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    expect((await res.json()).results[0].error).toBe('Unknown error');
  });

  it('retries the next phone variant only on "recipient not allowed"', async () => {
    h.sendTemplateMessage
      .mockRejectedValueOnce(
        new Error('(#131030) Recipient phone number not in allowed list')
      )
      .mockResolvedValueOnce({ messageId: 'wamid.V2' });
    const res = await POST(
      req({
        connection_id: 'conn-1',
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(json.results[0]).toEqual({
      contact_id: 'c1',
      phone: '+5511999990000',
      status: 'sent',
      external_message_id: 'wamid.V2',
    });
    const tos = h.sendTemplateMessage.mock.calls.map((c) => c[0].to);
    expect(tos).toHaveLength(2);
    expect(tos[0]).not.toBe(tos[1]);
  });

  it('does not retry variants on other errors', async () => {
    h.sendTemplateMessage.mockRejectedValue(new Error('Invalid parameter'));
    await POST(
      req({
        connection_id: 'conn-1',
        recipients: [{ phone: '+5511999990000', contact_id: 'c1' }],
        template_name: 'promo',
      })
    );
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/whatsapp/broadcast disabled connection (US-078)', () => {
  it('409s connection_disabled before any send', async () => {
    h.getConnectionById.mockResolvedValue({
      ...WA_CONNECTION,
      disabled_at: '2026-09-01T00:00:00Z',
    });
    const res = await POST(
      req({
        connection_id: 'conn-1',
        template_name: 'promo',
        recipients: [{ phone: '+15551234567', contact_id: 'c1', params: [] }],
      })
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('connection_disabled');
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });
});

describe('POST /api/whatsapp/broadcast free-message content (US-013)', () => {
  beforeEach(() => {
    h.getConnectionById.mockResolvedValue(TG_CONNECTION);
    h.getConnectionCredentials.mockResolvedValue({ bot_token: 'tg-tok' });
  });

  it('sends free text to a non-template connection, resolving the target by identity, not phone', async () => {
    const res = await POST(
      req({
        connection_id: 'conn-tg',
        recipients: [
          { phone: '', contact_id: 'c1', params: ['Maria'] },
        ],
        message_text: 'Hi {{1}}, welcome!',
      })
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.results).toEqual([
      {
        contact_id: 'c1',
        phone: '',
        status: 'sent',
        external_message_id: '555:999',
      },
    ]);
    expect(h.callBotApi).toHaveBeenCalledTimes(1);
    const [, method, params] = h.callBotApi.mock.calls[0];
    expect(method).toBe('sendMessage');
    expect(params).toMatchObject({ chat_id: '555', text: 'Hi Maria, welcome!' });
  });

  it('fails a recipient with no reachable identity without aborting the others', async () => {
    const res = await POST(
      req({
        connection_id: 'conn-tg',
        recipients: [
          { phone: '', contact_id: 'no-identity' },
          { phone: '', contact_id: 'c2' },
        ],
        message_text: 'Hello!',
      })
    );
    const json = await res.json();
    expect(json).toMatchObject({ total: 2, sent: 1, failed: 1 });
    expect(json.results[0]).toEqual({
      contact_id: 'no-identity',
      phone: '',
      status: 'failed',
      error: 'No reachable address on this channel',
    });
    expect(json.results[1].status).toBe('sent');
    expect(h.callBotApi).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Characterization of POST /api/whatsapp/broadcast (dashboard route): request
// shapes, HTTP responses and per-recipient result semantics that
// use-broadcast-sending.ts relies on. Meta is mocked at meta-api.

const h = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(),
  requireRole: vi.fn(),
  loadConn: vi.fn(),
  resolveTemplateRow: vi.fn(),
  getCredentials: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whatsapp/meta-api')>()),
  sendTemplateMessage: h.sendTemplateMessage,
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.requireRole,
  toErrorResponse: (e: unknown) =>
    Response.json(
      { error: e instanceof Error ? e.message : 'x' },
      { status: e instanceof Error && e.message === 'Forbidden' ? 403 : 500 }
    ),
}));
vi.mock('@/lib/channels/whatsapp-connection', () => ({
  loadWhatsAppSendConnection: h.loadConn,
}));
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: h.resolveTemplateRow,
}));
vi.mock('@/lib/channels/connections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channels/connections')>()),
  getConnectionCredentials: h.getCredentials,
}));

import { POST } from './route';

const CONNECTION = {
  id: 'conn-1',
  account_id: 'acct-1',
  channel_type: 'whatsapp_cloud',
  external_id: 'PNID-1',
};
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
    supabase: {},
    accountId: 'acct-1',
    userId: `user-${userSeq}`,
  });
  h.loadConn.mockResolvedValue({
    connection: CONNECTION,
    phoneNumberId: 'PNID-1',
    accessToken: 'tok',
  });
  h.resolveTemplateRow.mockResolvedValue({
    row: { name: 'promo' },
    language: 'pt_BR',
    malformed: false,
  });
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.1' });
});

describe('POST /api/whatsapp/broadcast', () => {
  it('400s without recipients or phone_numbers', async () => {
    const res = await POST(req({ template_name: 'promo' }));
    expect(res.status).toBe(400);
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('400s without template_name', async () => {
    const res = await POST(req({ recipients: [{ phone: '+5511999990000' }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('template_name is required');
  });

  it('400s when WhatsApp is not configured', async () => {
    h.loadConn.mockResolvedValue(null);
    const res = await POST(
      req({ recipients: [{ phone: '+5511999990000' }], template_name: 'promo' })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/WhatsApp not configured/);
  });

  it('500s on a malformed local template row', async () => {
    h.resolveTemplateRow.mockResolvedValue({ malformed: true });
    const res = await POST(
      req({ recipients: [{ phone: '+5511999990000' }], template_name: 'promo' })
    );
    expect(res.status).toBe(500);
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('propagates a role failure', async () => {
    h.requireRole.mockRejectedValue(new Error('Forbidden'));
    const res = await POST(
      req({ recipients: [{ phone: '+5511999990000' }], template_name: 'promo' })
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
        recipients: [
          { phone: '+5511999990000', params: ['Ana'] },
          { phone: '5511888880000', messageParams: mp },
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
      results: [
        {
          phone: '+5511999990000',
          status: 'sent',
          whatsapp_message_id: 'wamid.A',
        },
        {
          phone: '5511888880000',
          status: 'sent',
          whatsapp_message_id: 'wamid.B',
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

  it('marks an invalid phone as failed without calling Meta', async () => {
    const res = await POST(
      req({ recipients: [{ phone: 'abc' }], template_name: 'promo' })
    );
    const json = await res.json();
    expect(json.results).toEqual([
      { phone: 'abc', status: 'failed', error: 'Invalid phone number format' },
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
        recipients: [{ phone: '+5511999990000' }, { phone: '+5511888880000' }],
        template_name: 'promo',
      })
    );
    const json = await res.json();
    expect(json).toMatchObject({ total: 2, sent: 1, failed: 1 });
    expect(json.results[0]).toEqual({
      phone: '+5511999990000',
      status: 'failed',
      error: 'Template paused',
    });
    expect(json.results[1].status).toBe('sent');
  });

  it('maps a non-Error rejection to "Unknown error"', async () => {
    h.sendTemplateMessage.mockRejectedValueOnce('boom');
    const res = await POST(
      req({ recipients: [{ phone: '+5511999990000' }], template_name: 'promo' })
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
      req({ recipients: [{ phone: '+5511999990000' }], template_name: 'promo' })
    );
    const json = await res.json();
    expect(json.results[0]).toEqual({
      phone: '+5511999990000',
      status: 'sent',
      whatsapp_message_id: 'wamid.V2',
    });
    const tos = h.sendTemplateMessage.mock.calls.map((c) => c[0].to);
    expect(tos).toHaveLength(2);
    expect(tos[0]).not.toBe(tos[1]);
  });

  it('does not retry variants on other errors', async () => {
    h.sendTemplateMessage.mockRejectedValue(new Error('Invalid parameter'));
    await POST(
      req({ recipients: [{ phone: '+5511999990000' }], template_name: 'promo' })
    );
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/whatsapp/broadcast disabled connection (US-078)', () => {
  it('409s connection_disabled before any send', async () => {
    h.loadConn.mockResolvedValue({
      connection: { ...CONNECTION, disabled_at: '2026-09-01T00:00:00Z' },
      phoneNumberId: 'PNID-1',
      accessToken: 'tok',
    });
    const res = await POST(
      req({
        template_name: 'promo',
        recipients: [{ phone: '+15551234567', params: [] }],
      })
    );
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('connection_disabled');
    expect(h.sendTemplateMessage).not.toHaveBeenCalled();
  });
});

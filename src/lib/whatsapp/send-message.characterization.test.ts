/**
 * Characterization tests for the WhatsApp outbound send core (US-003,
 * channel-abstraction). They pin the CURRENT observable behaviour of
 * `sendMessageToConversation` so the later refactor to a provider contract
 * cannot change it: phone-variant retry, BSUID fallback, what is persisted
 * per message type, the conversation update and the flow pause.
 *
 * Complements `send-message.test.ts` (validation, template body, BSUID
 * basics) without duplicating it. Only the Meta HTTP senders are stubbed;
 * the recipient resolution, phone variants and template resolution are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';
import { phoneVariants } from './phone-utils';
import { sendMessageToConversation, SendMessageError } from './send-message';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  seq: 0,
  flowPauses: [] as { patch: Row; filters: [string, unknown][] }[],
  flowPauseError: null as { message: string } | null,
  flowPauseThrows: false,
  insertError: null as { message: string } | null,
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: h.sendTextMessage,
  sendTemplateMessage: h.sendTemplateMessage,
  sendMediaMessage: h.sendMediaMessage,
  sendInteractiveButtons: h.sendInteractiveButtons,
  sendInteractiveList: h.sendInteractiveList,
}));

vi.mock('@/lib/channels/admin-client', async () => {
  const { fakeCredentialsAdmin } =
    await import('@/lib/channels/credentials-admin.fake');
  return {
    supabaseAdmin: () =>
      fakeCredentialsAdmin(
        () =>
          (h.db.channel_connection_credentials?.[0] as {
            secrets_encrypted: string;
            secrets_format: string;
          }) ?? null
      ),
  };
});

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `dec:${v}`,
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}));

// The best-effort "pause active flow run" write goes through the
// service-role client; record what it is asked to update.
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (h.flowPauseThrows) throw new Error('admin client exploded');
      const call = {
        table,
        patch: {} as Row,
        filters: [] as [string, unknown][],
      };
      const b: Record<string, unknown> = {
        update: (patch: Row) => {
          call.patch = patch;
          return b;
        },
        eq: (col: string, v: unknown) => {
          call.filters.push([col, v]);
          if (call.filters.length === 3) {
            h.flowPauses.push({ patch: call.patch, filters: call.filters });
            return Promise.resolve({ error: h.flowPauseError });
          }
          return b;
        },
      };
      return b;
    },
  }),
}));

// ---- Stateful fake of the supabase-js builder (user client) -------------

function fakeDb(): SupabaseClient {
  class Query {
    private op: 'select' | 'insert' | 'update' = 'select';
    private payload: Row = {};
    private filters: ((r: Row) => boolean)[] = [];
    private mode: 'many' | 'maybe' | 'single' = 'many';
    constructor(private table: string) {}
    select() {
      return this;
    }
    insert(row: Row) {
      this.op = 'insert';
      this.payload = row;
      return this;
    }
    update(patch: Row) {
      this.op = 'update';
      this.payload = patch;
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push((r) => r[col] === v);
      return this;
    }
    order() {
      return this;
    }
    maybeSingle() {
      this.mode = 'maybe';
      return this;
    }
    single() {
      this.mode = 'single';
      return this;
    }
    private run() {
      const rows = (h.db[this.table] ??= []);
      let out: Row[];
      if (this.op === 'insert') {
        if (h.insertError && this.table === 'messages') {
          return { data: null, error: h.insertError };
        }
        const row = { id: `${this.table}-${++h.seq}`, ...this.payload };
        rows.push(row);
        out = [row];
      } else if (this.op === 'update') {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
        for (const r of out) Object.assign(r, this.payload);
      } else {
        out = rows.filter((r) => this.filters.every((f) => f(r)));
        if (this.table === 'conversations') {
          // Embed the contact like `select('*, contact:contacts(*)')`.
          out = out.map((c) => ({
            ...c,
            contact: (h.db.contacts ?? []).find((k) => k.id === c.contact_id),
          }));
        }
      }
      if (this.mode === 'many') return { data: out, error: null };
      if (this.mode === 'single' && !out[0]) {
        return { data: null, error: { message: 'no rows' } };
      }
      return { data: out[0] ?? null, error: null };
    }
    then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }
  return { from: (t: string) => new Query(t) } as unknown as SupabaseClient;
}

const PHONE = '+15551234567';
const BSUID = 'US.13491208655302741918';
const NOT_ALLOWED = '(#131030) Recipient phone number not in allowed list';

function seed(contact: Row = { phone: PHONE }, extra: Row = {}) {
  h.db = {
    contacts: [{ id: 'ct-1', account_id: 'acct-1', ...contact }],
    contact_identities: [],
    conversations: [
      {
        id: 'cv-1',
        account_id: 'acct-1',
        contact_id: 'ct-1',
        last_message_text: 'old',
        last_message_at: '2020-01-01T00:00:00Z',
        ...extra,
      },
    ],
    channel_connections: [whatsappConnectionRow('acct-1', 'pn-1')],
    channel_connection_credentials: [
      { secrets_encrypted: 'cipher', secrets_format: 'wa_token_v0' },
    ],
    messages: [],
    message_templates: [],
  };
}

/** BSUID reachability now lives on `contact_identities`, not a contact column. */
function seedBsuidIdentity(bsuid: string) {
  h.db.contact_identities = [
    {
      id: 'id-1',
      account_id: 'acct-1',
      contact_id: 'ct-1',
      kind: 'whatsapp:bsuid',
      external_id: bsuid,
    },
  ];
}

const send = (params: Parameters<typeof sendMessageToConversation>[2]) =>
  sendMessageToConversation(fakeDb(), 'acct-1', params);

beforeEach(() => {
  h.seq = 0;
  h.flowPauses = [];
  h.flowPauseError = null;
  h.flowPauseThrows = false;
  h.insertError = null;
  h.sendTextMessage.mockResolvedValue({ messageId: 'wamid.text' });
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.tpl' });
  h.sendMediaMessage.mockResolvedValue({ messageId: 'wamid.media' });
  h.sendInteractiveButtons.mockResolvedValue({ messageId: 'wamid.btn' });
  h.sendInteractiveList.mockResolvedValue({ messageId: 'wamid.list' });
  seed();
});

describe('phone-variant retry on "recipient not allowed"', () => {
  const variants = phoneVariants('15551234567');

  it('has several variants to try (guards the fixture)', () => {
    expect(variants.length).toBeGreaterThan(2);
    expect(variants[0]).toBe('15551234567');
  });

  it('tries the next variant, and auto-corrects the contact phone to the one that worked', async () => {
    h.sendTextMessage
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockRejectedValueOnce(new Error('Meta says: not in the allowed list'))
      .mockResolvedValueOnce({ messageId: 'wamid.third' });

    const res = await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    });

    expect(h.sendTextMessage.mock.calls.map((c) => c[0].to)).toEqual(
      variants.slice(0, 3)
    );
    expect(res.whatsappMessageId).toBe('wamid.third');
    // The working variant is written back so the next send goes straight through.
    expect(h.db.contacts[0].phone).toBe(variants[2]);
    expect(h.db.messages[0].message_id).toBe('wamid.third');
  });

  it('does not touch the contact when the first variant works', async () => {
    await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.db.contacts[0].phone).toBe(PHONE);
  });

  it('stops at the first error that is not "not allowed" (no further variants) and persists nothing', async () => {
    h.sendTextMessage.mockRejectedValueOnce(
      new Error('(#131047) Re-engagement message')
    );

    const err = await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(SendMessageError);
    expect(err.code).toBe('meta_error');
    expect(err.status).toBe(502);
    expect(err.message).toBe('Meta API error: (#131047) Re-engagement message');
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.db.messages).toHaveLength(0);
    expect(h.db.conversations[0].last_message_text).toBe('old');
  });

  it('stops after a later variant fails with another error', async () => {
    h.sendTextMessage
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockRejectedValueOnce(new Error('(#100) Invalid parameter'));

    await expect(
      send({ conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow('Meta API error: (#100) Invalid parameter');
    expect(h.sendTextMessage).toHaveBeenCalledTimes(2);
    expect(h.db.contacts[0].phone).toBe(PHONE);
  });

  it('fails with meta_error/502 after exhausting every variant, keeping the last error', async () => {
    h.sendTextMessage.mockRejectedValue(new Error(NOT_ALLOWED));

    const err = await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);

    expect(h.sendTextMessage).toHaveBeenCalledTimes(variants.length);
    expect(err).toBeInstanceOf(SendMessageError);
    expect([err.code, err.status]).toEqual(['meta_error', 502]);
    expect(err.message).toBe(`Meta API error: ${NOT_ALLOWED}`);
    expect(h.db.messages).toHaveLength(0);
    expect(h.db.contacts[0].phone).toBe(PHONE);
  });

  it('gives a BSUID a single attempt even on "not allowed"', async () => {
    seed({ phone: '' });
    seedBsuidIdentity(BSUID);
    h.sendTextMessage.mockRejectedValue(new Error(NOT_ALLOWED));

    await expect(
      send({ conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toMatchObject({ code: 'meta_error', status: 502 });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage.mock.calls[0][0].to).toBe(BSUID);
  });

  it('applies the same retry to media sends', async () => {
    h.sendMediaMessage
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockResolvedValueOnce({ messageId: 'wamid.m2' });

    await send({
      conversationId: 'cv-1',
      messageType: 'image',
      mediaUrl: 'https://x/y.jpg',
    });
    expect(h.sendMediaMessage.mock.calls.map((c) => c[0].to)).toEqual(
      variants.slice(0, 2)
    );
    expect(h.db.contacts[0].phone).toBe(variants[1]);
  });
});

describe('destination resolution and pre-send failures', () => {
  it('sends to the BSUID (single attempt, no contact rewrite) for a BSUID-only contact', async () => {
    seed({ phone: '' });
    seedBsuidIdentity(BSUID);
    await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage.mock.calls[0][0].to).toBe(BSUID);
    expect(h.db.contacts[0].phone).toBe('');
  });

  it('fails with a clear 400 when the contact has no phone and no BSUID, before calling Meta', async () => {
    seed({ phone: '' });
    const err = await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SendMessageError);
    expect([err.code, err.status]).toEqual(['bad_request', 400]);
    expect(err.message).toBe('Contact has no phone number or WhatsApp user ID');
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('says "Invalid phone number format" when a phone exists but is unusable and there is no BSUID', async () => {
    seed({ phone: 'abc' });
    await expect(
      send({ conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).rejects.toThrow('Invalid phone number format');
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('404s for a conversation of another account', async () => {
    const err = await sendMessageToConversation(fakeDb(), 'acct-2', {
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);
    expect([err.code, err.status]).toEqual(['not_found', 404]);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('400s with whatsapp_not_configured when the account has no config', async () => {
    h.db.channel_connections = [];
    const err = await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);
    expect([err.code, err.status]).toEqual(['whatsapp_not_configured', 400]);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('rejects a reply target that is not in this conversation', async () => {
    const err = await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
      replyToMessageId: 'nope',
    }).catch((e) => e);
    expect([err.code, err.status]).toEqual(['bad_request', 400]);
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });

  it('reports db_error/500 when Meta accepted but the message row cannot be saved', async () => {
    h.insertError = { message: 'boom' };
    const err = await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    }).catch((e) => e);
    expect([err.code, err.status]).toEqual(['db_error', 500]);
    expect(err.message).toBe(
      'Message sent to Meta but failed to save to DB: boom'
    );
    expect(h.db.conversations[0].last_message_text).toBe('old');
  });
});

describe('persistence per message type', () => {
  it('text: calls Meta with the decrypted token + phone_number_id, stores an agent message, updates the conversation', async () => {
    const res = await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hello there',
    });

    expect(h.sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'dec:cipher',
      to: '15551234567',
      text: 'hello there',
      contextMessageId: undefined,
    });
    expect(res).toEqual({
      messageId: 'messages-1',
      whatsappMessageId: 'wamid.text',
    });
    expect(h.db.messages[0]).toMatchObject({
      conversation_id: 'cv-1',
      sender_type: 'agent',
      content_type: 'text',
      content_text: 'hello there',
      media_url: null,
      template_name: null,
      interactive_payload: null,
      message_id: 'wamid.text',
      status: 'sent',
      reply_to_message_id: null,
    });
    const conv = h.db.conversations[0];
    expect(conv.last_message_text).toBe('hello there');
    expect(conv.last_message_at).not.toBe('2020-01-01T00:00:00Z');
    expect(typeof conv.updated_at).toBe('string');
  });

  it('media: sends kind/link/caption/filename, stores media_url + caption, preview is the caption', async () => {
    await send({
      conversationId: 'cv-1',
      messageType: 'document',
      mediaUrl: 'https://x/doc.pdf',
      contentText: 'the contract',
      filename: 'contract.pdf',
    });

    expect(h.sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '15551234567',
        kind: 'document',
        link: 'https://x/doc.pdf',
        caption: 'the contract',
        filename: 'contract.pdf',
      })
    );
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'document',
      content_text: 'the contract',
      media_url: 'https://x/doc.pdf',
      message_id: 'wamid.media',
      status: 'sent',
    });
    expect(h.db.conversations[0].last_message_text).toBe('the contract');
  });

  it('media without caption: content_text null and the preview falls back to "[type]"', async () => {
    await send({
      conversationId: 'cv-1',
      messageType: 'audio',
      mediaUrl: 'https://x/a.ogg',
    });
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'audio',
      content_text: null,
      media_url: 'https://x/a.ogg',
    });
    expect(h.db.conversations[0].last_message_text).toBe('[audio]');
    expect(h.sendMediaMessage.mock.calls[0][0].caption).toBeUndefined();
  });

  it('template: sends the template row + params, stores template_name and the rendered body', async () => {
    h.db.message_templates = [
      {
        id: 'tpl-1',
        account_id: 'acct-1',
        user_id: 'u-1',
        name: 'order_update',
        category: 'Utility',
        language: 'en',
        body_text: 'Order {{1}} ships {{2}}',
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
    await send({
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'order_update',
      templateParams: ['A1', 'today'],
    });

    expect(h.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'pn-1',
        accessToken: 'dec:cipher',
        to: '15551234567',
        templateName: 'order_update',
        language: 'en',
        params: ['A1', 'today'],
      })
    );
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'template',
      template_name: 'order_update',
      content_text: 'Order A1 ships today',
      message_id: 'wamid.tpl',
      status: 'sent',
    });
    expect(h.db.conversations[0].last_message_text).toBe(
      'Order A1 ships today'
    );
  });

  it('template with no language and no local row defaults the send language to en_US', async () => {
    await send({
      conversationId: 'cv-1',
      messageType: 'template',
      templateName: 'unknown_tpl',
    });
    expect(h.sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      language: 'en_US',
      params: [],
    });
  });

  it('interactive buttons: sends body/header/footer/buttons, stores the payload, preview from the payload helper', async () => {
    const payload = {
      kind: 'buttons' as const,
      body: 'Pick one',
      header: 'Header',
      footer: 'Footer',
      buttons: [
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ],
    };
    await send({
      conversationId: 'cv-1',
      messageType: 'interactive',
      interactivePayload: payload,
    });

    expect(h.sendInteractiveButtons).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '15551234567',
        bodyText: 'Pick one',
        headerText: 'Header',
        footerText: 'Footer',
        buttons: payload.buttons,
      })
    );
    expect(h.sendInteractiveList).not.toHaveBeenCalled();
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'interactive',
      content_text: 'Pick one',
      interactive_payload: payload,
      message_id: 'wamid.btn',
    });
    expect(typeof h.db.conversations[0].last_message_text).toBe('string');
    expect(h.db.conversations[0].last_message_text).not.toBe('old');
  });

  it('interactive list: routes to sendInteractiveList and stores the payload', async () => {
    const payload = {
      kind: 'list' as const,
      body: 'Choose',
      button_label: 'Open',
      sections: [{ title: 'S', rows: [{ id: 'r1', title: 'Row 1' }] }],
    };
    await send({
      conversationId: 'cv-1',
      messageType: 'interactive',
      interactivePayload: payload,
    });

    expect(h.sendInteractiveButtons).not.toHaveBeenCalled();
    expect(h.sendInteractiveList).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText: 'Choose',
        buttonLabel: 'Open',
        sections: payload.sections,
        headerText: undefined,
        footerText: undefined,
      })
    );
    expect(h.db.messages[0]).toMatchObject({
      content_type: 'interactive',
      content_text: 'Choose',
      interactive_payload: payload,
      message_id: 'wamid.list',
    });
  });

  it('reply: passes the parent wamid as context and stores reply_to_message_id', async () => {
    h.db.messages = [
      { id: 'parent-1', conversation_id: 'cv-1', message_id: 'wamid.parent' },
    ];
    await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'answer',
      replyToMessageId: 'parent-1',
    });
    expect(h.sendTextMessage.mock.calls[0][0].contextMessageId).toBe(
      'wamid.parent'
    );
    expect(h.db.messages[1].reply_to_message_id).toBe('parent-1');
  });

  it('reply to a parent without a wamid still sends, just without context', async () => {
    h.db.messages = [
      { id: 'parent-1', conversation_id: 'cv-1', message_id: null },
    ];
    await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'answer',
      replyToMessageId: 'parent-1',
    });
    expect(h.sendTextMessage.mock.calls[0][0].contextMessageId).toBeUndefined();
    expect(h.db.messages[1].reply_to_message_id).toBe('parent-1');
  });
});

describe('active flow run is paused when an agent sends', () => {
  it("marks the contact's ACTIVE runs paused_by_agent / agent_replied, scoped by account and contact", async () => {
    await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    });

    expect(h.flowPauses).toHaveLength(1);
    const { patch, filters } = h.flowPauses[0];
    expect(patch).toMatchObject({
      status: 'paused_by_agent',
      end_reason: 'agent_replied',
    });
    expect(typeof patch.ended_at).toBe('string');
    expect(filters).toEqual([
      ['account_id', 'acct-1'],
      ['conversation_id', 'cv-1'],
      ['status', 'active'],
    ]);
  });

  it('pauses after any message type (media here)', async () => {
    await send({
      conversationId: 'cv-1',
      messageType: 'image',
      mediaUrl: 'https://x/y.jpg',
    });
    expect(h.flowPauses).toHaveLength(1);
  });

  it('does not pause when the send fails', async () => {
    h.sendTextMessage.mockRejectedValue(new Error('(#100) nope'));
    await send({
      conversationId: 'cv-1',
      messageType: 'text',
      contentText: 'hi',
    }).catch(() => undefined);
    expect(h.flowPauses).toHaveLength(0);
  });

  it('is best-effort: a pause error (returned or thrown) does not fail the send', async () => {
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    h.flowPauseError = { message: 'rls' };
    await expect(
      send({ conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).resolves.toMatchObject({ whatsappMessageId: 'wamid.text' });

    h.flowPauseError = null;
    h.flowPauseThrows = true;
    await expect(
      send({ conversationId: 'cv-1', messageType: 'text', contentText: 'hi' })
    ).resolves.toMatchObject({ whatsappMessageId: 'wamid.text' });
    errSpy.mockRestore();
  });
});

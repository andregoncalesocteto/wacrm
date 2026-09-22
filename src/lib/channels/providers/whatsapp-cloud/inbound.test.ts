import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Connection } from '../../types';

const h = vi.hoisted(() => ({ getConnectionByExternalId: vi.fn() }));

vi.mock('../../connections', () => ({
  getConnectionByExternalId: h.getConnectionByExternalId,
  getConnectionCredentials: vi.fn(),
}));

import { whatsappCloudProvider as provider } from './index';

const CONN = { id: 'conn-1', external_id: 'pn-1' } as unknown as Connection;

// Same shapes as the webhook characterization test (US-002): a fake Request
// with only text() and headers.get(), body readable once.
function sign(raw: string, secret = process.env.META_APP_SECRET as string) {
  return (
    'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex')
  );
}

function req(body: unknown, signature?: string | null) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const sig = signature === undefined ? sign(raw) : signature;
  const text = vi.fn(async () => raw);
  const request = {
    text,
    headers: { get: (n: string) => (n === 'x-hub-signature-256' ? sig : null) },
  } as unknown as Request;
  return { request, text };
}

const deliver = (value: Record<string, unknown>) => ({
  entry: [
    {
      id: 'waba-1',
      changes: [
        {
          field: 'messages',
          value: { metadata: { phone_number_id: 'pn-1' }, ...value },
        },
      ],
    },
  ],
});

const status = (s: Record<string, unknown>) =>
  deliver({
    statuses: [{ timestamp: '1700000100', recipient_id: '15551230000', ...s }],
  });

const ADA = [{ wa_id: '15551230000', profile: { name: 'Ada' } }];
const reaction = (emoji: string, target = 'wamid.T1', id = 'wamid.R1') => ({
  id,
  from: '15551230000',
  timestamp: '1700000005',
  type: 'reaction',
  reaction: { message_id: target, emoji },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('resolveConnection', () => {
  it('finds the connection by phone_number_id of the payload', async () => {
    h.getConnectionByExternalId.mockResolvedValue(CONN);
    const { request } = req(status({ id: 'wamid.X', status: 'sent' }));
    expect(await provider.resolveConnection(request)).toBe(CONN);
    expect(h.getConnectionByExternalId).toHaveBeenCalledWith(
      'whatsapp_cloud',
      'pn-1'
    );
  });

  it('null when no connection matches', async () => {
    h.getConnectionByExternalId.mockResolvedValue(null);
    const { request } = req(status({ id: 'wamid.X', status: 'sent' }));
    expect(await provider.resolveConnection(request)).toBeNull();
  });

  it('null (no lookup) for bad JSON or a payload without phone_number_id', async () => {
    expect(
      await provider.resolveConnection(req('not json').request)
    ).toBeNull();
    expect(
      await provider.resolveConnection(
        req({ entry: [{ changes: [] }] }).request
      )
    ).toBeNull();
    expect(h.getConnectionByExternalId).not.toHaveBeenCalled();
  });

  it('reads the body once for resolveConnection + verify + parse', async () => {
    h.getConnectionByExternalId.mockResolvedValue(CONN);
    const { request, text } = req(status({ id: 'wamid.X', status: 'read' }));
    await provider.resolveConnection(request);
    expect(await provider.verify(request, CONN)).toBe(true);
    expect(await provider.parse(request, CONN)).toHaveLength(1);
    expect(text).toHaveBeenCalledTimes(1);
  });
});

describe('verify', () => {
  const body = status({ id: 'wamid.X', status: 'sent' });

  it('accepts a valid signature', async () => {
    expect(await provider.verify(req(body).request, CONN)).toBe(true);
  });

  it('rejects a wrong, missing or malformed signature', async () => {
    expect(await provider.verify(req(body, 'sha256=00').request, CONN)).toBe(
      false
    );
    expect(await provider.verify(req(body, null).request, CONN)).toBe(false);
    expect(await provider.verify(req(body, sign('{}')).request, CONN)).toBe(
      false
    );
  });

  it('rejects a body altered after signing', async () => {
    const raw = JSON.stringify(body);
    const { request } = req(raw + ' ', sign(raw));
    expect(await provider.verify(request, CONN)).toBe(false);
  });

  it('accepts any secret of a comma-separated META_APP_SECRET', async () => {
    const original = process.env.META_APP_SECRET;
    process.env.META_APP_SECRET = `app-one, ${original} ,app-three`;
    try {
      const raw = JSON.stringify(body);
      expect(
        await provider.verify(
          req(raw, sign(raw, original as string)).request,
          CONN
        )
      ).toBe(true);
      expect(
        await provider.verify(req(raw, sign(raw, 'app-three')).request, CONN)
      ).toBe(true);
      expect(
        await provider.verify(req(raw, sign(raw, 'other')).request, CONN)
      ).toBe(false);
    } finally {
      process.env.META_APP_SECRET = original;
    }
  });

  it('fails closed when META_APP_SECRET is not set', async () => {
    const original = process.env.META_APP_SECRET;
    delete process.env.META_APP_SECRET;
    try {
      const raw = JSON.stringify(body);
      expect(
        await provider.verify(req(raw, sign(raw, 'x')).request, CONN)
      ).toBe(false);
    } finally {
      process.env.META_APP_SECRET = original;
    }
  });
});

describe('parse: statuses', () => {
  it.each(['sent', 'delivered', 'read'])(
    '%s becomes a status event',
    async (s) => {
      const events = await provider.parse(
        req(status({ id: 'wamid.X', status: s })).request,
        CONN
      );
      expect(events).toEqual([
        {
          kind: 'status',
          externalId: 'wamid.X',
          status: s,
          at: new Date(1700000100 * 1000),
          recipient: '15551230000',
        },
      ]);
    }
  );

  it('failed carries Meta code, title and details (as the webhook records them)', async () => {
    const [ev] = await provider.parse(
      req(
        status({
          id: 'wamid.X',
          status: 'failed',
          errors: [
            {
              code: 131026,
              title: 'Message undeliverable',
              error_data: { details: 'Receiver is incapable of receiving' },
            },
          ],
        })
      ).request,
      CONN
    );
    expect(ev).toMatchObject({
      kind: 'status',
      status: 'failed',
      error: {
        code: 'recipient_unreachable',
        providerCode: 131026,
        title: 'Message undeliverable',
        details: 'Receiver is incapable of receiving',
        // same text the broadcast mirror writes to error_message
        message:
          '[131026] Message undeliverable: Receiver is incapable of receiving',
      },
    });
  });

  it('failed without details has null details and no trailing colon', async () => {
    const [ev] = await provider.parse(
      req(
        status({
          id: 'wamid.X',
          status: 'failed',
          errors: [{ code: 999999, title: 'x' }],
        })
      ).request,
      CONN
    );
    expect(ev).toMatchObject({
      error: { code: 'unknown', message: '[999999] x', details: null },
    });
  });

  it('failed without errors[] has no error; non-failed ignores errors[]', async () => {
    const [a] = await provider.parse(
      req(status({ id: 'w', status: 'failed' })).request,
      CONN
    );
    expect(a).toMatchObject({ status: 'failed' });
    expect(a).not.toHaveProperty('error');
    const [b] = await provider.parse(
      req(
        status({ id: 'w', status: 'sent', errors: [{ code: 1, title: 't' }] })
      ).request,
      CONN
    );
    expect(b).not.toHaveProperty('error');
  });

  it('drops statuses outside sent/delivered/read/failed', async () => {
    const events = await provider.parse(
      req(status({ id: 'w', status: 'deleted' })).request,
      CONN
    );
    expect(events).toEqual([]);
  });
});

describe('parse: reactions', () => {
  it('a reaction becomes an event on the target message from the sender', async () => {
    const events = await provider.parse(
      req(deliver({ messages: [reaction('👍')], contacts: ADA })).request,
      CONN
    );
    expect(events).toEqual([
      {
        kind: 'reaction',
        externalId: 'wamid.T1',
        sender: [{ kind: 'whatsapp:phone', externalId: '15551230000' }],
        emoji: '👍',
        at: new Date(1700000005 * 1000),
      },
    ]);
  });

  it('an empty emoji means removal (null)', async () => {
    const [ev] = await provider.parse(
      req(deliver({ messages: [reaction('')], contacts: ADA })).request,
      CONN
    );
    expect(ev).toMatchObject({ kind: 'reaction', emoji: null });
  });

  it('a username-only sender yields BSUID and username identities', async () => {
    const msg = {
      ...reaction('❤️'),
      from: undefined,
      from_user_id: 'US.13491208655302741918',
    };
    const [ev] = await provider.parse(
      req(
        deliver({
          messages: [msg],
          contacts: [
            {
              user_id: 'US.13491208655302741918',
              profile: { name: 'Bob', username: 'bob' },
            },
          ],
        })
      ).request,
      CONN
    );
    expect(ev).toMatchObject({
      sender: [
        { kind: 'whatsapp:bsuid', externalId: 'US.13491208655302741918' },
        { kind: 'whatsapp:username', externalId: 'bob' },
      ],
    });
  });

  it('skips reactions without a target or without any identity', async () => {
    const noTarget = { ...reaction('👍'), reaction: { emoji: '👍' } };
    const noSender = { ...reaction('👍'), from: undefined };
    const events = await provider.parse(
      req(deliver({ messages: [noTarget, noSender], contacts: [] })).request,
      CONN
    );
    expect(events).toEqual([]);
  });

  it('ignores non-JSON', async () => {
    expect(await provider.parse(req('nope').request, CONN)).toEqual([]);
  });

  it('a payload with statuses then a reaction keeps the delivery order', async () => {
    const events = await provider.parse(
      req(
        deliver({
          statuses: [{ id: 'w1', status: 'sent', timestamp: '1700000100' }],
          messages: [reaction('👍')],
          contacts: ADA,
        })
      ).request,
      CONN
    );
    expect(events.map((e) => e.kind)).toEqual(['status', 'reaction']);
  });
});

// ---- messages (US-073) ------------------------------------------------------
// Payload shapes of route.characterization.test.ts. Expectations are written
// from what the webhook persists for the same payload (content_type,
// content_text, media_type, interactive_reply_id, reply target).

const BASE = { from: '15551230000', timestamp: '1700000000' };
const msgs = (messages: Record<string, unknown>[], contacts: unknown[] = ADA) =>
  deliver({ messages, contacts });

async function parseMessages(
  messages: Record<string, unknown>[],
  contacts: unknown[] = ADA
) {
  const { request } = req(msgs(messages, contacts));
  return provider.parse(request, CONN);
}

const PHONE = { kind: 'whatsapp:phone', externalId: '15551230000' };

describe('parse: messages', () => {
  it('text: identity, profile name and timestamp; persisted text = body', async () => {
    const [e] = await parseMessages([
      { ...BASE, id: 'wamid.T1', type: 'text', text: { body: 'hello' } },
    ]);
    expect(e).toEqual({
      kind: 'message',
      externalId: 'wamid.T1',
      sender: [PHONE],
      at: new Date(1700000000 * 1000),
      content: { type: 'text', text: 'hello' },
      senderName: 'Ada',
    });
  });

  it('image: media id, mime and caption (content_text = caption)', async () => {
    const [e] = await parseMessages([
      {
        ...BASE,
        id: 'wamid.I1',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'look' },
      },
    ]);
    expect(e).toMatchObject({
      content: {
        type: 'media',
        kind: 'image',
        media: { kind: 'image', id: 'media-1', mimeType: 'image/jpeg' },
        caption: 'look',
      },
    });
  });

  it('video and audio carry media; audio has no caption', async () => {
    const [v, a] = await parseMessages([
      {
        ...BASE,
        id: 'v',
        type: 'video',
        video: { id: 'mv', mime_type: 'video/mp4', caption: 'clip' },
      },
      {
        ...BASE,
        id: 'a',
        type: 'audio',
        audio: { id: 'ma', mime_type: 'audio/ogg' },
      },
    ]);
    expect(v).toMatchObject({
      content: { kind: 'video', caption: 'clip', media: { id: 'mv' } },
    });
    expect(a.kind === 'message' && a.content).toEqual({
      type: 'media',
      kind: 'audio',
      media: { kind: 'audio', id: 'ma', mimeType: 'audio/ogg' },
    });
  });

  it('document: filename in the MediaRef, caption falls back to the filename (content_text)', async () => {
    const [noCaption, withCaption] = await parseMessages([
      {
        ...BASE,
        id: 'd1',
        type: 'document',
        document: {
          id: 'md',
          mime_type: 'application/pdf',
          filename: 'invoice.pdf',
        },
      },
      {
        ...BASE,
        id: 'd2',
        type: 'document',
        document: {
          id: 'md',
          mime_type: 'application/pdf',
          filename: 'invoice.pdf',
          caption: 'Q3',
        },
      },
    ]);
    expect(noCaption).toMatchObject({
      content: {
        kind: 'document',
        caption: 'invoice.pdf',
        media: {
          id: 'md',
          mimeType: 'application/pdf',
          fileName: 'invoice.pdf',
        },
      },
    });
    expect(withCaption).toMatchObject({
      content: { caption: 'Q3', media: { fileName: 'invoice.pdf' } },
    });
  });

  it('sticker is an image', async () => {
    const [e] = await parseMessages([
      {
        ...BASE,
        id: 's1',
        type: 'sticker',
        sticker: { id: 'ms', mime_type: 'image/webp' },
      },
    ]);
    expect(e).toMatchObject({
      content: {
        type: 'media',
        kind: 'image',
        media: { kind: 'image', id: 'ms', mimeType: 'image/webp' },
      },
    });
  });

  it('media without an id is unsupported (the webhook stores no media)', async () => {
    const [e] = await parseMessages([
      { ...BASE, id: 'x', type: 'image', image: { mime_type: 'image/png' } },
    ]);
    expect(e).toMatchObject({
      content: { type: 'unsupported', description: '[image]' },
    });
  });

  it('location: text = "name - address - lat,lng"', async () => {
    const [e] = await parseMessages([
      {
        ...BASE,
        id: 'l1',
        type: 'location',
        location: {
          latitude: 1.5,
          longitude: -2.5,
          name: 'Shop',
          address: 'Main St',
        },
      },
    ]);
    expect(e).toMatchObject({
      content: {
        type: 'location',
        latitude: 1.5,
        longitude: -2.5,
        text: 'Shop - Main St - 1.5,-2.5',
      },
    });
  });

  it('interactive button/list replies: id routes, title displays (title || id)', async () => {
    const [b, l, noTitle] = await parseMessages([
      {
        ...BASE,
        id: 'b',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'opt_1', title: 'Yes' },
        },
      },
      {
        ...BASE,
        id: 'l',
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'row_2', title: 'Plan B' },
        },
      },
      {
        ...BASE,
        id: 'n',
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'opt_9', title: '' },
        },
      },
    ]);
    expect(b).toMatchObject({
      content: { type: 'interactive_reply', id: 'opt_1', title: 'Yes' },
    });
    expect(l).toMatchObject({ content: { id: 'row_2', title: 'Plan B' } });
    expect(noTitle).toMatchObject({ content: { id: 'opt_9', title: 'opt_9' } });
  });

  it('interactive without a tapped option is unsupported "[Interactive reply]"', async () => {
    const [e] = await parseMessages([
      { ...BASE, id: 'i', type: 'interactive', interactive: {} },
    ]);
    expect(e).toMatchObject({
      content: { type: 'unsupported', description: '[Interactive reply]' },
    });
  });

  it('template quick-reply button: payload is the id, text the title, each falls back', async () => {
    const [both, onlyText, onlyPayload] = await parseMessages([
      {
        ...BASE,
        id: 'b1',
        type: 'button',
        button: { text: 'Sim', payload: 'P1' },
      },
      { ...BASE, id: 'b2', type: 'button', button: { text: 'Sim' } },
      { ...BASE, id: 'b3', type: 'button', button: { payload: 'P3' } },
    ]);
    expect(both).toMatchObject({
      content: { type: 'interactive_reply', id: 'P1', title: 'Sim' },
    });
    expect(onlyText).toMatchObject({ content: { id: 'Sim', title: 'Sim' } });
    expect(onlyPayload).toMatchObject({ content: { id: 'P3', title: 'P3' } });
  });

  it('unknown type is unsupported with the webhook placeholder text', async () => {
    const [e] = await parseMessages([{ ...BASE, id: 'u', type: 'order' }]);
    expect(e).toMatchObject({
      content: {
        type: 'unsupported',
        description: '[Unsupported message type: order]',
      },
    });
  });

  it('swipe-reply: context.id becomes replyToExternalId', async () => {
    const [e, plain] = await parseMessages([
      {
        ...BASE,
        id: 'r',
        type: 'text',
        text: { body: 'yes' },
        context: { id: 'wamid.PARENT' },
      },
      { ...BASE, id: 'p', type: 'text', text: { body: 'no' } },
    ]);
    expect(e).toMatchObject({ replyToExternalId: 'wamid.PARENT' });
    expect(plain).not.toHaveProperty('replyToExternalId');
  });

  it('BSUID-only sender: bsuid + username candidates (with handle), no phone, profile name', async () => {
    const [e] = await parseMessages(
      [
        {
          id: 'wamid.B1',
          from_user_id: 'US.1111111',
          from_parent_user_id: 'US.ENT.9999999',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'hi' },
        },
      ],
      [
        {
          profile: { name: 'Sheena', username: 'sheena_n' },
          user_id: 'US.1111111',
          parent_user_id: 'US.ENT.9999999',
        },
      ]
    );
    expect(e).toMatchObject({
      kind: 'message',
      sender: [
        { kind: 'whatsapp:bsuid', externalId: 'US.1111111' },
        {
          kind: 'whatsapp:username',
          externalId: 'sheena_n',
          handle: '@sheena_n',
        },
      ],
      senderName: 'Sheena',
    });
  });

  it('phone with formatting is normalized to digits; phone + bsuid + username all emitted', async () => {
    const [e] = await parseMessages(
      [
        {
          id: 'w',
          from: '+1 (555) 123-0000',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'x' },
        },
      ],
      [
        {
          wa_id: '15551230000',
          profile: { name: 'Ada', username: '@ada' },
          user_id: 'US.2222222',
        },
      ]
    );
    expect(e).toMatchObject({
      sender: [
        PHONE,
        { kind: 'whatsapp:bsuid', externalId: 'US.2222222' },
        { kind: 'whatsapp:username', externalId: 'ada', handle: '@ada' },
      ],
    });
  });

  it('phone comes from contacts[].wa_id when the message has no `from`', async () => {
    const [e] = await parseMessages([
      { id: 'w', timestamp: '1700000000', type: 'text', text: { body: 'x' } },
    ]);
    expect(e).toMatchObject({ sender: [PHONE] });
  });

  it('drops a message with neither phone nor valid BSUID (like the webhook)', async () => {
    const events = await parseMessages(
      [
        {
          id: 'wamid.X',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'x' },
        },
        {
          id: 'wamid.Y',
          from_user_id: 'US',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'y' },
        },
      ],
      [{ profile: { name: 'Ghost' } }]
    );
    expect(events).toEqual([]);
  });

  it('pairs each message with its own contacts[] entry and omits an empty name', async () => {
    const events = await parseMessages(
      [
        {
          id: 'm1',
          from: '111',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'a' },
        },
        {
          id: 'm2',
          from: '222',
          timestamp: '1700000001',
          type: 'text',
          text: { body: 'b' },
        },
      ],
      [
        { wa_id: '111', profile: { name: 'One' } },
        { wa_id: '222', profile: {} },
      ]
    );
    expect(events[0]).toMatchObject({ senderName: 'One' });
    expect(events[1]).not.toHaveProperty('senderName');
  });

  it('reactions still yield reaction events, alongside messages in order', async () => {
    const events = await parseMessages([
      { ...BASE, id: 'm', type: 'text', text: { body: 'a' } },
      reaction('👍'),
    ]);
    expect(events.map((e) => e.kind)).toEqual(['message', 'reaction']);
  });
});

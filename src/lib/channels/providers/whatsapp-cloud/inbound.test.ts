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

  it('does not parse messages here (US-073) and ignores non-JSON', async () => {
    const text = {
      id: 'wamid.T1',
      from: '15551230000',
      timestamp: '1700000000',
      type: 'text',
      text: { body: 'hello' },
    };
    expect(
      await provider.parse(
        req(deliver({ messages: [text], contacts: ADA })).request,
        CONN
      )
    ).toEqual([]);
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

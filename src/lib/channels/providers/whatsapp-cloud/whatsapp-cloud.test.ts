import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ChannelError } from '../../types';
import type { Connection, ContactIdentity, Target } from '../../types';
import { phoneVariants } from '@/lib/whatsapp/phone-utils';

const h = vi.hoisted(() => ({
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
  sendInteractiveButtons: vi.fn(),
  sendInteractiveList: vi.fn(),
  sendReactionMessage: vi.fn(),
  getConnectionCredentials: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTextMessage: h.sendTextMessage,
  sendTemplateMessage: h.sendTemplateMessage,
  sendMediaMessage: h.sendMediaMessage,
  sendInteractiveButtons: h.sendInteractiveButtons,
  sendInteractiveList: h.sendInteractiveList,
  sendReactionMessage: h.sendReactionMessage,
}));
vi.mock('../../connections', () => ({
  getConnectionCredentials: h.getConnectionCredentials,
}));

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { registerBuiltinProviders } from '../index';
import {
  getProvider,
  hasProvider,
  resetRegistryForTests,
} from '../../registry';
import { whatsappCloudProvider as provider } from './index';

const PHONE = '15551234567';
const BSUID = 'US.ENT.abcd1234';
const NOT_ALLOWED = '(#131030) Recipient phone number not in allowed list';
const conn = { id: 'cn-1', external_id: 'pn-1' } as Connection;
const phoneTarget: Target = { kind: 'whatsapp:phone', address: PHONE };
const bsuidTarget: Target = { kind: 'whatsapp:bsuid', address: BSUID };

function metaErr(code: number | null, message: string, httpStatus = 400) {
  return new MetaApiError(message, { code, httpStatus });
}

beforeEach(() => {
  h.getConnectionCredentials.mockResolvedValue({ access_token: 'tok' });
  for (const f of [
    h.sendTextMessage,
    h.sendTemplateMessage,
    h.sendMediaMessage,
    h.sendInteractiveButtons,
    h.sendInteractiveList,
    h.sendReactionMessage,
  ]) {
    f.mockResolvedValue({ messageId: 'wamid.ok' });
  }
});

describe('capabilities and schemas', () => {
  it('matches the declared snapshot', () => {
    expect(provider.type).toBe('whatsapp_cloud');
    expect(provider.identityKinds).toEqual([
      'whatsapp:phone',
      'whatsapp:bsuid',
    ]);
    expect(provider.capabilities).toMatchInlineSnapshot(`
      {
        "captionMaxLength": 1024,
        "deliveryStatus": true,
        "initiate": "template",
        "interactiveButtons": true,
        "interactiveList": true,
        "maxMediaBytes": 16777216,
        "mediaKinds": [
          "image",
          "video",
          "document",
          "audio",
        ],
        "reactions": true,
        "readStatus": true,
        "replyWindowHours": 24,
        "templates": true,
        "typingIndicator": true,
      }
    `);
  });

  it('validates config and credentials', () => {
    expect(provider.configSchema.safeParse({ waba_id: 'w1' }).success).toBe(
      true
    );
    expect(provider.configSchema.safeParse({}).success).toBe(false);
    expect(provider.configSchema.safeParse(null).success).toBe(false);
    expect(
      provider.credentialsSchema.safeParse({ access_token: 't' }).success
    ).toBe(true);
    expect(
      provider.credentialsSchema.safeParse({ access_token: '' }).success
    ).toBe(false);
  });
});

describe('registry', () => {
  it('registerBuiltinProviders registers whatsapp_cloud, idempotently', () => {
    resetRegistryForTests();
    expect(hasProvider('whatsapp_cloud')).toBe(false);
    registerBuiltinProviders();
    registerBuiltinProviders();
    expect(getProvider('whatsapp_cloud')).toBe(provider);
    resetRegistryForTests();
  });
});

describe('resolveTarget', () => {
  const id = (kind: string, externalId: string): ContactIdentity => ({
    kind,
    externalId,
  });

  it('prefers a valid phone over a BSUID', () => {
    expect(
      provider.resolveTarget([
        id('whatsapp:bsuid', BSUID),
        id('whatsapp:phone', '+1 555 123 4567'),
      ])
    ).toEqual({ kind: 'whatsapp:phone', address: PHONE });
  });
  it('falls back to the BSUID when the phone is missing or invalid', () => {
    expect(provider.resolveTarget([id('whatsapp:bsuid', BSUID)])).toEqual(
      bsuidTarget
    );
    expect(
      provider.resolveTarget([
        id('whatsapp:phone', 'abc'),
        id('whatsapp:bsuid', BSUID),
      ])
    ).toEqual(bsuidTarget);
  });
  it('returns null when nothing is usable (other kinds ignored)', () => {
    expect(provider.resolveTarget([])).toBeNull();
    expect(provider.resolveTarget([id('telegram:chat_id', '123')])).toBeNull();
    expect(provider.resolveTarget([id('whatsapp:bsuid', 'nope')])).toBeNull();
  });
});

describe('send per message type', () => {
  it('text uses the connection phone_number_id and decrypted token', async () => {
    const res = await provider.send(conn, phoneTarget, {
      type: 'text',
      text: 'hi',
      replyTo: { externalId: 'wamid.parent' },
    });
    expect(res).toEqual({ externalId: 'wamid.ok' });
    expect(h.sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      to: PHONE,
      text: 'hi',
      contextMessageId: 'wamid.parent',
    });
  });

  it('media maps kind/url/caption/fileName', async () => {
    await provider.send(conn, phoneTarget, {
      type: 'media',
      kind: 'document',
      url: 'https://x/a.pdf',
      caption: 'c',
      fileName: 'a.pdf',
    });
    expect(h.sendMediaMessage.mock.calls[0][0]).toMatchObject({
      kind: 'document',
      link: 'https://x/a.pdf',
      caption: 'c',
      filename: 'a.pdf',
      to: PHONE,
    });
  });

  it('template passes name/language and the provider data (row, params)', async () => {
    const row = { id: 't1' };
    await provider.send(conn, phoneTarget, {
      type: 'template',
      template: {
        name: 'promo',
        language: 'pt_BR',
        provider: { row, messageParams: { body: ['a'] } },
      },
    });
    expect(h.sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      templateName: 'promo',
      language: 'pt_BR',
      template: row,
      messageParams: { body: ['a'] },
      params: [],
    });
  });

  it('interactive buttons and list route to their senders', async () => {
    await provider.send(conn, phoneTarget, {
      type: 'interactive',
      interactive: {
        kind: 'buttons',
        body: 'b',
        header: 'h',
        buttons: [{ id: '1', title: 'Yes' }],
      },
    });
    expect(h.sendInteractiveButtons.mock.calls[0][0]).toMatchObject({
      bodyText: 'b',
      headerText: 'h',
      footerText: undefined,
      buttons: [{ id: '1', title: 'Yes' }],
    });
    await provider.send(conn, phoneTarget, {
      type: 'interactive',
      interactive: {
        kind: 'list',
        body: 'b',
        buttonLabel: 'Open',
        sections: [{ rows: [{ id: 'r', title: 'Row' }] }],
      },
    });
    expect(h.sendInteractiveList.mock.calls[0][0]).toMatchObject({
      bodyText: 'b',
      buttonLabel: 'Open',
    });
  });

  it('reaction (and react()) map null emoji to removal', async () => {
    await provider.send(conn, phoneTarget, {
      type: 'reaction',
      target: { externalId: 'wamid.t' },
      emoji: null,
    });
    expect(h.sendReactionMessage.mock.calls[0][0]).toMatchObject({
      targetMessageId: 'wamid.t',
      emoji: '',
    });
    await provider.react!(conn, phoneTarget, { externalId: 'wamid.t' }, '👍');
    expect(h.sendReactionMessage.mock.calls[1][0]).toMatchObject({
      emoji: '👍',
    });
  });

  it('fails with auth when the connection has no token', async () => {
    h.getConnectionCredentials.mockResolvedValue(null);
    await expect(
      provider.send(conn, phoneTarget, { type: 'text', text: 'x' })
    ).rejects.toMatchObject({
      code: 'auth',
    });
    expect(h.sendTextMessage).not.toHaveBeenCalled();
  });
});

describe('phone-variant retry', () => {
  const variants = phoneVariants(PHONE);
  const text = { type: 'text', text: 'hi' } as const;

  it('tries the next variant on "not allowed" and reports the working one', async () => {
    h.sendTextMessage
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockRejectedValueOnce(new Error('Meta says: not in the allowed list'))
      .mockResolvedValueOnce({ messageId: 'wamid.third' });
    const res = await provider.send(conn, phoneTarget, text);
    expect(h.sendTextMessage.mock.calls.map((c) => c[0].to)).toEqual(
      variants.slice(0, 3)
    );
    expect(res).toEqual({
      externalId: 'wamid.third',
      resolvedAddress: variants[2],
    });
  });

  it('has no resolvedAddress when the first variant works', async () => {
    const res = await provider.send(conn, phoneTarget, text);
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(res.resolvedAddress).toBeUndefined();
  });

  it('stops at the first error that is not "not allowed"', async () => {
    h.sendTextMessage.mockRejectedValueOnce(
      new Error('(#131047) Re-engagement message')
    );
    await expect(provider.send(conn, phoneTarget, text)).rejects.toMatchObject({
      code: 'window_closed',
      providerCode: 131047,
    });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('stops after a later variant fails with another error', async () => {
    h.sendTextMessage
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockRejectedValueOnce(new Error('(#100) Invalid parameter'));
    await expect(provider.send(conn, phoneTarget, text)).rejects.toThrow(
      '(#100) Invalid parameter'
    );
    expect(h.sendTextMessage).toHaveBeenCalledTimes(2);
  });

  it('exhausted variants throw the last error as recipient_unreachable', async () => {
    h.sendTextMessage.mockRejectedValue(new Error(NOT_ALLOWED));
    const err = await provider.send(conn, phoneTarget, text).catch((e) => e);
    expect(h.sendTextMessage).toHaveBeenCalledTimes(variants.length);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.code).toBe('recipient_unreachable');
    expect(err.providerCode).toBe(131030);
    expect(err.message).toBe(NOT_ALLOWED);
  });

  it('gives a BSUID a single attempt even on "not allowed"', async () => {
    h.sendTextMessage.mockRejectedValue(new Error(NOT_ALLOWED));
    await expect(provider.send(conn, bsuidTarget, text)).rejects.toMatchObject({
      code: 'recipient_unreachable',
    });
    expect(h.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(h.sendTextMessage.mock.calls[0][0].to).toBe(BSUID);
  });

  it('applies the same retry to media sends', async () => {
    h.sendMediaMessage
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockResolvedValueOnce({ messageId: 'wamid.m2' });
    const res = await provider.send(conn, phoneTarget, {
      type: 'media',
      kind: 'image',
      url: 'https://x/y.jpg',
    });
    expect(h.sendMediaMessage.mock.calls.map((c) => c[0].to)).toEqual(
      variants.slice(0, 2)
    );
    expect(res.resolvedAddress).toBe(variants[1]);
  });
});

describe('error mapping', () => {
  const text = { type: 'text', text: 'hi' } as const;
  const cases: [string, unknown, string, number | undefined][] = [
    [
      'expired token',
      metaErr(190, 'Error validating access token', 401),
      'auth',
      190,
    ],
    ['401 without code', metaErr(null, 'nope', 401), 'auth', undefined],
    [
      'rate limit',
      metaErr(130429, 'Rate limit hit', 429),
      'rate_limited',
      130429,
    ],
    [
      '429 without code',
      metaErr(null, 'slow down', 429),
      'rate_limited',
      undefined,
    ],
    [
      'undeliverable',
      metaErr(131026, 'Message undeliverable'),
      'recipient_unreachable',
      131026,
    ],
    ['validation', metaErr(100, 'Invalid parameter'), 'invalid', 100],
    [
      'plain text code',
      new Error('(#131009) Parameter value is not valid'),
      'invalid',
      131009,
    ],
    ['unknown', new Error('socket hang up'), 'unknown', undefined],
  ];
  it.each(cases)('%s', async (_n, thrown, code, providerCode) => {
    h.sendTextMessage.mockRejectedValueOnce(thrown);
    const err = await provider.send(conn, phoneTarget, text).catch((e) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect(err.code).toBe(code);
    expect(err.providerCode).toBe(providerCode);
    expect(err.message).toBe((thrown as Error).message);
  });

  it('only rate_limited is retryable', async () => {
    h.sendTextMessage.mockRejectedValueOnce(metaErr(130429, 'x', 429));
    expect(
      (await provider.send(conn, phoneTarget, text).catch((e) => e)).retryable
    ).toBe(true);
    h.sendTextMessage.mockRejectedValueOnce(metaErr(190, 'x', 401));
    expect(
      (await provider.send(conn, phoneTarget, text).catch((e) => e)).retryable
    ).toBe(false);
  });
});

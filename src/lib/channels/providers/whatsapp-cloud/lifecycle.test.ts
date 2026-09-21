import { describe, it, expect, vi, beforeEach } from 'vitest';

import { ChannelError } from '../../types';
import type { Connection, MediaRef, Target } from '../../types';

const h = vi.hoisted(() => ({
  verifyPhoneNumber: vi.fn(),
  listWabaPhoneNumbers: vi.fn(),
  registerPhoneNumber: vi.fn(),
  subscribeWabaToApp: vi.fn(),
  getSubscribedApps: vi.fn(),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  sendTypingIndicator: vi.fn(),
  getConnectionCredentials: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyPhoneNumber: h.verifyPhoneNumber,
  listWabaPhoneNumbers: h.listWabaPhoneNumbers,
  registerPhoneNumber: h.registerPhoneNumber,
  subscribeWabaToApp: h.subscribeWabaToApp,
  getSubscribedApps: h.getSubscribedApps,
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
  sendTypingIndicator: h.sendTypingIndicator,
}));
vi.mock('../../connections', () => ({
  getConnectionCredentials: h.getConnectionCredentials,
}));

import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { whatsappCloudProvider as provider } from './index';

const conn = {
  id: 'cn-1',
  external_id: '111',
  config: { waba_id: '222', registered_at: '2026-01-01T00:00:00Z' },
} as unknown as Connection;
const target: Target = { kind: 'whatsapp:phone', address: '15551234567' };

const metaErr = (code: number | null, message: string, httpStatus = 400) =>
  new MetaApiError(message, { code, httpStatus });

beforeEach(() => {
  h.getConnectionCredentials.mockResolvedValue({ access_token: 'tok' });
  h.verifyPhoneNumber.mockResolvedValue({ id: '111' });
  h.listWabaPhoneNumbers.mockResolvedValue([{ id: '111' }]);
  h.registerPhoneNumber.mockResolvedValue({
    success: true,
    alreadyRegistered: false,
  });
  h.subscribeWabaToApp.mockResolvedValue(undefined);
  h.getSubscribedApps.mockResolvedValue([
    { whatsapp_business_api_data: { id: 'app' } },
  ]);
  h.sendTypingIndicator.mockResolvedValue(undefined);
});

describe('connect', () => {
  it('verifies, registers with the PIN and subscribes', async () => {
    const r = await provider.connect(conn, { pin: '123456' });
    expect(r).toMatchObject({
      ok: true,
      details: { registration: 'registered' },
    });
    expect(h.registerPhoneNumber).toHaveBeenCalledWith({
      phoneNumberId: '111',
      accessToken: 'tok',
      pin: '123456',
    });
    expect(h.subscribeWabaToApp).toHaveBeenCalledWith({
      wabaId: '222',
      accessToken: 'tok',
    });
  });

  it('skips registration without a PIN but still subscribes (ok + hint)', async () => {
    const r = await provider.connect(conn);
    expect(r.ok).toBe(true);
    expect(r.details).toEqual({ registration: 'skipped' });
    expect(r.message).toMatch(/not registered/i);
    expect(h.registerPhoneNumber).not.toHaveBeenCalled();
    expect(h.subscribeWabaToApp).toHaveBeenCalled();
  });

  it('does not put the PIN anywhere in the result', async () => {
    const r = await provider.connect(conn, { pin: '123456' });
    expect(JSON.stringify(r)).not.toContain('123456');
  });

  it('rejects a malformed PIN without calling register', async () => {
    const r = await provider.connect(conn, { pin: '12' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(h.registerPhoneNumber).not.toHaveBeenCalled();
  });

  it('maps an invalid token to an auth error', async () => {
    h.verifyPhoneNumber.mockRejectedValue(
      metaErr(190, 'Invalid OAuth access token', 401)
    );
    const r = await provider.connect(conn, { pin: '123456' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'auth', providerCode: 190 });
    expect(h.subscribeWabaToApp).not.toHaveBeenCalled();
  });

  it('fails when the number is not under the WABA', async () => {
    h.listWabaPhoneNumbers.mockResolvedValue([{ id: '999' }]);
    const r = await provider.connect(conn);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid' } });
    expect(h.subscribeWabaToApp).not.toHaveBeenCalled();
  });

  it('reports a registration failure and does not subscribe', async () => {
    h.registerPhoneNumber.mockRejectedValue(
      metaErr(133005, 'Two-step verification PIN Mismatch')
    );
    const r = await provider.connect(conn, { pin: '123456' });
    expect(r.ok).toBe(false);
    expect(r.error?.providerCode).toBe(133005);
    expect(r.message).toBeTruthy();
    expect(h.subscribeWabaToApp).not.toHaveBeenCalled();
  });

  it('reports a subscription failure', async () => {
    h.subscribeWabaToApp.mockRejectedValue(metaErr(100, 'Unsupported post'));
    const r = await provider.connect(conn);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });

  it('fails with auth when there is no access token', async () => {
    h.getConnectionCredentials.mockResolvedValue(null);
    const r = await provider.connect(conn);
    expect(r).toMatchObject({ ok: false, error: { code: 'auth' } });
    expect(h.verifyPhoneNumber).not.toHaveBeenCalled();
  });

  it('fails without a waba_id', async () => {
    const r = await provider.connect({ ...conn, config: {} } as Connection);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid' } });
  });
});

describe('disconnect', () => {
  it('is a no-op that touches nothing on Meta', async () => {
    await expect(provider.disconnect(conn)).resolves.toBeUndefined();
    expect(h.subscribeWabaToApp).not.toHaveBeenCalled();
    expect(h.getConnectionCredentials).not.toHaveBeenCalled();
  });
});

describe('health', () => {
  it('is connected when number, subscription and registration are ok', async () => {
    const r = await provider.health(conn);
    expect(r.state).toBe('connected');
    expect(r.checkedAt).toBeInstanceOf(Date);
  });

  it('maps an invalid token to needs_action', async () => {
    h.verifyPhoneNumber.mockRejectedValue(
      metaErr(190, 'Error validating access token', 401)
    );
    const r = await provider.health(conn);
    expect(r.state).toBe('needs_action');
    expect(r.reason).toMatch(/access token/i);
  });

  it('is degraded when Meta is rate limiting or failing', async () => {
    h.verifyPhoneNumber.mockRejectedValue(metaErr(4, 'Too many calls', 429));
    expect((await provider.health(conn)).state).toBe('degraded');
  });

  it('needs_action when the WABA has no subscribed apps', async () => {
    h.getSubscribedApps.mockResolvedValue([]);
    const r = await provider.health(conn);
    expect(r.state).toBe('needs_action');
    expect(r.reason).toMatch(/no subscribed apps/i);
  });

  it('needs_action when the subscription probe is unauthorized', async () => {
    h.getSubscribedApps.mockRejectedValue(metaErr(200, 'Permission', 403));
    expect((await provider.health(conn)).state).toBe('needs_action');
  });

  it('needs_action without a waba_id', async () => {
    const r = await provider.health({ ...conn, config: {} } as Connection);
    expect(r.state).toBe('needs_action');
  });

  it('is degraded when the number was never registered', async () => {
    const r = await provider.health({
      ...conn,
      config: { waba_id: '222' },
    } as Connection);
    expect(r.state).toBe('degraded');
    expect(r.reason).toMatch(/not registered/i);
  });

  it('needs_action when there is no token', async () => {
    h.getConnectionCredentials.mockResolvedValue({});
    expect((await provider.health(conn)).state).toBe('needs_action');
  });
});

describe('downloadMedia', () => {
  const ref: MediaRef = { kind: 'image', id: 'media-1' };

  it('resolves the URL then downloads the bytes into a Blob', async () => {
    h.getMediaUrl.mockResolvedValue({
      url: 'https://cdn/x',
      mimeType: 'image/jpeg',
      fileSize: 3,
    });
    h.downloadMedia.mockResolvedValue({
      buffer: Buffer.from([1, 2, 3]),
      contentType: 'image/jpeg',
    });
    const blob = await provider.downloadMedia!(conn, ref);
    expect(h.getMediaUrl).toHaveBeenCalledWith({
      mediaId: 'media-1',
      accessToken: 'tok',
    });
    expect(h.downloadMedia).toHaveBeenCalledWith({
      downloadUrl: 'https://cdn/x',
      accessToken: 'tok',
    });
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(3);
  });

  it('maps a Meta failure to a ChannelError', async () => {
    h.getMediaUrl.mockRejectedValue(metaErr(190, 'expired token', 401));
    await expect(provider.downloadMedia!(conn, ref)).rejects.toMatchObject({
      name: 'ChannelError',
      code: 'auth',
    });
  });

  it('maps a failed byte download to a ChannelError', async () => {
    h.getMediaUrl.mockResolvedValue({
      url: 'u',
      mimeType: 'image/png',
      fileSize: null,
    });
    h.downloadMedia.mockRejectedValue(new Error('Media download failed: 404'));
    await expect(provider.downloadMedia!(conn, ref)).rejects.toBeInstanceOf(
      ChannelError
    );
  });
});

describe('typing', () => {
  it('sends the indicator for the inbound message id', async () => {
    await provider.typing!(conn, target, { inboundExternalId: 'wamid.in' });
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: '111',
      accessToken: 'tok',
      messageId: 'wamid.in',
    });
  });

  it('rejects as invalid without the inbound id, calling nothing', async () => {
    await expect(provider.typing!(conn, target)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(h.sendTypingIndicator).not.toHaveBeenCalled();
  });

  it('maps a Meta failure to a ChannelError', async () => {
    h.sendTypingIndicator.mockRejectedValue(metaErr(4, 'rate', 429));
    await expect(
      provider.typing!(conn, target, { inboundExternalId: 'wamid.in' })
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('react (already provided)', () => {
  it('is declared as a capability and implemented', () => {
    expect(provider.capabilities.reactions).toBe(true);
    expect(provider.capabilities.typingIndicator).toBe(true);
    expect(typeof provider.react).toBe('function');
  });
});

import { describe, expect, it } from 'vitest';

import type { ChannelConnectionRow } from '@/lib/channels/ui';
import {
  buildConnectBody,
  buildCreateBody,
  buildMirrorBody,
  buildPatchBody,
  connectionView,
  generateVerifyToken,
  healthView,
  shouldConnect,
  validateDraft,
} from './panel-logic';

const draft = {
  isCreate: true,
  displayName: 'Main',
  phoneNumberId: '100234567890123',
  wabaId: '100234567890456',
  accessToken: 'EAAB',
};

describe('generateVerifyToken', () => {
  it('is 32 hex chars and differs between calls', () => {
    const a = generateVerifyToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(generateVerifyToken()).not.toBe(a);
  });
  it('encodes the bytes it is given', () => {
    expect(
      generateVerifyToken((b) => b.fill(255)) // 0xff x 16
    ).toBe('ff'.repeat(16));
  });
});

describe('validateDraft', () => {
  it('accepts a complete create draft', () => {
    expect(validateDraft(draft)).toBeNull();
  });
  it.each([
    [{ displayName: ' ' }, 'displayNameRequired'],
    [{ phoneNumberId: '' }, 'phoneNumberIdRequired'],
    [{ phoneNumberId: '+55 11' }, 'phoneNumberIdNotNumeric'],
    [{ wabaId: '' }, 'wabaIdRequired'],
    [{ wabaId: 'abc' }, 'wabaIdNotNumeric'],
    [{ accessToken: '  ' }, 'accessTokenRequired'],
  ])('flags %j', (patch, key) => {
    expect(validateDraft({ ...draft, ...patch })).toBe(key);
  });
  it('edit mode needs no token and ignores the locked number', () => {
    expect(
      validateDraft({
        ...draft,
        isCreate: false,
        accessToken: '',
        phoneNumberId: '',
      })
    ).toBeNull();
  });
});

describe('payload builders', () => {
  it('create body carries config and credentials but never the PIN', () => {
    const body = buildCreateBody({
      storeId: 's1',
      displayName: ' Main ',
      phoneNumberId: ' 1 ',
      wabaId: ' 2 ',
      accessToken: ' tok ',
      verifyToken: 'vt',
      mirrorMedia: false,
    });
    expect(body).toEqual({
      store_id: 's1',
      channel_type: 'whatsapp_cloud',
      display_name: 'Main',
      config: {
        phone_number_id: '1',
        waba_id: '2',
        verify_token: 'vt',
        mirror_inbound_media: false,
      },
      credentials: { access_token: 'tok' },
    });
    expect(JSON.stringify(body)).not.toContain('pin');
  });
  it('patch body sends secrets only when replaced', () => {
    const keep = buildPatchBody({
      displayName: 'A',
      wabaId: '2',
      mirrorMedia: true,
      newVerifyToken: null,
      newAccessToken: null,
    });
    expect(keep).toEqual({
      display_name: 'A',
      config: { waba_id: '2', mirror_inbound_media: true },
    });
    const replaced = buildPatchBody({
      displayName: 'A',
      wabaId: '2',
      mirrorMedia: true,
      newVerifyToken: 'vt2',
      newAccessToken: ' new ',
    });
    expect(replaced.credentials).toEqual({ access_token: 'new' });
    expect((replaced.config as Record<string, unknown>).verify_token).toBe(
      'vt2'
    );
  });
  it('mirror body only touches the mirror key', () => {
    expect(buildMirrorBody(false)).toEqual({
      config: { mirror_inbound_media: false },
    });
  });
  it('connect body carries the PIN only when typed', () => {
    expect(buildConnectBody('')).toEqual({});
    expect(buildConnectBody(' 123456 ')).toEqual({ pin: '123456' });
  });
});

describe('shouldConnect', () => {
  const base = {
    tokenReplaced: false,
    pin: '',
    wabaChanged: false,
    status: 'connected',
  };
  it('skips a plain edit of a healthy connection', () => {
    expect(shouldConnect(base)).toBe(false);
  });
  it.each([
    { tokenReplaced: true },
    { pin: '123456' },
    { wabaChanged: true },
    { status: 'needs_action' },
    { status: 'disconnected' },
  ])('connects for %j', (patch) => {
    expect(shouldConnect({ ...base, ...patch })).toBe(true);
  });
});

describe('connectionView', () => {
  const row = (over: Partial<ChannelConnectionRow>): ChannelConnectionRow => ({
    id: 'c',
    store_id: 's',
    channel_type: 'whatsapp_cloud',
    display_name: 'x',
    status: 'connected',
    disabled_at: null,
    last_inbound_at: null,
    has_conversations: false,
    ...over,
  });
  it('defaults mirror to on and reads registration state', () => {
    const v = connectionView(
      row({
        config: { waba_id: '9', registered_at: '2026-01-01T00:00:00Z' },
      })
    );
    expect(v).toMatchObject({
      wabaId: '9',
      mirrorMedia: true,
      registeredAt: '2026-01-01T00:00:00Z',
      credentialsValid: true,
    });
  });
  it('maps a failed connection', () => {
    const v = connectionView(
      row({
        status: 'needs_action',
        config: { mirror_inbound_media: false, last_registration_error: 'bad' },
        last_error: { message: 'Invalid token' },
      })
    );
    expect(v).toMatchObject({
      mirrorMedia: false,
      credentialsValid: false,
      lastRegistrationError: 'bad',
      lastErrorMessage: 'Invalid token',
    });
  });
  it('is empty for create mode', () => {
    expect(connectionView(null)).toMatchObject({
      wabaId: '',
      registeredAt: null,
      credentialsValid: false,
    });
  });
});

describe('healthView', () => {
  it('is live only when connected', () => {
    expect(healthView({ state: 'connected', reason: null }).live).toBe(true);
    expect(healthView({ state: 'degraded', reason: 'x' })).toEqual({
      live: false,
      reason: 'x',
    });
  });
});

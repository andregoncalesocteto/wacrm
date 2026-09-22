import { beforeEach, describe, expect, it } from 'vitest';
import {
  getProvider,
  hasProvider,
  listProviders,
  registerProvider,
  resetRegistryForTests,
} from './registry';
import { ChannelError, type ChannelProvider, type ChannelType } from './types';

function fake(type: ChannelType): ChannelProvider {
  const schema = {
    safeParse: (d: unknown) => ({ success: true as const, data: d }),
  };
  return {
    type,
    identityKinds: [`${type}:id`],
    capabilities: {
      templates: false,
      interactiveButtons: false,
      interactiveList: false,
      reactions: false,
      typingIndicator: false,
      deliveryStatus: false,
      readStatus: false,
      initiate: 'free',
      replyWindowHours: null,
      mediaKinds: [],
      maxMediaBytes: 0,
      captionMaxLength: 0,
    },
    configSchema: schema,
    credentialsSchema: schema,
    connect: async () => ({ ok: true }),
    disconnect: async () => {},
    health: async () => ({ state: 'connected', checkedAt: new Date() }),
    resolveConnection: async () => null,
    verify: async () => true,
    parse: async () => [],
    resolveTarget: () => null,
    send: async () => ({ externalId: 'x' }),
  };
}

describe('provider registry', () => {
  beforeEach(() => resetRegistryForTests());

  it('registers and finds a provider by type', () => {
    const p = fake('telegram');
    registerProvider(p);
    expect(getProvider('telegram')).toBe(p);
    expect(hasProvider('telegram')).toBe(true);
    expect(hasProvider('whatsapp_cloud')).toBe(false);
  });

  it('throws a clear error for an unknown type', () => {
    registerProvider(fake('telegram'));
    expect(() => getProvider('signal')).toThrow(
      'Unknown channel type "signal". Registered providers: telegram.'
    );
  });

  it('says none are registered when the registry is empty', () => {
    expect(() => getProvider('telegram')).toThrow(/Registered providers: none/);
  });

  it('rejects registering the same type twice', () => {
    registerProvider(fake('telegram'));
    expect(() => registerProvider(fake('telegram'))).toThrow(
      /already registered/
    );
  });

  it('lists every registered provider', () => {
    registerProvider(fake('telegram'));
    registerProvider(fake('whatsapp_cloud'));
    expect(
      listProviders()
        .map((p) => p.type)
        .sort()
    ).toEqual(['telegram', 'whatsapp_cloud']);
  });
});

describe('ChannelError', () => {
  it('carries code, providerCode and retryable', () => {
    const e = new ChannelError('rate_limited', 'slow down', {
      providerCode: 429,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('rate_limited');
    expect(e.providerCode).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.toInfo()).toEqual({
      code: 'rate_limited',
      message: 'slow down',
      providerCode: 429,
    });
  });

  it('is not retryable by default for other codes', () => {
    expect(new ChannelError('auth', 'bad token').retryable).toBe(false);
    expect(
      new ChannelError('unknown', 'x', { retryable: true }).retryable
    ).toBe(true);
  });
});

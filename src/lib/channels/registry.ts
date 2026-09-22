import type { ChannelProvider, ChannelType } from './types';

/**
 * The ONLY place that knows provider modules. Core code asks for a provider by
 * `channel_type` and never imports a concrete provider directly.
 *
 * Providers are added by US-010+ (each one calls `registerProvider` for its
 * type from the module list below); the map starts empty.
 */
const providers = new Map<ChannelType, ChannelProvider>();

export function registerProvider(provider: ChannelProvider): void {
  if (providers.has(provider.type)) {
    throw new Error(`Channel provider already registered: ${provider.type}`);
  }
  providers.set(provider.type, provider);
}

/** Throws a clear error for an unknown type (e.g. a stale DB value). */
export function getProvider(type: string): ChannelProvider {
  const provider = providers.get(type as ChannelType);
  if (!provider) {
    const known = [...providers.keys()].join(', ') || 'none';
    throw new Error(
      `Unknown channel type "${type}". Registered providers: ${known}.`
    );
  }
  return provider;
}

export function hasProvider(type: string): boolean {
  return providers.has(type as ChannelType);
}

/** For GET /api/channels/providers. */
export function listProviders(): ChannelProvider[] {
  return [...providers.values()];
}

/** Test helper: empties the registry. */
export function resetRegistryForTests(): void {
  providers.clear();
}

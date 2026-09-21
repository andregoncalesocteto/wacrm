import { hasProvider, registerProvider } from '../registry';
import { telegramProvider } from './telegram';
import { whatsappCloudProvider } from './whatsapp-cloud';

/**
 * Bootstrap: registers every built-in provider. Idempotent (safe to call from
 * several entrypoints). Kept out of registry.ts so the registry never imports
 * concrete providers.
 */
export function registerBuiltinProviders(): void {
  for (const provider of [whatsappCloudProvider, telegramProvider]) {
    if (!hasProvider(provider.type)) registerProvider(provider);
  }
}

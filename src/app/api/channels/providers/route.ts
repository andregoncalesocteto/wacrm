import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { registerBuiltinProviders } from '@/lib/channels/providers';
import { listProviders } from '@/lib/channels/registry';

/**
 * GET /api/channels/providers — any member. Available providers with their
 * i18n label key, capabilities and form descriptor. No secrets, no config.
 */
export async function GET() {
  try {
    await getCurrentAccount();
    registerBuiltinProviders();
    return NextResponse.json({
      providers: listProviders().map((p) => ({
        type: p.type,
        label: `Channels.providers.${p.type}.name`,
        capabilities: p.capabilities,
        descriptor: p.descriptor ?? { panel: 'form', fields: [] },
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

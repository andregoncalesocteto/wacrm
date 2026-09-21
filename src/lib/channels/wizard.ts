// Pure helpers for the "connect a channel" wizard (no React, no i18n).

import type { Capabilities, ChannelErrorCode } from './types';

export const WIZARD_STEPS = ['store', 'channel', 'data', 'connect'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** i18n key suffixes (Settings.channels.wizard.caps.<key>). */
export type CapabilityChip =
  | 'noTemplates'
  | 'noList'
  | 'noButtons'
  | 'noReadReceipts'
  | 'noReactions'
  | 'afterInbound';

/**
 * What a channel does NOT do compared with the fullest one, derived only from
 * the capability flags the providers endpoint returns (no channel names).
 */
export function capabilityChips(caps: Partial<Capabilities>): CapabilityChip[] {
  const chips: CapabilityChip[] = [];
  if (caps.templates === false) chips.push('noTemplates');
  if (caps.interactiveList === false) chips.push('noList');
  if (caps.interactiveButtons === false) chips.push('noButtons');
  if (caps.readStatus === false) chips.push('noReadReceipts');
  if (caps.reactions === false) chips.push('noReactions');
  if (caps.initiate === 'after_inbound') chips.push('afterInbound');
  return chips;
}

/** i18n key suffix (Settings.channels.wizard.fix.<key>) telling how to fix a failure. */
export function fixHintKey(code: ChannelErrorCode | string | undefined) {
  switch (code) {
    case 'auth':
    case 'invalid':
    case 'rate_limited':
      return code;
    default:
      return 'unknown';
  }
}

/** Step 1 needs a store; step 2 a channel type. Later steps gate themselves. */
export function canLeaveStep(
  step: WizardStep,
  s: { storeId: string | null; channelType: string | null }
): boolean {
  if (step === 'store') return !!s.storeId;
  if (step === 'channel') return !!s.channelType;
  return true;
}

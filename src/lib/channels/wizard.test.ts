import { describe, expect, it } from 'vitest';
import { canLeaveStep, capabilityChips, fixHintKey } from './wizard';

describe('wizard helpers', () => {
  it('derives chips from the flags only', () => {
    expect(capabilityChips({})).toEqual([]);
    expect(
      capabilityChips({
        templates: true,
        interactiveList: true,
        interactiveButtons: true,
        readStatus: true,
        reactions: true,
        initiate: 'template',
      })
    ).toEqual([]);
    expect(
      capabilityChips({
        templates: false,
        interactiveList: false,
        readStatus: false,
        initiate: 'after_inbound',
      })
    ).toEqual(['noTemplates', 'noList', 'noReadReceipts', 'afterInbound']);
  });

  it('maps error codes to a fix hint, unknown by default', () => {
    expect(fixHintKey('auth')).toBe('auth');
    expect(fixHintKey('invalid')).toBe('invalid');
    expect(fixHintKey('rate_limited')).toBe('rate_limited');
    expect(fixHintKey('window_closed')).toBe('unknown');
    expect(fixHintKey(undefined)).toBe('unknown');
  });

  it('does not leave store/channel steps without a choice', () => {
    expect(canLeaveStep('store', { storeId: null, channelType: null })).toBe(
      false
    );
    expect(canLeaveStep('store', { storeId: 's', channelType: null })).toBe(
      true
    );
    expect(canLeaveStep('channel', { storeId: 's', channelType: null })).toBe(
      false
    );
    expect(canLeaveStep('channel', { storeId: 's', channelType: 't' })).toBe(
      true
    );
  });
});

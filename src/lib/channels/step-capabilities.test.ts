import { describe, expect, it } from 'vitest';
import { registerBuiltinProviders } from './providers';
import { getProvider } from './registry';
import {
  channelWarnings,
  stepRequirements,
  type StepRequirement,
} from './step-capabilities';

registerBuiltinProviders();
const providers = ['whatsapp_cloud', 'telegram'].map((type) => ({
  type,
  capabilities: getProvider(type).capabilities,
}));

describe('stepRequirements', () => {
  it('maps automation steps, recursing into branches, deduplicated', () => {
    const reqs = stepRequirements([
      { step_type: 'send_message' },
      { step_type: 'send_template' },
      {
        step_type: 'condition',
        branches: {
          yes: [{ step_type: 'send_list' }, { step_type: 'send_template' }],
          no: [{ step_type: 'send_buttons' }],
        },
      },
    ]);
    expect(reqs.map((r) => r.capability).sort()).toEqual([
      'interactiveButtons',
      'interactiveList',
      'templates',
    ]);
  });

  it('maps flow nodes incl. media kind; ignores the rest', () => {
    const reqs = stepRequirements([
      { node_type: 'start' },
      { node_type: 'send_media', config: { media_type: 'video' } },
      { node_type: 'send_media', config: { media_type: 'bogus' } },
      { node_type: 'send_list', config: {} },
    ]);
    expect(reqs).toEqual([
      { capability: 'media', mediaKind: 'video' },
      { capability: 'interactiveList' },
    ]);
  });
});

describe('channelWarnings (real provider capabilities)', () => {
  const template: StepRequirement = { capability: 'templates' };

  it('warns that templates fail on telegram when both are active', () => {
    const w = channelWarnings(
      [template, { capability: 'interactiveList' }],
      providers,
      ['whatsapp_cloud', 'telegram']
    );
    expect(w).toEqual([
      { requirement: template, channelTypes: ['telegram'] },
      {
        requirement: { capability: 'interactiveList' },
        channelTypes: ['telegram'],
      },
    ]);
  });

  it('is silent with one connection, or when all support the steps', () => {
    expect(channelWarnings([template], providers, ['telegram'])).toEqual([]);
    expect(
      channelWarnings([template], providers, [
        'whatsapp_cloud',
        'whatsapp_cloud',
      ])
    ).toEqual([]);
    expect(
      channelWarnings([{ capability: 'interactiveButtons' }], providers, [
        'whatsapp_cloud',
        'telegram',
      ])
    ).toEqual([]);
  });

  it('is silent while providers are not loaded; unknown provider is incapable', () => {
    expect(channelWarnings([template], null, ['a', 'b'])).toEqual([]);
    expect(
      channelWarnings([template], providers, ['whatsapp_cloud', 'mystery'])
    ).toEqual([{ requirement: template, channelTypes: ['mystery'] }]);
  });
});

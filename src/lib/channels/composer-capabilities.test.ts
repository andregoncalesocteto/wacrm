import { describe, expect, it } from 'vitest';
import { whatsappCloudCapabilities } from './providers/whatsapp-cloud';
import type { Capabilities } from './types';
import {
  composerCapabilities,
  sendErrorMessageKey,
  type ProviderCapabilities,
} from './composer-capabilities';

const whatsapp: ProviderCapabilities = {
  type: 'whatsapp_cloud',
  capabilities: whatsappCloudCapabilities,
};
const textOnly: Capabilities = {
  ...whatsappCloudCapabilities,
  templates: false,
  interactiveButtons: false,
  interactiveList: false,
  reactions: false,
  mediaKinds: ['image', 'document'],
  captionMaxLength: 200,
};
const fixture: ProviderCapabilities = {
  type: 'fixture',
  capabilities: textOnly,
};

describe('composerCapabilities', () => {
  it('whatsapp_cloud: everything on, no reasons', () => {
    const c = composerCapabilities('whatsapp_cloud', [whatsapp, fixture]);
    expect(c).toMatchObject({
      known: true,
      canTemplate: true,
      canButtons: true,
      canList: true,
      canReact: true,
      canMedia: true,
      captionMax: 1024,
      reasons: {},
    });
    expect(c.mediaKinds).toEqual(['image', 'video', 'document', 'audio']);
  });

  it('a channel without templates/list/reactions explains each', () => {
    const c = composerCapabilities('fixture', [whatsapp, fixture]);
    expect(c.canTemplate).toBe(false);
    expect(c.canButtons).toBe(false);
    expect(c.canList).toBe(false);
    expect(c.canReact).toBe(false);
    expect(c.mediaKinds).toEqual(['image', 'document']);
    expect(c.captionMax).toBe(200);
    expect(c.reasons).toEqual({
      template: 'unsupportedTemplates',
      buttons: 'unsupportedButtons',
      list: 'unsupportedList',
      react: 'unsupportedReactions',
    });
  });

  it('no media kinds disables media with a reason', () => {
    const p = { type: 'x', capabilities: { ...textOnly, mediaKinds: [] } };
    const c = composerCapabilities('x', [p]);
    expect(c.canMedia).toBe(false);
    expect(c.reasons.media).toBe('unsupportedMedia');
  });

  it('unknown provider degrades to text + media only', () => {
    const c = composerCapabilities('telegram', [whatsapp]);
    expect(c.known).toBe(false);
    expect(c).toMatchObject({
      canTemplate: false,
      canButtons: false,
      canList: false,
      canReact: false,
      canMedia: true,
    });
  });

  it('null channel = legacy WhatsApp; not loaded keeps WhatsApp full', () => {
    expect(composerCapabilities(null, [whatsapp]).canTemplate).toBe(true);
    expect(composerCapabilities('whatsapp_cloud', null).canReact).toBe(true);
    expect(composerCapabilities('telegram', null).canTemplate).toBe(false);
  });
});

describe('sendErrorMessageKey', () => {
  it('maps the known codes', () => {
    expect(sendErrorMessageKey('unsupported')).toBe('unsupported');
    expect(sendErrorMessageKey('window_closed')).toBe('windowClosed');
    expect(sendErrorMessageKey('recipient_unreachable')).toBe(
      'recipientUnreachable'
    );
    expect(sendErrorMessageKey('connection_disabled')).toBe(
      'connectionDisabled'
    );
    expect(sendErrorMessageKey('invalid')).toBe('invalid');
  });
  it('returns null for unknown / missing codes', () => {
    expect(sendErrorMessageKey('auth')).toBeNull();
    expect(sendErrorMessageKey('toString')).toBeNull();
    expect(sendErrorMessageKey(undefined)).toBeNull();
  });
});

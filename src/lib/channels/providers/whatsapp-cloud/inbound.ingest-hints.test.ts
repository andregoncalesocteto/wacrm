import { describe, it, expect, vi } from 'vitest';
import type { Connection } from '../../types';

vi.mock('../../connections', () => ({
  getConnectionByExternalId: vi.fn(),
  getConnectionCredentials: vi.fn(),
}));

import { whatsappCloudProvider as provider } from './index';

// Additive hints the ingestion core needs to reproduce what the webhook
// stores (US-019): stored override for degenerate messages, emptyPreview,
// parentExternalId.

const CONN = { id: 'conn-1', external_id: 'pn-1' } as unknown as Connection;

async function parseOne(message: Record<string, unknown>) {
  const raw = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: 'pn-1' },
              contacts: [{ wa_id: '15551230000', profile: { name: 'Ada' } }],
              messages: [
                { from: '15551230000', timestamp: '1700000000', ...message },
              ],
            },
          },
        ],
      },
    ],
  });
  const request = { text: async () => raw } as unknown as Request;
  const [e] = await provider.parse(request, CONN);
  return e;
}

describe('parse: hints for the ingestion core', () => {
  it('degenerate messages say how they are stored', async () => {
    expect(await parseOne({ id: 'a', type: 'image', image: {} })).toMatchObject(
      {
        content: { stored: { contentType: 'image', text: null } },
      }
    );
    expect(
      await parseOne({ id: 'b', type: 'sticker', sticker: {} })
    ).toMatchObject({
      content: { stored: { contentType: 'image', text: null } },
      emptyPreview: '[sticker]',
    });
    expect(
      await parseOne({ id: 'c', type: 'document', document: {} })
    ).toMatchObject({
      content: { stored: { contentType: 'document', text: null } },
    });
    expect(await parseOne({ id: 'd', type: 'location' })).toMatchObject({
      content: { stored: { contentType: 'location', text: null } },
    });
    expect(
      await parseOne({ id: 'e', type: 'interactive', interactive: {} })
    ).toMatchObject({
      content: {
        stored: { contentType: 'interactive', text: '[Interactive reply]' },
      },
    });
  });

  it('a genuinely unknown type carries no stored override', async () => {
    const e = await parseOne({ id: 'u', type: 'order' });
    expect(e.kind === 'message' && e.content).not.toHaveProperty('stored');
  });

  it('button carries the [button] preview; ordinary types carry none', async () => {
    expect(
      await parseOne({ id: 'x', type: 'button', button: {} })
    ).toMatchObject({ emptyPreview: '[button]' });
    expect(
      await parseOne({ id: 't', type: 'text', text: { body: 'hi' } })
    ).not.toHaveProperty('emptyPreview');
  });

  it('the parent BSUID travels as parentExternalId', async () => {
    const e = await parseOne({
      id: 'p',
      from: undefined,
      from_user_id: 'US.1111111',
      from_parent_user_id: 'US.ENT.9999999',
      type: 'text',
      text: { body: 'hi' },
    });
    expect(e).toMatchObject({ parentExternalId: 'US.ENT.9999999' });
  });
});

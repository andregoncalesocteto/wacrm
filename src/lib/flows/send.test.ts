import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sendOutbound: vi.fn(), db: { tag: 'admin' } }));

vi.mock('@/lib/channels/send', () => ({ sendOutbound: h.sendOutbound }));
vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.db }));

import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from './send';

const base = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'cv-1',
  contactId: 'ct-1',
};

beforeEach(() => {
  h.sendOutbound.mockResolvedValue({ externalMessageId: 'wamid.x' });
});

describe('flows senders over sendOutbound', () => {
  it('text: actor flow, service-role db, returns the external id', async () => {
    const r = await engineSendText({ ...base, text: 'Hi' });
    expect(r).toEqual({ whatsapp_message_id: 'wamid.x' });
    expect(h.sendOutbound).toHaveBeenCalledWith({
      accountId: 'acct-1',
      conversationId: 'cv-1',
      message: { type: 'text', text: 'Hi' },
      actor: { type: 'flow' },
      db: h.db,
    });
  });

  it('media: maps link/filename to url/fileName and keeps the caption', async () => {
    await engineSendMedia({
      ...base,
      kind: 'document',
      link: 'https://x.test/a.pdf',
      caption: 'C',
      filename: 'a.pdf',
    });
    expect(h.sendOutbound.mock.calls[0][0].message).toEqual({
      type: 'media',
      kind: 'document',
      url: 'https://x.test/a.pdf',
      caption: 'C',
      fileName: 'a.pdf',
    });
  });

  it('buttons and list use the neutral interactive shape (buttonLabel)', async () => {
    const buttons = [{ id: 'a', title: 'A' }];
    await engineSendInteractiveButtons({ ...base, bodyText: 'B', buttons });
    expect(h.sendOutbound.mock.calls[0][0].message.interactive).toMatchObject({
      kind: 'buttons',
      body: 'B',
      buttons,
    });
    const sections = [{ rows: [{ id: 'r', title: 'R' }] }];
    await engineSendInteractiveList({
      ...base,
      bodyText: 'L',
      buttonLabel: 'Open',
      sections,
    });
    expect(h.sendOutbound.mock.calls[1][0].message.interactive).toMatchObject({
      kind: 'list',
      buttonLabel: 'Open',
      sections,
    });
  });

  it('propagates a send failure so the runner fails the run', async () => {
    h.sendOutbound.mockRejectedValue(new Error('(#100) boom'));
    await expect(engineSendText({ ...base, text: 'Hi' })).rejects.toThrow(
      '(#100) boom'
    );
  });
});

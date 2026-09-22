import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dispatch: vi.fn() }));

vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: h.dispatch }));
vi.mock('./connections', () => ({
  getConnectionByExternalId: vi.fn(),
  getConnectionCredentials: vi.fn(),
}));

import { db, state } from './ingest.fake';
import { ingestInbound } from './ingest';
import { createMediaResolver } from './media';
import { whatsappCloudProvider as provider } from './providers/whatsapp-cloud';
import type { Connection, InboundEvent } from './types';

const CONN = {
  id: 'conn-1',
  account_id: 'acct-1',
  external_id: 'pn-1',
  channel_type: 'whatsapp_cloud',
  store_id: 'store-1',
  config: {},
} as unknown as Connection;
const OPTS = { auditUserId: 'owner-1' };
const t = (n: string) => state.tables[n] ?? [];

/** Payload-derived events: a signed Meta payload through the real WhatsApp parse. */
async function parse(value: Record<string, unknown>): Promise<InboundEvent[]> {
  const raw = JSON.stringify({
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: { metadata: { phone_number_id: 'pn-1' }, ...value },
          },
        ],
      },
    ],
  });
  const sig =
    'sha256=' +
    crypto
      .createHmac('sha256', process.env.META_APP_SECRET as string)
      .update(raw)
      .digest('hex');
  const request = {
    text: async () => raw,
    headers: { get: (n: string) => (n === 'x-hub-signature-256' ? sig : null) },
  } as unknown as Request;
  return provider.parse(request, CONN);
}

const statusEvents = (s: Record<string, unknown>) =>
  parse({
    statuses: [{ timestamp: '1700000100', recipient_id: '15551230000', ...s }],
  });
const ADA = [{ wa_id: '15551230000', profile: { name: 'Ada' } }];
const inboundEvents = (m: Record<string, unknown>) =>
  parse({
    contacts: ADA,
    messages: [{ from: '15551230000', timestamp: '1700000000', ...m }],
  });
const TEXT = { id: 'wamid.T1', type: 'text', text: { body: 'hi' } };
const reaction = (emoji: string, target = 'wamid.T1', id = 'wamid.R1') => ({
  id,
  type: 'reaction',
  timestamp: '1700000005',
  reaction: { message_id: target, emoji },
});

beforeEach(() => {
  state.tables = {};
  state.seq = 0;
  state.rpcCalls = [];
  h.dispatch.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('ingestInbound: status events', () => {
  beforeEach(() => {
    state.tables.conversations = [
      { id: 'conv-x', account_id: 'acct-1', contact_id: 'ct-1' },
    ];
    state.tables.contacts = [{ id: 'ct-1', phone: '15551230000' }];
    state.tables.contact_identities = [
      {
        contact_id: 'ct-1',
        kind: 'whatsapp:phone',
        external_id: '15551230000',
        handle: null,
      },
    ];
    state.tables.messages = [
      {
        id: 'm-1',
        conversation_id: 'conv-x',
        message_id: 'wamid.OUT1',
        status: 'sent',
      },
    ];
  });
  const run = async (s: Record<string, unknown>) =>
    ingestInbound(db, CONN, await statusEvents(s), OPTS);

  it.each(['sent', 'delivered', 'read'])(
    'mirrors %s onto the message without error columns',
    async (s) => {
      const [r] = await run({ id: 'wamid.OUT1', status: s });
      expect(r).toMatchObject({ status: 'status_updated' });
      expect(t('messages')[0].status).toBe(s);
      expect(t('messages')[0]).not.toHaveProperty('error_code');
    }
  );

  it('has NO order guard on messages: read -> delivered is written', async () => {
    await run({ id: 'wamid.OUT1', status: 'read' });
    await run({ id: 'wamid.OUT1', status: 'delivered' });
    expect(t('messages')[0].status).toBe('delivered');
  });

  it('failed records code, title and details; a later delivered keeps them', async () => {
    await run({
      id: 'wamid.OUT1',
      status: 'failed',
      errors: [
        {
          code: 131026,
          title: 'Undeliverable',
          error_data: { details: 'not on WhatsApp' },
        },
      ],
    });
    expect(t('messages')[0]).toMatchObject({
      status: 'failed',
      error_code: 131026,
      error_title: 'Undeliverable',
      error_details: 'not on WhatsApp',
    });
    await run({ id: 'wamid.OUT1', status: 'delivered' });
    expect(t('messages')[0]).toMatchObject({
      status: 'delivered',
      error_code: 131026,
    });
  });

  it('fans out message.status_updated with the account from the embedded conversation', async () => {
    const [r] = await run({ id: 'wamid.OUT1', status: 'delivered' });
    expect(h.dispatch).toHaveBeenCalledWith(
      db,
      'acct-1',
      'message.status_updated',
      {
        whatsapp_message_id: 'wamid.OUT1',
        external_message_id: 'wamid.OUT1',
        conversation_id: 'conv-x',
        status: 'delivered',
        connection_id: 'conn-1',
        store_id: 'store-1',
        channel: 'whatsapp_cloud',
        contact: {
          id: 'ct-1',
          phone: '15551230000',
          identities: [
            { kind: 'whatsapp:phone', external_id: '15551230000', handle: null },
          ],
        },
      }
    );
    expect(r).toMatchObject({ webhookDispatched: true });
  });

  it('a wamid with no message or recipient is a harmless no-op', async () => {
    const [r] = await run({ id: 'wamid.GHOST', status: 'read' });
    expect(r).toMatchObject({
      status: 'status_updated',
      recipientUpdated: false,
      webhookDispatched: false,
    });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  describe('broadcast recipient ladder', () => {
    const recipient = (st: string) =>
      (state.tables.broadcast_recipients = [
        { id: 'r-1', whatsapp_message_id: 'wamid.BC1', status: st },
      ]);
    const current = () => t('broadcast_recipients')[0];

    it('walks pending -> sent -> delivered -> read stamping timestamps', async () => {
      recipient('pending');
      const iso = new Date(1700000100 * 1000).toISOString();
      await run({ id: 'wamid.BC1', status: 'sent' });
      expect(current()).toMatchObject({ status: 'sent', sent_at: iso });
      await run({ id: 'wamid.BC1', status: 'delivered' });
      expect(current()).toMatchObject({
        status: 'delivered',
        delivered_at: iso,
      });
      const [r] = await run({ id: 'wamid.BC1', status: 'read' });
      expect(current()).toMatchObject({ status: 'read', read_at: iso });
      expect(r).toMatchObject({ recipientUpdated: true });
    });

    it.each([
      ['read', 'delivered'],
      ['delivered', 'sent'],
      ['delivered', 'delivered'],
      ['replied', 'read'],
    ])('%s never regresses to %s', async (from, to) => {
      recipient(from);
      const [r] = await run({ id: 'wamid.BC1', status: to });
      expect(current().status).toBe(from);
      expect(r).toMatchObject({ recipientUpdated: false });
    });

    it.each(['pending', 'sent'])(
      'failed is accepted from %s; the reason is folded into error_message',
      async (from) => {
        recipient(from);
        await run({
          id: 'wamid.BC1',
          status: 'failed',
          errors: [
            {
              code: 131049,
              title: 'Ecosystem limit',
              error_data: { details: 'try later' },
            },
          ],
        });
        expect(current()).toMatchObject({
          status: 'failed',
          error_message: '[131049] Ecosystem limit: try later',
        });
      }
    );

    it.each(['delivered', 'read', 'replied'])(
      'failed is refused once the recipient is %s',
      async (from) => {
        recipient(from);
        await run({
          id: 'wamid.BC1',
          status: 'failed',
          errors: [{ code: 1, title: 'x' }],
        });
        expect(current().status).toBe(from);
        expect(current()).not.toHaveProperty('error_message');
      }
    );

    it('failed is terminal', async () => {
      recipient('failed');
      await run({ id: 'wamid.BC1', status: 'delivered' });
      expect(current().status).toBe('failed');
    });
  });
});

describe('ingestInbound: reaction events', () => {
  const ingest = async (m: Record<string, unknown>) =>
    ingestInbound(db, CONN, await inboundEvents(m), OPTS);
  const withTarget = () => ingest(TEXT);

  it('records a reaction on the target and does not create a message or bump unread', async () => {
    await withTarget();
    const rpcBefore = state.rpcCalls.length;
    const [r] = await ingest(reaction('👍'));
    expect(r).toMatchObject({ status: 'reaction_set' });
    expect(t('message_reactions')).toEqual([
      expect.objectContaining({
        message_id: t('messages')[0].id,
        conversation_id: t('conversations')[0].id,
        actor_type: 'customer',
        actor_id: t('contacts')[0].id,
        emoji: '👍',
      }),
    ]);
    expect(t('messages')).toHaveLength(1);
    expect(state.rpcCalls).toHaveLength(rpcBefore);
  });

  it('a second reaction from the same contact replaces the first', async () => {
    await withTarget();
    await ingest(reaction('👍'));
    await ingest(reaction('❤️', 'wamid.T1', 'wamid.R2'));
    expect(t('message_reactions')).toHaveLength(1);
    expect(t('message_reactions')[0].emoji).toBe('❤️');
  });

  it('an empty emoji removes the reaction', async () => {
    await withTarget();
    await ingest(reaction('👍'));
    const [r] = await ingest(reaction('', 'wamid.T1', 'wamid.R2'));
    expect(r).toMatchObject({ status: 'reaction_removed' });
    expect(t('message_reactions')).toHaveLength(0);
  });

  it('a reaction to an unknown message is skipped without error', async () => {
    await withTarget();
    const [r] = await ingest(reaction('👍', 'wamid.NOPE'));
    expect(r).toMatchObject({
      status: 'skipped',
      reason: 'reaction target not found',
    });
    expect(t('message_reactions')).toHaveLength(0);
    expect(t('messages')).toHaveLength(1);
  });

  it('a reaction from an unknown sender opens the thread and fires onConversationCreated', async () => {
    const onConversationCreated = vi.fn();
    const [r] = await ingestInbound(
      db,
      CONN,
      await inboundEvents(reaction('👍')),
      {
        ...OPTS,
        hooks: { onConversationCreated },
      }
    );
    expect(onConversationCreated).toHaveBeenCalledTimes(1);
    expect(t('conversations')).toHaveLength(1);
    expect(r).toMatchObject({ status: 'skipped' }); // no target yet
  });
});

describe('createMediaResolver + ingestInbound: inbound media', () => {
  const upload = vi.fn();
  const storage = {
    from: () => ({
      upload,
      getPublicUrl: (p: string) => ({
        data: { publicUrl: `https://cdn/${p}` },
      }),
    }),
  };
  const IMAGE = {
    id: 'wamid.IMG1',
    type: 'image',
    image: { id: 'media-9', mime_type: 'image/jpeg', caption: 'look' },
  };
  const downloadMedia = vi.fn();
  const run = async (conn: Connection, prov = { downloadMedia }) =>
    ingestInbound(db, conn, await inboundEvents(IMAGE), {
      ...OPTS,
      hooks: { resolveMedia: createMediaResolver({ provider: prov, storage }) },
    });

  beforeEach(() => {
    upload.mockReset().mockResolvedValue({ error: null });
    downloadMedia
      .mockReset()
      .mockResolvedValue(
        new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
      );
  });

  it('mirrors through provider.downloadMedia into the account folder (option on by default)', async () => {
    const [r] = await run(CONN);
    expect(downloadMedia).toHaveBeenCalledWith(
      CONN,
      expect.objectContaining({ id: 'media-9' })
    );
    expect(upload).toHaveBeenCalledTimes(1);
    const url = (r as { mediaUrl: string }).mediaUrl;
    expect(url).toMatch(/^https:\/\/cdn\/account-acct-1\/inbound\//);
    expect(t('messages')[0]).toMatchObject({
      media_url: url,
      media_type: 'image/jpeg',
      content_text: 'look',
    });
  });

  it('mirror_inbound_media=false keeps the Meta proxy URL and downloads nothing', async () => {
    const conn = {
      ...CONN,
      config: { mirror_inbound_media: false },
    } as Connection;
    await run(conn);
    expect(downloadMedia).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(t('messages')[0].media_url).toBe('/api/whatsapp/media/media-9');
  });

  it('a refused upload falls back to the proxy URL', async () => {
    upload.mockResolvedValue({ error: { message: 'mime not allowed' } });
    await run(CONN);
    expect(t('messages')[0].media_url).toBe('/api/whatsapp/media/media-9');
  });

  it('a failing provider download stores no URL (as when Meta refused the lookup) and still stores the message', async () => {
    downloadMedia.mockRejectedValue(new Error('Media fetch failed: 400'));
    const [r] = await run(CONN);
    expect(r).toMatchObject({ status: 'stored' });
    expect(t('messages')[0].media_url).toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it('other channels get no proxy fallback', async () => {
    const conn = {
      ...CONN,
      channel_type: 'telegram',
      config: { mirror_inbound_media: false },
    } as Connection;
    await run(conn);
    expect(t('messages')[0].media_url).toBeNull();
  });
});

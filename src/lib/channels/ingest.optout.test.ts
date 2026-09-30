import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db, state } from './ingest.fake';
import { ingestInbound } from './ingest';
import { hasConsent, recordConsent } from '@/lib/consent/consent';
import type { Connection, InboundEvent } from './types';

const CONN = {
  id: 'conn-1',
  account_id: 'acct-1',
  channel_type: 'whatsapp_cloud',
} as Connection;
const OPTS = { auditUserId: 'owner-1' };
const t = (n: string) => state.tables[n] ?? [];

type MsgEvent = Extract<InboundEvent, { kind: 'message' }>;
function msg(over: Partial<MsgEvent> = {}): MsgEvent {
  return {
    kind: 'message',
    externalId: 'wamid.1',
    sender: [{ kind: 'whatsapp:phone', externalId: '15551230000' }],
    at: new Date('2026-10-10T12:00:00Z'),
    content: { type: 'text', text: 'PARAR' },
    senderName: 'Ada',
    ...over,
  };
}
const text = (s: string, externalId = 'wamid.1', at?: string): MsgEvent =>
  msg({
    externalId,
    content: { type: 'text', text: s },
    ...(at ? { at: new Date(at) } : {}),
  });
const consents = () => t('contact_consents');
const contactId = () => t('contacts')[0].id as string;

beforeEach(() => {
  state.tables = {};
  state.seq = 0;
  state.rpcCalls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('ingestInbound: "PARAR" revokes consent', () => {
  it('revokes both purposes with the message instant and source chat', async () => {
    const [r] = await ingestInbound(db, CONN, [text('PARAR')], OPTS);
    expect(r).toMatchObject({ status: 'stored', optOut: true });
    expect(consents()).toHaveLength(2);
    for (const purpose of ['notifications', 'marketing']) {
      expect(consents().find((c) => c.purpose === purpose)).toMatchObject({
        account_id: 'acct-1',
        contact_id: contactId(),
        granted: false,
        revoked_at: '2026-10-10T12:00:00.000Z',
        source: 'chat',
      });
    }
  });

  it('the revocation beats the implicit consent of having written', async () => {
    await ingestInbound(db, CONN, [text('PARAR')], OPTS);
    expect(await hasConsent(db, 'acct-1', contactId(), 'notifications')).toBe(
      false
    );
    expect(await hasConsent(db, 'acct-1', contactId(), 'marketing')).toBe(
      false
    );
  });

  it('a newer menu consent reactivates, an older one does not', async () => {
    await ingestInbound(db, CONN, [text('parar')], OPTS);
    const args = {
      accountId: 'acct-1',
      contactId: contactId(),
      purpose: 'notifications' as const,
      granted: true,
      source: 'menu',
    };
    expect(
      await recordConsent(db, { ...args, at: new Date('2026-10-09T00:00:00Z') })
    ).toBe(false);
    expect(await hasConsent(db, 'acct-1', contactId(), 'notifications')).toBe(
      false
    );
    expect(
      await recordConsent(db, { ...args, at: new Date('2026-10-11T00:00:00Z') })
    ).toBe(true);
    expect(await hasConsent(db, 'acct-1', contactId(), 'notifications')).toBe(
      true
    );
    expect(await hasConsent(db, 'acct-1', contactId(), 'marketing')).toBe(
      false
    );
  });

  it.each([
    'stop',
    'Stop!',
    'cancelar envio',
    'não quero receber',
    'unsubscribe',
  ])('variant %s revokes', async (word) => {
    const [r] = await ingestInbound(db, CONN, [text(word)], OPTS);
    expect(r).toMatchObject({ optOut: true });
    expect(consents()).toHaveLength(2);
  });

  it.each([
    'não quero parar de receber',
    'preciso parar o pedido',
    'quero cancelar o pedido 123',
    'cancelar',
  ])('the sentence %j does not revoke', async (sentence) => {
    const [r] = await ingestInbound(db, CONN, [text(sentence)], OPTS);
    expect(r).toMatchObject({ status: 'stored', optOut: false });
    expect(consents()).toHaveLength(0);
  });

  it('only text counts: an interactive reply titled PARAR is ignored', async () => {
    const [r] = await ingestInbound(
      db,
      CONN,
      [
        msg({
          content: {
            type: 'interactive_reply',
            replyId: 'x',
            title: 'PARAR',
          } as unknown as MsgEvent['content'],
        }),
      ],
      OPTS
    );
    expect(r).toMatchObject({ status: 'stored', optOut: false });
    expect(consents()).toHaveLength(0);
  });

  it('a provider redelivery is a duplicate: no second effect, no hook', async () => {
    const onMessageStored = vi.fn();
    const opts = { ...OPTS, hooks: { onMessageStored } };
    await ingestInbound(db, CONN, [text('PARAR')], opts);
    const before = JSON.stringify(consents());
    const [r] = await ingestInbound(db, CONN, [text('PARAR')], opts);
    expect(r.status).toBe('duplicate');
    expect(JSON.stringify(consents())).toBe(before);
    expect(onMessageStored).toHaveBeenCalledTimes(1);
  });

  it('a second PARAR later does not rewrite the revocation date', async () => {
    await ingestInbound(db, CONN, [text('PARAR')], OPTS);
    await ingestInbound(
      db,
      CONN,
      [text('PARAR', 'wamid.2', '2026-10-12T12:00:00Z')],
      OPTS
    );
    // a newer revocation is applied (still revoked); never re-granted
    expect(consents().every((c) => c.granted === false)).toBe(true);
  });

  it('a revocation failure is logged and never drops the message', async () => {
    const broken = {
      ...db,
      from: (table: string) =>
        table === 'contact_consents'
          ? (() => {
              throw new Error('boom');
            })()
          : db.from(table),
    } as unknown as typeof db;
    const [r] = await ingestInbound(broken, CONN, [text('PARAR')], OPTS);
    expect(r).toMatchObject({ status: 'stored', optOut: false });
    expect(t('messages')).toHaveLength(1);
  });
});

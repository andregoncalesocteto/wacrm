/**
 * Characterization tests for broadcast delivery (US-004, channel-abstraction).
 * They pin the CURRENT behaviour of `deliverBroadcast` (per-recipient send,
 * `broadcast_recipients` stamping, best-effort loop) and of
 * `finalizeBroadcastStatus` / `markBroadcastSending`, including a resume pass
 * that only delivers the leftovers. Only the Meta template sender is stubbed;
 * phone variants are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { whatsappConnectionRow } from '@/lib/channels/credentials-admin.fake';
import type { ChannelConnection } from '@/lib/channels/connections';
import { phoneVariants } from './phone-utils';
import {
  deliverBroadcast,
  finalizeBroadcastStatus,
  type BroadcastPlan,
} from './broadcast-core';
import { markBroadcastSending } from './broadcast-resume';

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  sendTemplateMessage: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendTemplateMessage: h.sendTemplateMessage,
}));

// Credentials come from channel_connection_credentials through the provider.
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: () => 'tok' }));
vi.mock('@/lib/channels/admin-client', async () => {
  const { fakeCredentialsAdmin } =
    await import('@/lib/channels/credentials-admin.fake');
  return {
    supabaseAdmin: () =>
      fakeCredentialsAdmin(() => ({
        secrets_encrypted: 'enc',
        secrets_format: 'wa_token_v0',
      })),
  };
});

function fakeDb(): SupabaseClient {
  class Query {
    private op: 'select' | 'update' = 'select';
    private payload: Row = {};
    private filters: ((r: Row) => boolean)[] = [];
    private head = false;
    constructor(private table: string) {}
    select(_c?: string, opts?: { head?: boolean }) {
      this.head = !!opts?.head;
      return this;
    }
    update(patch: Row) {
      this.op = 'update';
      this.payload = patch;
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push((r) => r[col] === v);
      return this;
    }
    private run() {
      const rows = (h.db[this.table] ??= []);
      const out = rows.filter((r) => this.filters.every((f) => f(r)));
      if (this.op === 'update') {
        for (const r of out) Object.assign(r, this.payload);
        return { data: null, error: null };
      }
      return { data: this.head ? null : out, count: out.length, error: null };
    }
    then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
      return Promise.resolve(this.run()).then(resolve, reject);
    }
  }
  return { from: (t: string) => new Query(t) } as unknown as SupabaseClient;
}

const NOT_ALLOWED = '(#131030) Recipient phone number not in allowed list';

function recipient(id: string, status = 'pending', broadcast = 'bc-1'): Row {
  return { id, broadcast_id: broadcast, status, error_message: null };
}

function plan(ids: string[], phones?: string[]): BroadcastPlan {
  return {
    broadcastId: 'bc-1',
    templateName: 'promo',
    templateLanguage: 'pt_BR',
    connection: whatsappConnectionRow(
      'acc',
      'pn-1'
    ) as unknown as ChannelConnection,
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
    templateRow: null,
    planned: ids.map((id, i) => ({
      recipientRowId: id,
      phone: phones?.[i] ?? `+1555000000${i}`,
      params: [`p${i}`],
    })),
    rejected: 0,
  };
}

const row = (id: string) => h.db.broadcast_recipients.find((r) => r.id === id)!;
const broadcast = () => h.db.broadcasts[0];

beforeEach(() => {
  h.sendTemplateMessage.mockResolvedValue({ messageId: 'wamid.ok' });
  h.db = {
    broadcasts: [{ id: 'bc-1', status: 'sending' }],
    broadcast_recipients: [],
  };
});

describe('deliverBroadcast', () => {
  it('sends one template per recipient with frozen params and stamps the row sent', async () => {
    h.db.broadcast_recipients = [recipient('r1'), recipient('r2')];
    h.sendTemplateMessage
      .mockResolvedValueOnce({ messageId: 'wamid.1' })
      .mockResolvedValueOnce({ messageId: 'wamid.2' });

    await deliverBroadcast(fakeDb(), plan(['r1', 'r2']));

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(2);
    expect(h.sendTemplateMessage.mock.calls[0][0]).toMatchObject({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      to: phoneVariants('+15550000000')[0],
      templateName: 'promo',
      language: 'pt_BR',
      params: ['p0'],
    });
    expect(row('r1')).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'wamid.1',
      error_message: null,
    });
    expect(typeof row('r1').sent_at).toBe('string');
    expect(row('r2')).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'wamid.2',
    });
    expect(broadcast().status).toBe('sent');
  });

  it('marks a recipient failed with the error message and keeps going', async () => {
    h.db.broadcast_recipients = [recipient('r1'), recipient('r2')];
    h.sendTemplateMessage
      .mockRejectedValueOnce(new Error('(#132000) Param mismatch'))
      .mockResolvedValueOnce({ messageId: 'wamid.2' });

    await deliverBroadcast(fakeDb(), plan(['r1', 'r2']));

    expect(row('r1')).toMatchObject({
      status: 'failed',
      error_message: '(#132000) Param mismatch',
    });
    expect(row('r1').whatsapp_message_id).toBeUndefined();
    expect(row('r2').status).toBe('sent');
    // Only one failure among two: the broadcast as a whole is `sent`.
    expect(broadcast().status).toBe('sent');
  });

  it('does not try another phone variant on an error other than "recipient not allowed"', async () => {
    h.db.broadcast_recipients = [recipient('r1')];
    h.sendTemplateMessage.mockRejectedValue(new Error('boom'));

    await deliverBroadcast(fakeDb(), plan(['r1']));

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(row('r1')).toMatchObject({
      status: 'failed',
      error_message: 'boom',
    });
  });

  it('retries the next phone variant on "recipient not allowed" and records the success', async () => {
    h.db.broadcast_recipients = [recipient('r1')];
    const variants = phoneVariants('+15551234567');
    expect(variants.length).toBeGreaterThan(1);
    h.sendTemplateMessage
      .mockRejectedValueOnce(new Error(NOT_ALLOWED))
      .mockResolvedValueOnce({ messageId: 'wamid.v2' });

    await deliverBroadcast(fakeDb(), plan(['r1'], ['+15551234567']));

    expect(h.sendTemplateMessage.mock.calls.map((c) => c[0].to)).toEqual(
      variants.slice(0, 2)
    );
    expect(row('r1')).toMatchObject({
      status: 'sent',
      whatsapp_message_id: 'wamid.v2',
      error_message: null,
    });
  });

  it('fails the recipient with the last error once every variant is refused', async () => {
    h.db.broadcast_recipients = [recipient('r1')];
    h.sendTemplateMessage.mockRejectedValue(new Error(NOT_ALLOWED));

    await deliverBroadcast(fakeDb(), plan(['r1'], ['+15551234567']));

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(
      phoneVariants('+15551234567').length
    );
    expect(row('r1')).toMatchObject({
      status: 'failed',
      error_message: NOT_ALLOWED,
    });
  });

  it('records "Unknown error" for a non-Error rejection', async () => {
    h.db.broadcast_recipients = [recipient('r1')];
    h.sendTemplateMessage.mockRejectedValue('nope');

    await deliverBroadcast(fakeDb(), plan(['r1']));

    expect(row('r1')).toMatchObject({
      status: 'failed',
      error_message: 'Unknown error',
    });
  });

  it('marks the broadcast failed when every recipient fails', async () => {
    h.db.broadcast_recipients = [recipient('r1'), recipient('r2')];
    h.sendTemplateMessage.mockRejectedValue(new Error('boom'));

    await deliverBroadcast(fakeDb(), plan(['r1', 'r2']));

    expect(row('r1').status).toBe('failed');
    expect(row('r2').status).toBe('failed');
    expect(broadcast().status).toBe('failed');
  });

  it('only touches the recipients of its own plan', async () => {
    h.db.broadcast_recipients = [
      recipient('r1'),
      recipient('other', 'pending', 'bc-2'),
    ];

    await deliverBroadcast(fakeDb(), plan(['r1']));

    expect(row('other').status).toBe('pending');
  });
});

describe('finalizeBroadcastStatus', () => {
  it('leaves the broadcast sending while a recipient is still pending', async () => {
    h.db.broadcast_recipients = [recipient('r1', 'sent'), recipient('r2')];
    await finalizeBroadcastStatus(fakeDb(), 'bc-1');
    expect(broadcast().status).toBe('sending');
    expect(broadcast().updated_at).toBeUndefined();
  });

  it('is sent when at least one recipient reached Meta, even with failures', async () => {
    h.db.broadcast_recipients = [
      recipient('r1', 'sent'),
      recipient('r2', 'failed'),
    ];
    await finalizeBroadcastStatus(fakeDb(), 'bc-1');
    expect(broadcast().status).toBe('sent');
    expect(typeof broadcast().updated_at).toBe('string');
  });

  it('is failed only when every recipient failed', async () => {
    h.db.broadcast_recipients = [
      recipient('r1', 'failed'),
      recipient('r2', 'failed'),
    ];
    await finalizeBroadcastStatus(fakeDb(), 'bc-1');
    expect(broadcast().status).toBe('failed');
  });

  it('counts delivered/read/replied recipients as reached (sent)', async () => {
    h.db.broadcast_recipients = [
      recipient('r1', 'delivered'),
      recipient('r2', 'read'),
      recipient('r3', 'replied'),
      recipient('r4', 'failed'),
    ];
    await finalizeBroadcastStatus(fakeDb(), 'bc-1');
    expect(broadcast().status).toBe('sent');
  });

  it('is sent (not failed) for a broadcast with no recipient rows', async () => {
    await finalizeBroadcastStatus(fakeDb(), 'bc-1');
    expect(broadcast().status).toBe('sent');
  });
});

describe('resume pass', () => {
  it('marks sending, delivers only the leftovers and does not condemn the campaign', async () => {
    h.db.broadcasts = [{ id: 'bc-1', status: 'sent' }];
    h.db.broadcast_recipients = [
      recipient('r1', 'sent'),
      recipient('r2', 'sent'),
      recipient('r3', 'failed'),
    ];
    h.sendTemplateMessage.mockRejectedValue(new Error('still down'));

    await markBroadcastSending(fakeDb(), 'bc-1');
    expect(broadcast().status).toBe('sending');

    // Resume retries only r3; it fails again but the earlier sends stand.
    await deliverBroadcast(fakeDb(), plan(['r3']));

    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(row('r3')).toMatchObject({
      status: 'failed',
      error_message: 'still down',
    });
    expect(row('r1').status).toBe('sent');
    expect(broadcast().status).toBe('sent');
  });

  it('a capped pass that leaves recipients pending keeps the broadcast sending', async () => {
    h.db.broadcast_recipients = [
      recipient('r1'),
      recipient('r2'),
      recipient('r3'),
    ];

    await deliverBroadcast(fakeDb(), plan(['r1']));

    expect(row('r1').status).toBe('sent');
    expect(row('r2').status).toBe('pending');
    expect(broadcast().status).toBe('sending');
  });

  it('a resume that sends the last leftovers finalizes the campaign as sent', async () => {
    h.db.broadcast_recipients = [recipient('r1', 'sent'), recipient('r2')];

    await deliverBroadcast(fakeDb(), plan(['r2']));

    expect(broadcast().status).toBe('sent');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  inboundPatch,
  ingestFailurePatch,
  outboundSuccessPatch,
  recordConnectionEvent,
  sendErrorPatch,
} from './connection-state';

const NOW = new Date('2026-01-02T03:04:05.000Z');
const ISO = NOW.toISOString();
const CLEARED = { status: 'connected', last_error: null, last_error_at: null };

describe('connection state transitions', () => {
  it('inbound message stamps last_inbound_at only when the connection is healthy', () => {
    expect(inboundPatch({ status: 'connected' }, NOW)).toEqual({
      last_inbound_at: ISO,
    });
    expect(inboundPatch({ status: 'degraded' }, NOW)).toEqual({
      last_inbound_at: ISO,
    });
  });

  it('inbound message clears needs_action', () => {
    expect(inboundPatch({ status: 'needs_action' }, NOW)).toEqual({
      last_inbound_at: ISO,
      ...CLEARED,
    });
  });

  it('successful send stamps last_outbound_at and clears needs_action', () => {
    expect(outboundSuccessPatch({ status: 'connected' }, NOW)).toEqual({
      last_outbound_at: ISO,
    });
    expect(outboundSuccessPatch({ status: 'needs_action' }, NOW)).toEqual({
      last_outbound_at: ISO,
      ...CLEARED,
    });
  });

  it('an auth send error marks needs_action with the error', () => {
    expect(
      sendErrorPatch({ code: 'auth', message: 'token expired' }, NOW)
    ).toEqual({
      status: 'needs_action',
      last_error: { code: 'auth', message: 'token expired' },
      last_error_at: ISO,
    });
  });

  it.each([
    'rate_limited',
    'recipient_unreachable',
    'window_closed',
    'unknown',
  ])('a %s send error does not change the state', (code) => {
    expect(sendErrorPatch({ code, message: 'x' }, NOW)).toBeNull();
  });

  it('an ingestion failure records code and message, leaving status alone', () => {
    expect(
      ingestFailurePatch(
        { code: 'ingest_failed', message: 'insert failed' },
        NOW
      )
    ).toEqual({
      last_error: { code: 'ingest_failed', message: 'insert failed' },
      last_error_at: ISO,
    });
  });
});

describe('recordConnectionEvent', () => {
  const dbWith = (result: unknown) => {
    const eq = vi.fn(async () => result);
    const update = vi.fn(() => ({ eq }));
    return {
      db: { from: vi.fn(() => ({ update })) } as unknown as SupabaseClient,
      update,
      eq,
    };
  };

  it('updates the connection by id', async () => {
    const { db, update, eq } = dbWith({ error: null });
    await recordConnectionEvent(db, 'c1', { last_inbound_at: ISO });
    expect(update).toHaveBeenCalledWith({ last_inbound_at: ISO });
    expect(eq).toHaveBeenCalledWith('id', 'c1');
  });

  it('writes nothing for a null or empty patch', async () => {
    const { db, update } = dbWith({ error: null });
    await recordConnectionEvent(db, 'c1', null);
    await recordConnectionEvent(db, 'c1', {});
    expect(update).not.toHaveBeenCalled();
  });

  it('never throws when the update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = dbWith({ error: { message: 'down' } });
    await expect(
      recordConnectionEvent(db, 'c1', { last_inbound_at: ISO })
    ).resolves.toBeUndefined();
  });
});

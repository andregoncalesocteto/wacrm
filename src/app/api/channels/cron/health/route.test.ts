import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ id: unknown; patch: Record<string, unknown> }>,
  isFilter: null as [string, unknown] | null,
  health: vi.fn(),
  scanError: null as { message: string } | null,
}));

vi.mock('@/lib/channels/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        is: (col: string, val: unknown) => {
          h.isFilter = [col, val];
          return Promise.resolve({
            data: h.scanError ? null : h.rows.filter((r) => r[col] === val),
            error: h.scanError,
          });
        },
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_c: string, id: unknown) => {
          h.updates.push({ id, patch });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  }),
}));
vi.mock('@/lib/channels/providers', () => ({
  registerBuiltinProviders: () => {},
}));
vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({ health: h.health }),
}));

import { GET } from './route';

const req = (secret?: string) =>
  new Request('http://x/api/channels/cron/health', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  });

beforeEach(() => {
  process.env.AUTOMATION_CRON_SECRET = 's3cret';
  h.rows = [
    {
      id: 'a',
      channel_type: 'telegram',
      status: 'connected',
      disabled_at: null,
    },
    {
      id: 'b',
      channel_type: 'whatsapp_cloud',
      status: 'needs_action',
      disabled_at: null,
    },
    {
      id: 'off',
      channel_type: 'telegram',
      status: 'connected',
      disabled_at: '2026-01-01',
    },
  ];
  h.updates = [];
  h.scanError = null;
  h.health.mockReset();
});

describe('GET /api/channels/cron/health', () => {
  it('is 503 without the cron secret configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;
    expect((await GET(req('s3cret'))).status).toBe(503);
    expect(h.health).not.toHaveBeenCalled();
  });

  it('is 401 with a missing or wrong secret', async () => {
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req('wrong!'))).status).toBe(401);
    expect(h.health).not.toHaveBeenCalled();
  });

  it('checks only active connections and stores state + last_health_check_at', async () => {
    h.health.mockImplementation(async (c: { id: string }) =>
      c.id === 'a'
        ? { state: 'degraded', reason: 'slow', checkedAt: new Date() }
        : { state: 'connected', checkedAt: new Date() }
    );
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({ checked: 2, failed: 0 });
    expect(h.isFilter).toEqual(['disabled_at', null]);
    expect(h.health).toHaveBeenCalledTimes(2);
    expect(h.updates.map((u) => u.id)).toEqual(['a', 'b']);
    const a = h.updates[0].patch;
    expect(a).toMatchObject({
      status: 'degraded',
      last_error: { code: 'health', message: 'slow' },
    });
    expect(typeof a.last_health_check_at).toBe('string');
    // needs_action -> connected clears the error
    expect(h.updates[1].patch).toMatchObject({
      status: 'connected',
      last_error: null,
      last_error_at: null,
    });
  });

  it('keeps sweeping when one provider check throws', async () => {
    h.health.mockRejectedValueOnce(new Error('boom'));
    h.health.mockResolvedValueOnce({
      state: 'connected',
      checkedAt: new Date(),
    });
    const res = await GET(req('s3cret'));
    expect(await res.json()).toEqual({ checked: 1, failed: 1 });
    expect(h.updates.map((u) => u.id)).toEqual(['b']);
  });

  it('is 500 when the scan fails', async () => {
    h.scanError = { message: 'db down' };
    expect((await GET(req('s3cret'))).status).toBe(500);
  });
});

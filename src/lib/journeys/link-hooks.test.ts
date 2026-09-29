import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ run: vi.fn(), open: vi.fn() }));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.run,
}));
vi.mock('./journeys', () => ({ openOrRenewJourney: h.open }));

import { onMenuLinkSent } from './link-hooks';
import { recordMenuLinkSent } from './menu-link-send';

const db = {} as SupabaseClient;
const journey = {
  id: 'jr-1',
  stage: 'link_sent',
  link_sent_at: '2026-09-29T12:00:00.000Z',
};

beforeEach(() => {
  h.run.mockReset();
  h.open.mockReset().mockResolvedValue(journey);
});

describe('onMenuLinkSent', () => {
  it('dispatches menu_link_sent with contact, conversation, connection and Journey', async () => {
    await onMenuLinkSent(db, {
      accountId: 'acct-1',
      contactId: 'ct-1',
      conversationId: 'cv-1',
      connectionId: 'conn-1',
      journey: journey as never,
    });
    expect(h.run).toHaveBeenCalledWith({
      accountId: 'acct-1',
      triggerType: 'menu_link_sent',
      contactId: 'ct-1',
      context: {
        conversation_id: 'cv-1',
        connection_id: 'conn-1',
        journey_id: 'jr-1',
        journey_stage: 'link_sent',
        menu_link_sent_at: '2026-09-29T12:00:00.000Z',
      },
    });
  });

  it('never throws', async () => {
    h.run.mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      onMenuLinkSent(db, {
        accountId: 'a',
        contactId: 'c',
        conversationId: 'v',
        connectionId: 'n',
        journey: journey as never,
      })
    ).resolves.toBeUndefined();
  });
});

describe('recordMenuLinkSent', () => {
  it('opens the Journey, then fires the menu_link_sent trigger (automation and AI paths share it)', async () => {
    const result = await recordMenuLinkSent(db, {
      accountId: 'acct-1',
      userId: 'u-1',
      conversationId: 'cv-1',
      contactId: 'ct-1',
      connectionId: 'conn-1',
    });
    expect(result).toBe(journey);
    expect(h.open.mock.invocationCallOrder[0]).toBeLessThan(
      h.run.mock.invocationCallOrder[0]
    );
    expect(h.run.mock.calls[0][0]).toMatchObject({
      triggerType: 'menu_link_sent',
      contactId: 'ct-1',
    });
  });
});

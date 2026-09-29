import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: run }));

import { onJourneyEventAccepted } from './event-hooks';

const db = {} as SupabaseClient;

beforeEach(() => run.mockReset());

describe('onJourneyEventAccepted', () => {
  it('dispatches the journey_event trigger with the event context', async () => {
    await onJourneyEventAccepted(db, {
      accountId: 'acct-1',
      eventId: 'ev-1',
      name: 'Purchase',
      occurredAt: new Date(),
      journeyId: 'jr-1',
      contactId: 'ct-1',
      conversationId: 'cv-1',
      connectionId: 'conn-1',
      stage: 'won',
      properties: { total: 10 },
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({
      accountId: 'acct-1',
      triggerType: 'journey_event',
      contactId: 'ct-1',
      context: {
        conversation_id: 'cv-1',
        connection_id: 'conn-1',
        journey_id: 'jr-1',
        journey_event_id: 'ev-1',
        journey_event_name: 'Purchase',
        journey_event_properties: { total: 10 },
        journey_stage: 'won',
      },
    });
  });

  it('defaults properties to an empty object', async () => {
    await onJourneyEventAccepted(db, {
      accountId: 'a',
      eventId: 'e',
      name: 'ViewContent',
      occurredAt: new Date(),
      journeyId: 'j',
      contactId: 'c',
      conversationId: 'v',
      connectionId: 'n',
      stage: 'browsing',
    });
    expect(run.mock.calls[0][0].context.journey_event_properties).toEqual({});
  });
});

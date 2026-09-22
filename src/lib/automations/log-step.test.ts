import { describe, expect, it } from 'vitest';
import { logStepView } from './log-step';

const base = { step_id: 's', step_type: 'send_template' as const };

describe('logStepView', () => {
  it('skipped is neutral and the engine reason becomes translatable', () => {
    expect(
      logStepView({
        ...base,
        status: 'skipped',
        detail:
          'ignored: contact has no conversation on a connection that supports templates',
      })
    ).toEqual({ tone: 'skipped', ignoredCapability: 'templates' });
  });
  it('keeps other details as recorded', () => {
    expect(logStepView({ ...base, status: 'skipped', detail: 'x' })).toEqual({
      tone: 'skipped',
      detail: 'x',
    });
    expect(logStepView({ ...base, status: 'failed', detail: 'boom' })).toEqual({
      tone: 'failed',
      detail: 'boom',
    });
    expect(logStepView({ ...base, status: 'success' }).tone).toBe('success');
  });
});

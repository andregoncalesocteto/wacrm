import type { AutomationLogStepResult } from '@/types';

/**
 * How the automation logs page shows one step result. `skipped` (ignored with
 * a reason, e.g. US-028) is neutral, not a failure. The engine's stable English
 * "ignored: ... supports <capability>" detail is mapped to a translatable
 * message; any other detail is shown as recorded.
 */
export type LogStepView =
  | {
      tone: 'success' | 'skipped' | 'failed';
      detail?: string;
      ignoredCapability?: undefined;
    }
  | { tone: 'skipped'; ignoredCapability: string; detail?: undefined };

const IGNORED_RE =
  /^ignored: contact has no conversation on (?:a|an enabled) connection that supports (\w+)$/;

export function logStepView(result: AutomationLogStepResult): LogStepView {
  const tone =
    result.status === 'success'
      ? 'success'
      : result.status === 'skipped'
        ? 'skipped'
        : 'failed';
  const m = tone === 'skipped' ? IGNORED_RE.exec(result.detail ?? '') : null;
  if (m) return { tone: 'skipped', ignoredCapability: m[1] };
  return { tone, detail: result.detail };
}

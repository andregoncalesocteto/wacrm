'use client';

import { useMemo } from 'react';
import { StepWarnings } from '@/components/channels/step-warnings';
import { stepRequirements } from '@/lib/channels/step-capabilities';
import { useFlowEditor } from './flow-editor-state';

/** Channel-capability heads-up for the flow's steps (informational). */
export function FlowStepWarnings() {
  const { state } = useFlowEditor();
  const requirements = useMemo(
    () => stepRequirements(state.nodes),
    [state.nodes]
  );
  return (
    <div className="mt-2 empty:hidden">
      <StepWarnings requirements={requirements} />
    </div>
  );
}

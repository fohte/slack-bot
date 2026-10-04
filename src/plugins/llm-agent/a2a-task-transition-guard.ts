import type { A2aTaskLifecycle } from '#plugins/llm-agent/a2a-task-tracker'

// input-required stays unsettled, so the active-execution guard prevents
// concurrent observations from both committing the same transition.
export const transitionGuard = (
  to: A2aTaskLifecycle,
  activeExecutionStates: readonly A2aTaskLifecycle['state'][],
) =>
  to.requireCurrentStates !== undefined
    ? { requireStates: to.requireCurrentStates }
    : to.state === 'failed' || to.state === 'input-required'
      ? { requireStates: activeExecutionStates }
      : {}

import type { A2aTaskLifecycle } from '#plugins/llm-agent/a2a-task-tracker'

type A2aTaskState = A2aTaskLifecycle['state']

export const A2A_TASK_ACTIVE_EXECUTION_STATES: readonly A2aTaskState[] = [
  'submitted',
  'working',
]

interface TransitionGuard {
  readonly requireStates?: readonly A2aTaskState[]
}

// input-required stays unsettled, so the active-execution guard prevents
// concurrent observations from both committing the same transition.
export const transitionGuard = (to: A2aTaskLifecycle): TransitionGuard =>
  to.requireCurrentStates !== undefined
    ? { requireStates: to.requireCurrentStates }
    : to.state === 'failed' || to.state === 'input-required'
      ? { requireStates: A2A_TASK_ACTIVE_EXECUTION_STATES }
      : {}

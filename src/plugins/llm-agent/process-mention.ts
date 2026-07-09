import type {
  ProcessMentionDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention-deps'
import { respond } from '@/plugins/llm-agent/steps/respond'
import type { WaitForCompletionOptions } from '@/plugins/llm-agent/steps/wait-for-completion'
import { waitForCompletion } from '@/plugins/llm-agent/steps/wait-for-completion'

export type {
  ProcessMentionDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention-deps'
export {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SUCCESS_FALLBACK,
  DEFAULT_TASK_CR_AGENT_NAME,
  DEFAULT_TASK_CR_NAMESPACE,
} from '@/plugins/llm-agent/process-mention-deps'
export type { RespondResult } from '@/plugins/llm-agent/steps/respond'
export { respond } from '@/plugins/llm-agent/steps/respond'
export type { SubmitTaskResult } from '@/plugins/llm-agent/steps/submit-task'
export { submitTask } from '@/plugins/llm-agent/steps/submit-task'
export type {
  TerminalOutcome,
  WaitForCompletionOptions,
} from '@/plugins/llm-agent/steps/wait-for-completion'
export {
  bubbleForK8sPhase,
  PREPARING_BUBBLE,
  QUEUED_BUBBLE,
  RUNNING_BUBBLE,
  terminalOutcomeForTaskCrStatus,
  waitForCompletion,
} from '@/plugins/llm-agent/steps/wait-for-completion'

export const processMention = async (
  env: SlackEnvelope,
  taskName: string,
  deps: ProcessMentionDeps,
  options: WaitForCompletionOptions = {},
): Promise<void> => {
  const outcome = await waitForCompletion(env, taskName, deps, options)
  await respond(env, taskName, outcome, deps)
}

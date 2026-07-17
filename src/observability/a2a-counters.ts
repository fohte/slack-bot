import type { Counter } from '@opentelemetry/api'
import { metrics } from '@opentelemetry/api'

const INSTRUMENTATION_NAME = 'slack-bot'

export type A2aTaskOutcome = 'completed' | 'failed' | 'canceled' | 'rejected'

export type A2aPushNotificationResult =
  | 'unauthorized'
  | 'invalid_payload'
  | 'unknown_task'
  | 'settled'
  | 'input_required'
  | 'heartbeat'
  | 'duplicate'
  | 'error'

// Which fallback path settled a task the push notification path never
// reported: 'polling' covers a missed push recovered via tasks/get (or a
// TaskNotFound observed there), 'deadline' covers a submitted/working task
// that never updated before its deadline. A rising deadline count is an
// operational signal (remote agents failing to report), unlike polling.
export type A2aReconcilerSettledReason = 'polling' | 'deadline'

// Deferred until first use: metrics.getMeter(...) returns a ProxyMeter whose
// createCounter binds to whatever delegate is registered at that moment,
// so calling it before the OTel SDK starts would pin the counter to a noop
// forever (mirrors src/observability/counters.ts).
let tasksCounter: Counter | undefined
let pushNotificationsCounter: Counter | undefined
let reconcilerSettledCounter: Counter | undefined

const getTasksCounter = (): Counter => {
  tasksCounter ??= metrics
    .getMeter(INSTRUMENTATION_NAME)
    .createCounter('llm_agent.a2a.tasks.count', {
      description:
        'delegated A2A tasks reaching a terminal outcome, partitioned by remote agent and outcome',
      unit: '1',
    })
  return tasksCounter
}

const getPushNotificationsCounter = (): Counter => {
  pushNotificationsCounter ??= metrics
    .getMeter(INSTRUMENTATION_NAME)
    .createCounter('llm_agent.a2a.push_notifications.count', {
      description:
        'A2A push notifications received at the /api/a2a/notifications endpoint, partitioned by result',
      unit: '1',
    })
  return pushNotificationsCounter
}

const getReconcilerSettledCounter = (): Counter => {
  reconcilerSettledCounter ??= metrics
    .getMeter(INSTRUMENTATION_NAME)
    .createCounter('llm_agent.a2a.reconciler.settled.count', {
      description:
        'Delegated A2A tasks settled by the reconciler fallback path (a missed push recovered by polling, or a stale task failed by deadline), partitioned by reason',
      unit: '1',
    })
  return reconcilerSettledCounter
}

export const recordA2aTaskSettled = (
  agent: string,
  outcome: A2aTaskOutcome,
): void => {
  getTasksCounter().add(1, { agent, outcome })
}

export const recordA2aPushNotification = (
  result: A2aPushNotificationResult,
): void => {
  getPushNotificationsCounter().add(1, { result })
}

export const recordA2aReconcilerSettled = (
  reason: A2aReconcilerSettledReason,
): void => {
  getReconcilerSettledCounter().add(1, { reason })
}

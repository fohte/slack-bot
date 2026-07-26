import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import type { EventLogStore } from '@/plugins/llm-agent/event-log-store'
import { EventLogPruneError } from '@/types/errors'

export const EVENT_LOG_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const EVENT_LOG_DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000

export interface EventLogRetentionOptions {
  readonly eventLogStore: EventLogStore
  readonly ttlMs?: number | undefined
  readonly intervalMs?: number | undefined
  readonly logger?: Logger | undefined
  readonly now?: (() => number) | undefined
  readonly setIntervalImpl?:
    ((callback: () => void, ms: number) => NodeJS.Timeout) | undefined
  readonly clearIntervalImpl?: ((handle: NodeJS.Timeout) => void) | undefined
}

export interface EventLogRetentionHandle {
  stop(): void
  runOnce(): Promise<number>
}

export const startEventLogRetention = (
  options: EventLogRetentionOptions,
): EventLogRetentionHandle => {
  const logger = options.logger ?? noopLogger
  const ttlMs = options.ttlMs ?? EVENT_LOG_DEFAULT_TTL_MS
  const intervalMs = options.intervalMs ?? EVENT_LOG_DEFAULT_PRUNE_INTERVAL_MS
  const now = options.now ?? (() => Date.now())
  const setIntervalImpl = options.setIntervalImpl ?? setInterval
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval

  const runOnce = async (): Promise<number> => {
    const cutoff = new Date(now() - ttlMs)
    const result = await options.eventLogStore
      .pruneOlderThan(cutoff)
      .mapErr(
        (caughtErr) =>
          new EventLogPruneError('failed to prune event_log', caughtErr),
      )

    if (result.isErr()) {
      logger.error(
        { event: 'event_log_prune_failed', err: result.error.cause },
        'failed to prune event_log',
      )
      return 0
    }

    const removed = result.value
    if (removed > 0) {
      logger.info(
        {
          event: 'event_log_pruned',
          removed,
          cutoff: cutoff.toISOString(),
        },
        'pruned expired event_log rows',
      )
    }
    return removed
  }

  const timer = setIntervalImpl(() => {
    void runOnce()
  }, intervalMs)
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    ;(timer as { unref: () => void }).unref()
  }

  return {
    stop() {
      clearIntervalImpl(timer)
    },
    runOnce,
  }
}

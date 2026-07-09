import type { Logger } from '@/logger/logger'
import type { InFlightTasks } from '@/server/in-flight-tasks'

export interface CloseableServer {
  close(callback?: (err?: Error) => void): unknown
}

export interface ShutdownDeps {
  readonly server: CloseableServer
  readonly inFlightTasks: Pick<InFlightTasks, 'waitForIdle'>
  readonly logger: Logger
  readonly exit?: ((code: number) => void) | undefined
}

export type ShutdownHandler = (signal: string) => Promise<void>

// Keeps accepting requests and waits for whatever is already in flight
// (e.g. an llm-agent Task poll + Slack reply), plus anything newly accepted
// while draining, to finish before exiting — this deployment runs a single
// replica with no pod to hand new traffic off to mid-shutdown, so refusing
// new work early would only drop it. Relies on k8s SIGKILLing the process as
// the final backstop if a task never settles, rather than imposing our own
// shorter timeout.
export const createShutdownHandler = (deps: ShutdownDeps): ShutdownHandler => {
  const exit = deps.exit ?? ((code: number) => process.exit(code))
  let shuttingDown = false
  return async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    deps.logger.info(
      { event: 'shutdown_initiated', signal },
      'shutdown signal received; draining in-flight tasks before exit',
    )
    await deps.inFlightTasks.waitForIdle()
    await new Promise<void>((resolve) => {
      deps.server.close((err) => {
        if (err !== undefined) {
          deps.logger.error(
            { event: 'shutdown_server_close_failed', err },
            'failed to close http server',
          )
        }
        resolve()
      })
    })
    deps.logger.info(
      { event: 'shutdown_complete', signal },
      'in-flight tasks drained; exiting',
    )
    exit(0)
  }
}

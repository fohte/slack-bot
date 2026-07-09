import type { Logger } from '@/logger/logger'
import type { HealthEndpoint } from '@/server/health'
import type { InFlightTasks } from '@/server/in-flight-tasks'

export interface CloseableServer {
  close(callback?: (err?: Error) => void): unknown
}

export interface ShutdownDeps {
  readonly server: CloseableServer
  readonly health: Pick<HealthEndpoint, 'setNotReady'>
  readonly inFlightTasks: Pick<InFlightTasks, 'waitForIdle'>
  readonly logger: Logger
  readonly exit?: ((code: number) => void) | undefined
}

export type ShutdownHandler = (signal: string) => Promise<void>

// Stops accepting new work and waits for whatever is already in flight
// (e.g. an llm-agent Task poll + Slack reply) to finish before exiting, so a
// pod replacement during deploy never drops a response that was already
// accepted. Relies on k8s SIGKILLing the process as the final backstop if a
// task never settles, rather than imposing our own shorter timeout.
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
    // Flips first so a readinessProbe hitting /health/ready mid-drain
    // already sees this pod as unfit for new traffic.
    deps.health.setNotReady()
    deps.server.close((err) => {
      if (err !== undefined) {
        deps.logger.error(
          { event: 'shutdown_server_close_failed', err },
          'failed to close http server',
        )
      }
    })
    await deps.inFlightTasks.waitForIdle()
    deps.logger.info(
      { event: 'shutdown_complete', signal },
      'in-flight tasks drained; exiting',
    )
    exit(0)
  }
}

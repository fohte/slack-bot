import {
  createShutdownHandler as createServiceKitShutdownHandler,
  type ShutdownHandle,
} from '@fohte/service-kit/shutdown'

import type { Logger } from '#logger/logger'
import type { InFlightTasks } from '#server/in-flight-tasks'

export interface CloseableServer {
  close(callback?: (err?: Error) => void): unknown
}

export interface ShutdownDeps {
  readonly server: CloseableServer
  readonly inFlightTasks: Pick<InFlightTasks, 'waitForIdle'>
  readonly logger: Logger
  readonly exit?: ((code: number) => void) | undefined
}

export type { ShutdownHandle }

// Keeps accepting requests while draining: this deployment runs a single
// replica with no pod to hand new traffic off to mid-shutdown. Waits for
// whatever is already in flight (e.g. an llm-agent Task poll + Slack
// reply), plus anything newly accepted while draining, to finish before
// exiting. A task that never settles is terminated by k8s's SIGKILL
// backstop. Step order matters: draining must finish before the server is
// closed, since draining relies on the server still accepting requests.
export const createShutdownHandler = (deps: ShutdownDeps): ShutdownHandle =>
  createServiceKitShutdownHandler(
    [
      {
        name: 'drain_in_flight_tasks',
        run: () => deps.inFlightTasks.waitForIdle(),
      },
      {
        name: 'close_http_server',
        run: () =>
          new Promise<void>((resolve, reject) => {
            deps.server.close((err) => {
              if (err !== undefined) reject(err)
              else resolve()
            })
          }),
      },
    ],
    { logger: deps.logger, exit: deps.exit },
  )

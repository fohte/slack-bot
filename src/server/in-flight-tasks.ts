export interface InFlightTasks {
  readonly track: <T>(promise: Promise<T>) => Promise<T>
  readonly waitForIdle: () => Promise<void>
}

export const createInFlightTasks = (): InFlightTasks => {
  const pending = new Set<Promise<void>>()

  const track = <T>(promise: Promise<T>): Promise<T> => {
    // Normalized to never reject so a caller-swallowed rejection can't
    // surface here as an unhandled rejection while nothing is draining yet.
    const settled = promise.then(
      () => undefined,
      () => undefined,
    )
    pending.add(settled)
    void settled.then(() => pending.delete(settled))
    return promise
  }

  // Re-snapshots `pending` on every iteration so tasks tracked while a
  // drain is already in progress are also waited for before resolving.
  const waitForIdle = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.all(pending)
    }
  }

  return { track, waitForIdle }
}

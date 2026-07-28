export interface InFlightTurnKey {
  readonly channelId: string
  readonly ts: string
}

export interface InFlightTurnRegistry {
  readonly start: (key: InFlightTurnKey) => void
  readonly finish: (key: InFlightTurnKey) => void
  readonly has: (key: InFlightTurnKey) => boolean
}

const keyFor = (key: InFlightTurnKey): string => `${key.channelId}:${key.ts}`

// Tracks the (channel, ts) of every human-triggered turn this process is
// currently running, so a concurrent turn's thread-context sync (see
// steps/sync-thread-context.ts) can exclude a message that is mid-flight
// rather than inject content another turn is about to write to the
// checkpoint itself. Correct only because the bot runs a single replica.
export const createInFlightTurnRegistry = (): InFlightTurnRegistry => {
  const keys = new Set<string>()
  return {
    start: (key) => {
      keys.add(keyFor(key))
    },
    finish: (key) => {
      keys.delete(keyFor(key))
    },
    has: (key) => keys.has(keyFor(key)),
  }
}

export interface ThreadTurnQueue {
  readonly run: <T>(threadId: string, fn: () => Promise<T>) => Promise<T>
}

// Serializes calls sharing the same threadId so at most one is in flight at
// a time. ConversationAgent.respond()'s checkpointer does a read-then-write
// per call; two concurrent calls for the same thread_id can both read the
// same latest checkpoint and each write a child of it, silently dropping one
// turn's entire history (see ConversationAgent.respond's doc comment) —
// including any thread-context cursor it would otherwise have advanced.
export const createThreadTurnQueue = (): ThreadTurnQueue => {
  const tails = new Map<string, Promise<void>>()
  return {
    run: (threadId, fn) => {
      const prior = tails.get(threadId) ?? Promise.resolve()
      const result = prior.then(fn, fn)
      // Normalized to never reject so a caller-swallowed rejection can't
      // wedge the next queued call for this threadId.
      const settled = result.then(
        () => undefined,
        () => undefined,
      )
      tails.set(threadId, settled)
      // Only the last-registered tail for this threadId removes the entry,
      // so a call queued behind this one doesn't have its own tail evicted
      // by an earlier call settling after it was superseded.
      void settled.then(() => {
        if (tails.get(threadId) === settled) tails.delete(threadId)
      })
      return result
    },
  }
}

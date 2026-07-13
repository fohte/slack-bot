import { z } from 'zod'

// message/send's response is a remote agent's HTTP payload; only the shape
// this module's callers read (the task/message discriminator, and a task's
// id / contextId / status.state) is validated, so a malformed response is
// rejected here instead of throwing an uncaught TypeError further down.
export const SEND_MESSAGE_RESULT_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message') }).loose(),
  z
    .object({
      kind: z.literal('task'),
      id: z.string(),
      contextId: z.string(),
      status: z.object({ state: z.string() }).loose(),
    })
    .loose(),
])

export type SendMessageResult = z.infer<typeof SEND_MESSAGE_RESULT_SCHEMA>

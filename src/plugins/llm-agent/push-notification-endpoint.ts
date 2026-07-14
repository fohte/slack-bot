import { createHash, timingSafeEqual } from 'node:crypto'

import type { Context } from 'hono'
import { z } from 'zod'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import { recordA2aPushNotification } from '@/observability/a2a-counters'
import type { ResponseFinalizer } from '@/plugins/llm-agent/response-finalizer'

const NOTIFICATION_TOKEN_HEADER = 'x-a2a-notification-token'

// The push payload is an A2A Task (spec v0.3), but v1.0 changes the wire
// format, so its content is not trusted: only the taskId is read out of it,
// and authoritative state is always re-fetched via tasks/get.
const PUSH_PAYLOAD_SCHEMA = z.object({ id: z.string() }).loose()

// Hashing both sides to a fixed-length digest before comparing means the
// buffers passed to timingSafeEqual are always equal length, so no length
// check (and the token-length side-channel it would leak) is needed.
const isValidToken = (
  expected: string,
  provided: string | undefined,
): boolean => {
  if (provided === undefined) return false
  const expectedHash = createHash('sha256').update(expected).digest()
  const providedHash = createHash('sha256').update(provided).digest()
  return timingSafeEqual(expectedHash, providedHash)
}

export interface A2aNotificationHandlerOptions {
  readonly token: string
  readonly responseFinalizer: ResponseFinalizer
  readonly logger?: Logger | undefined
}

// This endpoint is not exposed on the Cloudflare Tunnel path used by Slack
// Request URLs; remote agents reach it directly inside the cluster, so
// bearer-token comparison (rather than Slack's HMAC scheme) is sufficient.
export const createA2aNotificationHandler = (
  options: A2aNotificationHandlerOptions,
) => {
  const logger = options.logger ?? noopLogger

  return async (c: Context): Promise<Response> => {
    const provided = c.req.header(NOTIFICATION_TOKEN_HEADER)
    if (!isValidToken(options.token, provided)) {
      logger.warn(
        { event: 'llm_agent_a2a_notification_unauthorized' },
        'llm-agent rejected an A2A push notification with an invalid token',
      )
      recordA2aPushNotification('unauthorized')
      return c.text('unauthorized', 401)
    }

    let rawBody: unknown
    try {
      rawBody = await c.req.json()
    } catch {
      recordA2aPushNotification('invalid_payload')
      return c.text('invalid request body', 400)
    }
    const parsed = PUSH_PAYLOAD_SCHEMA.safeParse(rawBody)
    if (!parsed.success) {
      recordA2aPushNotification('invalid_payload')
      return c.text('invalid task payload', 400)
    }

    try {
      await options.responseFinalizer.finalize(parsed.data.id)
    } catch (error) {
      // The sender (DefaultPushNotificationSender) never retries regardless
      // of the response status, so there is nothing to gain from surfacing
      // this as a 5xx; log it and let the next push or the reconciler pick
      // the task back up.
      recordA2aPushNotification('error')
      logger.error(
        {
          event: 'llm_agent_a2a_notification_finalize_failed',
          task_id: parsed.data.id,
          err: error,
        },
        'llm-agent failed to finalize a task after receiving a push notification',
      )
    }

    return c.body(null, 204)
  }
}

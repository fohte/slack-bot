import { type Context, Hono } from 'hono'

import type { Logger } from '@/logger/logger'
import type { InteractionRouter, RouterResult } from '@/router/router'
import type { SignatureVerifier } from '@/security/signature-verifier'
import { createHealthEndpoint, type HealthEndpoint } from '@/server/health'
import type {
  BlockActionsPayload,
  MessageActionPayload,
  ShortcutPayload,
  SlackEventPayload,
  SlackInteractivityPayload,
  SlashCommandBody,
  ViewClosedPayload,
  ViewPayloadView,
  ViewSubmissionPayload,
} from '@/types/slack-payloads'

type Variables = {
  rawBody: string
}

export interface HttpServerOptions {
  readonly verifier: SignatureVerifier
  readonly router: InteractionRouter
  readonly logger: Logger
  readonly health?: HealthEndpoint | undefined
}

export interface HttpServer {
  readonly app: Hono<{ Variables: Variables }>
  readonly health: HealthEndpoint
}

const SLACK_PATHS = new Set([
  '/api/slack/commands',
  '/api/slack/interactivity',
  '/api/slack/events',
])

export const createHttpServer = (options: HttpServerOptions): HttpServer => {
  const app = new Hono<{ Variables: Variables }>()
  const health = options.health ?? createHealthEndpoint()

  app.use(async (c, next) => {
    if (!SLACK_PATHS.has(c.req.path) || c.req.method !== 'POST') {
      await next()
      return
    }
    const rawBody = await c.req.text()
    const signature = c.req.header('x-slack-signature') ?? ''
    const timestamp = c.req.header('x-slack-request-timestamp') ?? ''
    if (!options.verifier.verify(rawBody, signature, timestamp)) {
      options.logger.error(
        {
          event: 'signature_verification_failed',
          path: c.req.path,
        },
        'rejected request with invalid Slack signature',
      )
      return c.text('invalid request signature', 401)
    }
    c.set('rawBody', rawBody)
    await next()
    return
  })

  app.get('/health/live', (c) => c.json({ status: 'ok' }))
  app.get('/health/ready', (c) => {
    if (health.isReady()) return c.json({ status: 'ok' })
    return c.json({ status: 'initializing' }, 503)
  })

  app.post('/api/slack/commands', async (c) => {
    const rawBody = c.get('rawBody')
    let parsed: Record<string, string>
    try {
      parsed = parseFormUrlEncoded(rawBody)
    } catch {
      return c.text('invalid request body', 400)
    }
    const command = parsed['command']
    if (command === undefined || command.length === 0) {
      return c.text('missing command field', 400)
    }
    const body: SlashCommandBody = { ...parsed, command }
    return respond(c, await options.router.routeCommand(body))
  })

  app.post('/api/slack/interactivity', async (c) => {
    const rawBody = c.get('rawBody')
    let parsed: Record<string, string>
    try {
      parsed = parseFormUrlEncoded(rawBody)
    } catch {
      return c.text('invalid request body', 400)
    }
    const payloadString = parsed['payload']
    if (payloadString === undefined) {
      return c.text('missing payload field', 400)
    }
    let raw: unknown
    try {
      raw = JSON.parse(payloadString)
    } catch {
      return c.text('invalid payload JSON', 400)
    }
    const payload = toInteractivityPayload(raw)
    if (payload === undefined) {
      return c.text('invalid payload type', 400)
    }
    return respond(c, await options.router.routeInteractivity(payload))
  })

  app.post('/api/slack/events', async (c) => {
    const rawBody = c.get('rawBody')
    let raw: unknown
    try {
      raw = JSON.parse(rawBody)
    } catch {
      return c.text('invalid request body', 400)
    }
    if (!isRecord(raw)) {
      return c.text('invalid event payload', 400)
    }
    if (
      raw['type'] === 'url_verification' &&
      typeof raw['challenge'] === 'string'
    ) {
      return c.json({ challenge: raw['challenge'] })
    }
    const payload: SlackEventPayload = {
      type: typeof raw['type'] === 'string' ? raw['type'] : 'unknown',
      ...raw,
    }
    return respond(c, await options.router.routeEvent(payload))
  })

  return { app, health }
}

const respond = (
  c: Context<{ Variables: Variables }>,
  result: RouterResult,
): Response => {
  if (result.status === 200) {
    if (result.body === undefined) {
      return c.body(null, 200)
    }
    return c.json(result.body)
  }
  if (result.status === 400) {
    if (result.body === undefined) {
      return c.body('bad request', 400)
    }
    return c.json(result.body, 400)
  }
  return c.body(null, 404)
}

const parseFormUrlEncoded = (raw: string): Record<string, string> => {
  const params = new URLSearchParams(raw)
  const out: Record<string, string> = {}
  for (const [key, value] of params.entries()) {
    out[key] = value
  }
  return out
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toInteractivityPayload = (
  value: unknown,
): SlackInteractivityPayload | undefined => {
  if (!isRecord(value)) return undefined
  const type = value['type']
  switch (type) {
    case 'block_actions':
      return toBlockActions(value)
    case 'view_submission':
      return toViewSubmission(value)
    case 'view_closed':
      return toViewClosed(value)
    case 'shortcut':
      return toShortcut(value)
    case 'message_action':
      return toMessageAction(value)
    default:
      return undefined
  }
}

const toBlockActions = (
  value: Record<string, unknown>,
): BlockActionsPayload | undefined => {
  const actions = value['actions']
  if (!Array.isArray(actions)) return undefined
  const normalizedActions = actions.flatMap((a) => {
    if (!isRecord(a)) return []
    const actionId = a['action_id']
    if (typeof actionId !== 'string') return []
    return [{ ...a, action_id: actionId }]
  })
  return { ...value, type: 'block_actions', actions: normalizedActions }
}

const toView = (raw: unknown): ViewPayloadView | undefined => {
  if (!isRecord(raw)) return undefined
  const callbackId = raw['callback_id']
  if (typeof callbackId !== 'string') return undefined
  return { ...raw, callback_id: callbackId }
}

const toViewSubmission = (
  value: Record<string, unknown>,
): ViewSubmissionPayload | undefined => {
  const view = toView(value['view'])
  if (view === undefined) return undefined
  return { ...value, type: 'view_submission', view }
}

const toViewClosed = (
  value: Record<string, unknown>,
): ViewClosedPayload | undefined => {
  const view = toView(value['view'])
  if (view === undefined) return undefined
  return { ...value, type: 'view_closed', view }
}

const toShortcut = (
  value: Record<string, unknown>,
): ShortcutPayload | undefined => {
  const callbackId = value['callback_id']
  if (typeof callbackId !== 'string') return undefined
  return { ...value, type: 'shortcut', callback_id: callbackId }
}

const toMessageAction = (
  value: Record<string, unknown>,
): MessageActionPayload | undefined => {
  const callbackId = value['callback_id']
  if (typeof callbackId !== 'string') return undefined
  return { ...value, type: 'message_action', callback_id: callbackId }
}

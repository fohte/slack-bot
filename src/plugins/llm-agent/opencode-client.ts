import { captureGoUsageLimitError } from '@/observability/capture'
import { GoUsageLimitError, wrapOpencodeCall } from '@/observability/counters'

export const DEFAULT_OPENCODE_BASE_URL =
  'http://slack-bot.kubeopencode.svc.cluster.local:4096'

export const DEFAULT_OPENCODE_FETCH_ATTEMPTS = 3
export const DEFAULT_OPENCODE_RETRY_DELAY_MS = 1000

// findSessionIdByTitle has no session id at call time; the wrapper still needs
// a value, so all find_session spans share this placeholder attribute.
const FIND_SESSION_PLACEHOLDER_ID = 'unknown'

export interface OpencodeClient {
  fetchLatestAssistantText(sessionId: string): Promise<string | undefined>
  findSessionIdByTitle(title: string): Promise<string | undefined>
}

export interface OpencodeClientOptions {
  readonly baseUrl?: string | undefined
  readonly fetchImpl?: typeof fetch | undefined
  readonly maxAttempts?: number | undefined
  readonly retryDelayMs?: number | undefined
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined
}

interface FetchMessagesResult {
  readonly text: string | undefined
  readonly models: readonly string[]
  readonly assistantCount: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const extractRole = (info: unknown): string | undefined => {
  if (!isRecord(info)) return undefined
  const role = info['role']
  return typeof role === 'string' ? role : undefined
}

const extractModelId = (info: unknown): string | undefined => {
  if (!isRecord(info)) return undefined
  const modelId = info['modelID']
  return typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined
}

const extractText = (parts: unknown): string | undefined => {
  if (!Array.isArray(parts)) return undefined
  const buf: string[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (part['type'] !== 'text') continue
    const text = part['text']
    if (typeof text === 'string' && text.length > 0) buf.push(text)
  }
  if (buf.length === 0) return undefined
  return buf.join('')
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Retry-After per RFC 7231 §7.1.3: either an integer count of seconds or an
// HTTP-date. Anything we can't parse becomes undefined so callers fall back to
// their own backoff.
const parseRetryAfter = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.floor(asNumber)
  }
  const asDate = Date.parse(trimmed)
  if (!Number.isNaN(asDate)) {
    return Math.max(0, Math.floor((asDate - Date.now()) / 1000))
  }
  return undefined
}

const raiseGoUsageLimit = (response: Response, message: string): never => {
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
  const options = retryAfter === undefined ? {} : { retryAfter }
  const err = new GoUsageLimitError(message, options)
  captureGoUsageLimitError(err, options)
  throw err
}

const fetchOnce = async (
  fetchImpl: typeof fetch,
  url: string,
  sessionId: string,
): Promise<FetchMessagesResult> => {
  const response = await fetchImpl(url, { method: 'GET' })
  if (response.status === 429) {
    raiseGoUsageLimit(
      response,
      `opencode GET /session/${sessionId}/message hit Go usage limit`,
    )
  }
  if (!response.ok) {
    throw new Error(
      `opencode GET /session/${sessionId}/message failed with HTTP ${String(response.status)}`,
    )
  }
  const raw: unknown = await response.json()
  if (!Array.isArray(raw)) {
    throw new Error(
      `opencode GET /session/${sessionId}/message returned non-array payload`,
    )
  }
  const entries = raw as readonly unknown[]
  const models: string[] = []
  let assistantCount = 0
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    if (extractRole(entry['info']) !== 'assistant') continue
    assistantCount += 1
    const modelId = extractModelId(entry['info'])
    if (modelId !== undefined) models.push(modelId)
  }
  let latestText: string | undefined
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!isRecord(entry)) continue
    if (extractRole(entry['info']) !== 'assistant') continue
    const text = extractText(entry['parts'])
    if (text !== undefined) {
      latestText = text
      break
    }
  }
  return { text: latestText, models, assistantCount }
}

const findSessionIdOnce = async (
  fetchImpl: typeof fetch,
  url: string,
  title: string,
): Promise<string | undefined> => {
  const response = await fetchImpl(url, { method: 'GET' })
  if (response.status === 429) {
    raiseGoUsageLimit(response, `opencode GET /session hit Go usage limit`)
  }
  if (!response.ok) {
    throw new Error(
      `opencode GET /session failed with HTTP ${String(response.status)}`,
    )
  }
  const raw: unknown = await response.json()
  if (!Array.isArray(raw)) {
    throw new Error(`opencode GET /session returned non-array payload`)
  }
  for (const entry of raw as readonly unknown[]) {
    if (!isRecord(entry)) continue
    if (entry['title'] !== title) continue
    const id = entry['id']
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

const retryWith = async <T>(
  attempt: () => Promise<T>,
  maxAttempts: number,
  retryDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T> => {
  let lastError: unknown
  for (let i = 1; i <= maxAttempts; i += 1) {
    try {
      return await attempt()
    } catch (error) {
      // Surface usage-limit errors immediately: retrying a 429 just burns
      // more budget against the same upstream cap.
      if (error instanceof GoUsageLimitError) throw error
      lastError = error
      if (i < maxAttempts) await sleep(retryDelayMs)
    }
  }
  throw lastError
}

export const createOpencodeClient = (
  options: OpencodeClientOptions = {},
): OpencodeClient => {
  const baseUrl = (options.baseUrl ?? DEFAULT_OPENCODE_BASE_URL).replace(
    /\/$/,
    '',
  )
  const fetchImpl = options.fetchImpl ?? fetch
  const maxAttempts = options.maxAttempts ?? DEFAULT_OPENCODE_FETCH_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_OPENCODE_RETRY_DELAY_MS
  const sleep = options.sleepImpl ?? defaultSleep
  return {
    // Retry transient failures (network blips, 5xx) so a momentary opencode
    // outage doesn't produce a placeholder response that displaces the real
    // assistant message — this tick is the only chance, since markResponded
    // commits before the next tick can re-evaluate.
    async fetchLatestAssistantText(sessionId) {
      const url = `${baseUrl}/session/${encodeURIComponent(sessionId)}/message`
      const result = await wrapOpencodeCall(
        { sessionId, operation: 'fetch_messages' },
        () =>
          retryWith(
            () => fetchOnce(fetchImpl, url, sessionId),
            maxAttempts,
            retryDelayMs,
            sleep,
          ),
        (r) => ({ models: r.models, assistantCount: r.assistantCount }),
      )
      return result.text
    },
    async findSessionIdByTitle(title) {
      const url = `${baseUrl}/session`
      return wrapOpencodeCall(
        { sessionId: FIND_SESSION_PLACEHOLDER_ID, operation: 'find_session' },
        () =>
          retryWith(
            () => findSessionIdOnce(fetchImpl, url, title),
            maxAttempts,
            retryDelayMs,
            sleep,
          ),
        () => ({ models: [], assistantCount: 0 }),
      )
    },
  }
}

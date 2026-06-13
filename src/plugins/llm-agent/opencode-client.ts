export const DEFAULT_OPENCODE_BASE_URL =
  'http://slack-bot.kubeopencode.svc.cluster.local:4096'

export const DEFAULT_OPENCODE_FETCH_ATTEMPTS = 3
export const DEFAULT_OPENCODE_RETRY_DELAY_MS = 1000

export interface OpencodeClient {
  fetchLatestAssistantText(sessionId: string): Promise<string | undefined>
}

export interface OpencodeClientOptions {
  readonly baseUrl?: string | undefined
  readonly fetchImpl?: typeof fetch | undefined
  readonly maxAttempts?: number | undefined
  readonly retryDelayMs?: number | undefined
  readonly sleepImpl?: ((ms: number) => Promise<void>) | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const extractRole = (info: unknown): string | undefined => {
  if (!isRecord(info)) return undefined
  const role = info['role']
  return typeof role === 'string' ? role : undefined
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

const fetchOnce = async (
  fetchImpl: typeof fetch,
  url: string,
  sessionId: string,
): Promise<string | undefined> => {
  const response = await fetchImpl(url, { method: 'GET' })
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
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]
    if (!isRecord(entry)) continue
    if (extractRole(entry['info']) !== 'assistant') continue
    const text = extractText(entry['parts'])
    if (text !== undefined) return text
  }
  return undefined
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
      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          return await fetchOnce(fetchImpl, url, sessionId)
        } catch (error) {
          lastError = error
          if (attempt < maxAttempts) {
            await sleep(retryDelayMs)
          }
        }
      }
      throw lastError
    },
  }
}

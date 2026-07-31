import { fromThrowable } from 'neverthrow'

import type { Logger } from '#logger/logger'
import { noopLogger } from '#logger/logger'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseJson = fromThrowable(
  (text: string) => JSON.parse(text) as unknown,
  (error) => error,
)

const hasMessagesArray = (
  body: unknown,
): body is Record<string, unknown> & { messages: unknown[] } =>
  isRecord(body) && Array.isArray(body['messages'])

const withSystemRoleRestored = (body: unknown): unknown => {
  if (!hasMessagesArray(body)) return body
  return {
    ...body,
    messages: body.messages.map((message) =>
      isRecord(message) && message['role'] === 'developer'
        ? { ...message, role: 'system' }
        : message,
    ),
  }
}

export interface CreateRestoreSystemRoleFetchOptions {
  readonly fetchImpl?: typeof fetch | undefined
  readonly logger?: Logger | undefined
}

// @langchain/openai's isReasoningModel() (converters/completions.cjs,
// utils/misc.cjs) treats any model name starting with "gpt-5" as an OpenAI
// reasoning model and rewrites every system message's role to "developer"
// before sending the chat completions request — including OpenCode Go's
// non-OpenAI "gpt-5.6-luna". The Zen gateway's underlying model ignores
// developer-role content, silently dropping the persona system prompt.
// Passed as ChatOpenAI's `configuration.fetch` (see
// createOpenCodeGoChatModel), this undoes that rewrite on the outgoing
// request body right before the real fetch call, scoped to that one model's
// requests rather than patching fetch globally. Tracked upstream at
// langchain-ai/langchainjs#10887, unresolved as of langchain@1.5.3 /
// @langchain/openai@1.5.5 (no opt-out setting exists).
export const createRestoreSystemRoleFetch = (
  options: CreateRestoreSystemRoleFetchOptions = {},
): typeof fetch => {
  const fetchImpl = options.fetchImpl ?? fetch
  const logger = options.logger ?? noopLogger
  return (input, init) => {
    if (typeof init?.body !== 'string') return fetchImpl(input, init)
    const parsed = parseJson(init.body)
    if (parsed.isOk() && !hasMessagesArray(parsed.value)) {
      // createOpenCodeGoChatModel only wires this fetch into a chat
      // completions client, so every real request body should carry a
      // messages array; anything else means the request shape this
      // workaround assumes has drifted, and it silently skips restoring the
      // system role below — see the think-block-leaked warn in
      // conversation-agent.ts for the same "assumed contract broke" pattern.
      logger.warn(
        { event: 'restore_system_role_fetch_unexpected_body_shape' },
        'chat completions request body has no messages array; system role restoration skipped',
      )
    }
    const body = parsed
      .map(withSystemRoleRestored)
      .map((value) => JSON.stringify(value))
      .unwrapOr(init.body)
    return fetchImpl(input, { ...init, body })
  }
}

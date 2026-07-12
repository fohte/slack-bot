import type { AgentCard } from '@a2a-js/sdk'
import type { Client } from '@a2a-js/sdk/client'
import { ClientFactory } from '@a2a-js/sdk/client'

import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'

export interface RemoteAgentHandle {
  // Agent Card's own `name`; also recorded as a2a_task.agent_name and used
  // as the contextId-reuse key, so it is the sole identity this module uses
  // for a remote agent (no separate slack-bot-side ID).
  readonly name: string
  readonly card: AgentCard
  readonly client: Client
}

export interface RemoteAgentRegistry {
  listAgents(): Promise<readonly RemoteAgentHandle[]>
}

// Resolves one remote agent's Agent Card and A2A client from its base URL.
// Swapped out in tests to avoid real HTTP.
export interface RemoteAgentResolver {
  resolve(url: string): Promise<RemoteAgentHandle>
}

const defaultResolver: RemoteAgentResolver = {
  async resolve(url) {
    const client = await new ClientFactory().createFromUrl(url)
    const card = await client.getAgentCard()
    return { name: card.name, card, client }
  },
}

export const DEFAULT_AGENT_CARD_CACHE_TTL_MS = 5 * 60 * 1000

export interface RemoteAgentRegistryOptions {
  // REMOTE_AGENT_URLS, already split. Adding an entry here is the entire
  // mechanism for adding a delegation target — no code change needed.
  readonly agentUrls: readonly string[]
  readonly cacheTtlMs?: number | undefined
  readonly resolver?: RemoteAgentResolver | undefined
  readonly now?: (() => number) | undefined
  readonly logger?: Logger | undefined
}

export const createRemoteAgentRegistry = (
  options: RemoteAgentRegistryOptions,
): RemoteAgentRegistry => {
  const resolver = options.resolver ?? defaultResolver
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_AGENT_CARD_CACHE_TTL_MS
  const now = options.now ?? (() => Date.now())
  const logger = options.logger ?? noopLogger

  let cache:
    { handles: readonly RemoteAgentHandle[]; fetchedAt: number } | undefined
  // Dedupes concurrent listAgents() calls made while a fetch is already in
  // flight (e.g. several conversation turns arriving right after startup)
  // onto a single round of Agent Card requests.
  let inFlight: Promise<readonly RemoteAgentHandle[]> | undefined

  const fetchAll = async (): Promise<readonly RemoteAgentHandle[]> => {
    const resolved = await Promise.all(
      options.agentUrls.map(async (url) => {
        try {
          return await resolver.resolve(url)
        } catch (error) {
          logger.warn(
            {
              event: 'llm_agent_remote_agent_card_fetch_failed',
              remote_agent_url: url,
              err: error,
            },
            'llm-agent remote agent registry failed to fetch an Agent Card; excluding it from delegation tools',
          )
          return undefined
        }
      }),
    )
    return resolved.filter(
      (handle): handle is RemoteAgentHandle => handle !== undefined,
    )
  }

  return {
    async listAgents() {
      const cached = cache
      if (cached !== undefined && now() - cached.fetchedAt < cacheTtlMs) {
        return cached.handles
      }
      if (inFlight === undefined) {
        const fetchedAt = now()
        inFlight = fetchAll()
          .then((handles) => {
            cache = { handles, fetchedAt }
            return handles
          })
          .finally(() => {
            inFlight = undefined
          })
      }
      return inFlight
    },
  }
}

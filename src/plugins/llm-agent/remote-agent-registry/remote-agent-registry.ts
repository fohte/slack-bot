import type { AgentCard } from '@a2a-js/sdk'
import type { Client } from '@a2a-js/sdk/client'
import { ClientFactory } from '@a2a-js/sdk/client'
import { z } from 'zod'

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

// Agent Cards come from remote HTTP servers, so only the fields this module
// actually reads (name/description/skills, consumed by
// delegationToolName/delegationToolDescription) are validated; a card
// failing this parse is treated the same as an unreachable one — excluded
// with a warning rather than propagating a raw TypeError.
export const AGENT_CARD_SCHEMA = z
  .object({
    name: z.string(),
    description: z.string(),
    skills: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
      }),
    ),
  })
  .loose()

const defaultResolver: RemoteAgentResolver = {
  async resolve(url) {
    const client = await new ClientFactory().createFromUrl(url)
    const rawCard: unknown = await client.getAgentCard()
    // AGENT_CARD_SCHEMA (a .loose() object) validates the name/description/
    // skills fields this module reads and passes the rest of the payload
    // through unchanged; the remaining AgentCard fields (url, version,
    // capabilities, ...) are never read here, so this cast only relies on
    // the fields the schema actually checked.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- AGENT_CARD_SCHEMA already validated every field this module reads
    const card = AGENT_CARD_SCHEMA.parse(rawCard) as unknown as AgentCard
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

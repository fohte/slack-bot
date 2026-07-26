import type { DynamicStructuredTool } from '@langchain/core/tools'
import { MultiServerMCPClient } from '@langchain/mcp-adapters'
import { err, ok, ResultAsync } from 'neverthrow'

import type { Logger } from '#logger/logger'
import { noopLogger } from '#logger/logger'
import { DuplicateMcpToolNameError } from '#types/errors'

// The MultiServerMCPClient config below is created fresh per server, so
// this key only needs to be unique within that single-entry map.
const MCP_SERVER_CONFIG_KEY = 'server'

// Resolves one MCP server's tools from its base URL. Swapped out in tests
// to avoid a real MCP connection.
export interface McpServerResolver {
  resolve(url: string): Promise<readonly DynamicStructuredTool[]>
}

// Connections are never closed: the returned tools capture this client in
// their call closures and are reused for the conversation agent's whole
// process lifetime, the same way RemoteAgentHandle keeps its A2A client
// open (see remote-agent-registry.ts).
const defaultResolver: McpServerResolver = {
  async resolve(url) {
    const client = new MultiServerMCPClient({
      mcpServers: { [MCP_SERVER_CONFIG_KEY]: { url, transport: 'http' } },
    })
    return await client.getTools()
  },
}

export interface CreateMcpToolsOptions {
  // MCP_SERVER_URLS, already split. Adding an entry here is the entire
  // mechanism for adding an MCP server's tools to the conversation agent.
  readonly serverUrls: readonly string[]
  readonly resolver?: McpServerResolver | undefined
  readonly logger?: Logger | undefined
}

// Connects to every configured MCP server and returns the flattened list of
// tools it serves, unchanged (name/description come from the server, never
// rewritten here, so this module stays domain-agnostic). A server that
// fails to connect or list its tools is excluded with a warning instead of
// failing startup, mirroring RemoteAgentRegistry's Agent Card fetch
// behavior. Tool-call failures are not handled here: a thrown error from an
// individual tool call is left to propagate to the agent's tool-calling
// node, which reports it back to the model as a tool error.
export const createMcpTools = (
  options: CreateMcpToolsOptions,
): ResultAsync<readonly DynamicStructuredTool[], DuplicateMcpToolNameError> => {
  const resolver = options.resolver ?? defaultResolver
  const logger = options.logger ?? noopLogger

  return ResultAsync.fromSafePromise(
    Promise.all(
      options.serverUrls.map(async (url) => {
        const fetched = await ResultAsync.fromPromise(
          resolver.resolve(url),
          (error) => error,
        )
        if (fetched.isErr()) {
          logger.warn(
            {
              event: 'llm_agent_mcp_server_tools_fetch_failed',
              mcp_server_url: url,
              err: fetched.error,
            },
            'llm-agent MCP tools factory failed to fetch tools from an MCP server; excluding it from the conversation agent',
          )
          return undefined
        }
        return fetched.value
      }),
    ),
  ).andThen((resolved) => {
    const tools = resolved
      .filter(
        (tools): tools is readonly DynamicStructuredTool[] =>
          tools !== undefined,
      )
      .flat()

    // A collision would leave one of the two tools permanently unreachable
    // (dispatch resolves by name, first match wins) with no error surfaced
    // anywhere, so this fails loudly instead (see createDelegationTools for
    // the same guard on the A2A delegation tool side).
    const seenNames = new Set<string>()
    for (const tool of tools) {
      if (seenNames.has(tool.name)) {
        return err(new DuplicateMcpToolNameError(tool.name))
      }
      seenNames.add(tool.name)
    }
    return ok(tools)
  })
}

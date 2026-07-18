import type { DynamicStructuredTool } from '@langchain/core/tools'
import { tool } from 'langchain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createRecordingLogger } from '@/plugins/llm-agent/_test-utils'
import type { McpServerResolver } from '@/plugins/llm-agent/mcp-tools/mcp-tools'
import { createMcpTools } from '@/plugins/llm-agent/mcp-tools/mcp-tools'

const fakeTool = (name: string): DynamicStructuredTool =>
  tool(async () => `${name} result`, {
    name,
    description: `${name} tool`,
    schema: z.object({}),
  })

const resolverFor = (
  byUrl: ReadonlyMap<string, readonly DynamicStructuredTool[] | Error>,
): McpServerResolver => ({
  async resolve(url) {
    const result = byUrl.get(url)
    if (result === undefined) throw new Error(`unexpected url: ${url}`)
    if (result instanceof Error) throw result
    return result
  },
})

describe('createMcpTools', () => {
  it('returns no tools when no MCP servers are configured', async () => {
    expect(await createMcpTools({ serverUrls: [] })).toEqual([])
  })

  it('fetches the tools served by a single configured MCP server', async () => {
    const mgmtTool = fakeTool('list_strategies')

    const tools = await createMcpTools({
      serverUrls: ['https://mgmt-mcp.example.com/mcp'],
      resolver: resolverFor(
        new Map([['https://mgmt-mcp.example.com/mcp', [mgmtTool]]]),
      ),
    })

    expect(tools).toEqual([mgmtTool])
  })

  it('adding a URL to serverUrls adds its tools with no other change', async () => {
    const mgmtTool = fakeTool('list_strategies')
    const newTool = fakeTool('new_tool')

    const tools = await createMcpTools({
      serverUrls: [
        'https://mgmt-mcp.example.com/mcp',
        'https://new-mcp.example.com/mcp',
      ],
      resolver: resolverFor(
        new Map([
          ['https://mgmt-mcp.example.com/mcp', [mgmtTool]],
          ['https://new-mcp.example.com/mcp', [newTool]],
        ]),
      ),
    })

    expect(tools).toEqual([mgmtTool, newTool])
  })

  it('excludes a server whose tool fetch fails, keeping tools from the rest', async () => {
    const mgmtTool = fakeTool('list_strategies')
    const fetchError = new Error('connection refused')

    const tools = await createMcpTools({
      serverUrls: [
        'https://mgmt-mcp.example.com/mcp',
        'https://broken-mcp.example.com/mcp',
      ],
      resolver: resolverFor(
        new Map<string, readonly DynamicStructuredTool[] | Error>([
          ['https://mgmt-mcp.example.com/mcp', [mgmtTool]],
          ['https://broken-mcp.example.com/mcp', fetchError],
        ]),
      ),
    })

    expect(tools).toEqual([mgmtTool])
  })

  it('warns when a server fails to fetch tools', async () => {
    const fetchError = new Error('connection refused')
    const logger = createRecordingLogger()

    await createMcpTools({
      serverUrls: ['https://broken-mcp.example.com/mcp'],
      resolver: resolverFor(
        new Map([['https://broken-mcp.example.com/mcp', fetchError]]),
      ),
      logger,
    })

    expect(logger.entries).toEqual([
      {
        level: 'warn',
        payload: {
          event: 'llm_agent_mcp_server_tools_fetch_failed',
          mcp_server_url: 'https://broken-mcp.example.com/mcp',
          err: fetchError,
        },
        message:
          'llm-agent MCP tools factory failed to fetch tools from an MCP server; excluding it from the conversation agent',
      },
    ])
  })

  it('rejects a duplicate tool name across configured MCP servers instead of leaving one unreachable', async () => {
    await expect(
      createMcpTools({
        serverUrls: [
          'https://mgmt-mcp.example.com/mcp',
          'https://other-mcp.example.com/mcp',
        ],
        resolver: resolverFor(
          new Map([
            ['https://mgmt-mcp.example.com/mcp', [fakeTool('search')]],
            ['https://other-mcp.example.com/mcp', [fakeTool('search')]],
          ]),
        ),
      }),
    ).rejects.toThrow(/duplicate MCP tool name/)
  })
})

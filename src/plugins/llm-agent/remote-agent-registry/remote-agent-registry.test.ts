import type { Client } from '@a2a-js/sdk/client'
import { describe, expect, it, vi } from 'vitest'

import type {
  RemoteAgentHandle,
  RemoteAgentResolver,
} from '@/plugins/llm-agent/remote-agent-registry/remote-agent-registry'
import { createRemoteAgentRegistry } from '@/plugins/llm-agent/remote-agent-registry/remote-agent-registry'

// remote-agent-registry.test.ts never calls a handle's client, so a bare
// stand-in satisfies the Client type without wiring an A2A transport.
const fakeClient = {} as Client

const handleFor = (name: string): RemoteAgentHandle => ({
  name,
  card: {
    protocolVersion: '0.3.0',
    name,
    description: `${name} agent`,
    url: `https://${name}.example.com`,
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  },
  client: fakeClient,
})

const resolverFor = (
  byUrl: ReadonlyMap<string, RemoteAgentHandle | Error>,
): RemoteAgentResolver => ({
  async resolve(url) {
    const result = byUrl.get(url)
    if (result === undefined) throw new Error(`unexpected url: ${url}`)
    if (result instanceof Error) throw result
    return result
  },
})

describe('createRemoteAgentRegistry', () => {
  it('resolves one handle per configured URL', async () => {
    const meshi = handleFor('meshi')
    const registry = createRemoteAgentRegistry({
      agentUrls: ['https://meshi.example.com'],
      resolver: resolverFor(new Map([['https://meshi.example.com', meshi]])),
    })

    expect(await registry.listAgents()).toEqual([meshi])
  })

  it('adding a URL to agentUrls adds a delegation target with no other change', async () => {
    const meshi = handleFor('meshi')
    const tRader = handleFor('t-rader')
    const registry = createRemoteAgentRegistry({
      agentUrls: ['https://meshi.example.com', 'https://t-rader.example.com'],
      resolver: resolverFor(
        new Map([
          ['https://meshi.example.com', meshi],
          ['https://t-rader.example.com', tRader],
        ]),
      ),
    })

    expect(await registry.listAgents()).toEqual([meshi, tRader])
  })

  it('excludes an agent whose Agent Card fetch fails, keeping the rest', async () => {
    const meshi = handleFor('meshi')
    const registry = createRemoteAgentRegistry({
      agentUrls: ['https://meshi.example.com', 'https://broken.example.com'],
      resolver: resolverFor(
        new Map<string, RemoteAgentHandle | Error>([
          ['https://meshi.example.com', meshi],
          ['https://broken.example.com', new Error('connection refused')],
        ]),
      ),
    })

    expect(await registry.listAgents()).toEqual([meshi])
  })

  it('warns when an Agent Card fetch fails', async () => {
    const warn = vi.fn()
    const registry = createRemoteAgentRegistry({
      agentUrls: ['https://broken.example.com'],
      resolver: resolverFor(
        new Map([
          ['https://broken.example.com', new Error('connection refused')],
        ]),
      ),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: vi.fn(),
      },
    })

    await registry.listAgents()

    expect(warn).toHaveBeenCalledOnce()
  })

  it('serves cached handles within the TTL without re-resolving', async () => {
    let resolveCount = 0
    const meshi = handleFor('meshi')
    let clock = 0
    const registry = createRemoteAgentRegistry({
      agentUrls: ['https://meshi.example.com'],
      cacheTtlMs: 1000,
      now: () => clock,
      resolver: {
        async resolve() {
          resolveCount++
          return meshi
        },
      },
    })

    await registry.listAgents()
    clock = 999
    await registry.listAgents()

    expect(resolveCount).toBe(1)
  })

  it('re-resolves once the TTL has elapsed', async () => {
    let resolveCount = 0
    const meshi = handleFor('meshi')
    let clock = 0
    const registry = createRemoteAgentRegistry({
      agentUrls: ['https://meshi.example.com'],
      cacheTtlMs: 1000,
      now: () => clock,
      resolver: {
        async resolve() {
          resolveCount++
          return meshi
        },
      },
    })

    await registry.listAgents()
    clock = 1000
    await registry.listAgents()

    expect(resolveCount).toBe(2)
  })
})

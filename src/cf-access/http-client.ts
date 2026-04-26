import type { Config } from '@/config/config'
import { CfAccessAuthError } from '@/types/errors'

export interface CloudflareAccessHttpClient {
  request(input: string | URL, init?: RequestInit): Promise<Response>
}

export interface CloudflareAccessHttpClientFactory {
  forPlugin(pluginName: string): CloudflareAccessHttpClient
}

export interface FactoryOptions {
  readonly config: Config
  readonly fetchImpl?: typeof fetch | undefined
}

export const createCloudflareAccessHttpClientFactory = (
  options: FactoryOptions,
): CloudflareAccessHttpClientFactory => {
  const fetchImpl = options.fetchImpl ?? fetch
  return {
    forPlugin(pluginName) {
      return {
        async request(input, init) {
          const tokens = options.config.serviceTokenFor(pluginName)
          if (tokens === undefined) {
            throw new CfAccessAuthError(pluginName)
          }
          const headers = new Headers(init?.headers)
          headers.set('CF-Access-Client-Id', tokens.clientId)
          headers.set('CF-Access-Client-Secret', tokens.clientSecret)
          return fetchImpl(input, { ...init, headers })
        },
      }
    },
  }
}

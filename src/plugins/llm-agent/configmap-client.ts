import { ApiException, CoreV1Api, KubeConfig } from '@kubernetes/client-node'

export interface ConfigMapBinaryEntry {
  readonly filename: string
  readonly bytes: Uint8Array
}

export interface ConfigMapSpec {
  readonly name: string
  readonly namespace: string
  readonly binaryEntries: readonly ConfigMapBinaryEntry[]
  readonly labels?: Readonly<Record<string, string>> | undefined
}

export type ConfigMapCreateOutcome = 'created' | 'already_exists'

export interface ConfigMapClient {
  create(spec: ConfigMapSpec): Promise<ConfigMapCreateOutcome>
}

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64')

export interface ConfigMapManifest {
  readonly apiVersion: 'v1'
  readonly kind: 'ConfigMap'
  readonly metadata: {
    readonly name: string
    readonly namespace: string
    readonly labels?: Readonly<Record<string, string>>
  }
  readonly binaryData: Readonly<Record<string, string>>
}

export const buildConfigMapManifest = (
  spec: ConfigMapSpec,
): ConfigMapManifest => {
  const binaryData: Record<string, string> = {}
  for (const entry of spec.binaryEntries) {
    binaryData[entry.filename] = toBase64(entry.bytes)
  }
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      ...(spec.labels !== undefined ? { labels: { ...spec.labels } } : {}),
    },
    binaryData,
  }
}

export const createKubernetesConfigMapClient = (
  options: { readonly kubeConfig?: KubeConfig } = {},
): ConfigMapClient => {
  const kc = options.kubeConfig ?? new KubeConfig()
  if (options.kubeConfig === undefined) {
    kc.loadFromDefault()
  }
  const api = kc.makeApiClient(CoreV1Api)
  return {
    async create(spec) {
      try {
        await api.createNamespacedConfigMap({
          namespace: spec.namespace,
          body: buildConfigMapManifest(spec),
        })
        return 'created'
      } catch (error) {
        if (error instanceof ApiException && error.code === 409) {
          return 'already_exists'
        }
        throw error
      }
    },
  }
}

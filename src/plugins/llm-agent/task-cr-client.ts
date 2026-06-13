import { createHash } from 'node:crypto'

import {
  ApiException,
  CustomObjectsApi,
  KubeConfig,
} from '@kubernetes/client-node'

export const TASK_CR_GROUP = 'kubeopencode.io'
export const TASK_CR_VERSION = 'v1alpha1'
export const TASK_CR_PLURAL = 'tasks'

export interface TaskCrContext {
  readonly name: string
  readonly mountPath: string
  readonly text: string
}

export interface TaskCrSpec {
  readonly name: string
  readonly namespace: string
  readonly agentName: string
  readonly description: string
  readonly contexts: readonly TaskCrContext[]
}

export type TaskCrCreateOutcome = 'created' | 'already_exists'

export type TaskCrPhase = string

export interface TaskCrStatus {
  readonly name: string
  readonly namespace: string
  readonly phase: TaskCrPhase | undefined
  readonly message: string | undefined
  readonly sessionId: string | undefined
}

export interface TaskCrClient {
  create(task: TaskCrSpec): Promise<TaskCrCreateOutcome>
  list(namespace: string): Promise<readonly TaskCrStatus[]>
}

export const buildTaskCrManifest = (task: TaskCrSpec): unknown => ({
  apiVersion: `${TASK_CR_GROUP}/${TASK_CR_VERSION}`,
  kind: 'Task',
  metadata: {
    name: task.name,
    namespace: task.namespace,
  },
  spec: {
    agentRef: { name: task.agentName },
    description: task.description,
    contexts: task.contexts.map((c) => ({
      name: c.name,
      type: 'Text',
      mountPath: c.mountPath,
      text: c.text,
    })),
  },
})

// Slack event_id (e.g. "Ev08AB12CDE") can exceed RFC 1123 label limits when
// combined with a prefix. Hash to a stable short suffix so the same event_id
// always maps to the same Task CR name (idempotency under retries).
export const taskCrNameForSlackEvent = (slackEventId: string): string => {
  const digest = createHash('sha256').update(slackEventId).digest('hex')
  return `slack-${digest.slice(0, 16)}`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

export const parseTaskCrItem = (
  item: unknown,
  fallbackNamespace: string,
): TaskCrStatus | undefined => {
  if (!isRecord(item)) return undefined
  const metadata = isRecord(item['metadata']) ? item['metadata'] : undefined
  const name = asOptionalString(metadata?.['name'])
  if (name === undefined) return undefined
  const namespace =
    asOptionalString(metadata?.['namespace']) ?? fallbackNamespace
  const status = isRecord(item['status']) ? item['status'] : undefined
  const phase = asOptionalString(status?.['phase'])
  const message = asOptionalString(status?.['message'])
  const session = isRecord(status?.['session']) ? status['session'] : undefined
  const sessionId = asOptionalString(session?.['id'])
  return { name, namespace, phase, message, sessionId }
}

export const createKubernetesTaskCrClient = (
  options: { readonly kubeConfig?: KubeConfig } = {},
): TaskCrClient => {
  const kc = options.kubeConfig ?? new KubeConfig()
  if (options.kubeConfig === undefined) {
    kc.loadFromDefault()
  }
  const api = kc.makeApiClient(CustomObjectsApi)
  return {
    async create(task) {
      try {
        await api.createNamespacedCustomObject({
          group: TASK_CR_GROUP,
          version: TASK_CR_VERSION,
          namespace: task.namespace,
          plural: TASK_CR_PLURAL,
          body: buildTaskCrManifest(task),
        })
        return 'created'
      } catch (error) {
        if (error instanceof ApiException && error.code === 409) {
          return 'already_exists'
        }
        throw error
      }
    },
    async list(namespace) {
      const response = (await api.listNamespacedCustomObject({
        group: TASK_CR_GROUP,
        version: TASK_CR_VERSION,
        namespace,
        plural: TASK_CR_PLURAL,
      })) as unknown
      const items =
        isRecord(response) && Array.isArray(response['items'])
          ? response['items']
          : []
      const out: TaskCrStatus[] = []
      for (const item of items) {
        const parsed = parseTaskCrItem(item, namespace)
        if (parsed !== undefined) out.push(parsed)
      }
      return out
    },
  }
}

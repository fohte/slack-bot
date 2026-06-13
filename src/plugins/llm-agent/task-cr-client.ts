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

export interface TaskCrClient {
  create(task: TaskCrSpec): Promise<TaskCrCreateOutcome>
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

export const createKubernetesTaskCrClient = (
  options: { readonly kubeConfig?: KubeConfig } = {},
): TaskCrClient => {
  const kc = options.kubeConfig ?? new KubeConfig()
  if (options.kubeConfig === undefined) {
    kc.loadFromCluster()
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
  }
}

export type {
  Delegation,
  DelegationPushNotificationConfig,
  DelegationToolDependencies,
} from '@/plugins/llm-agent/remote-agent-registry/delegation-tool-factory'
export {
  createDelegationTool,
  createDelegationTools,
  DEFAULT_A2A_TASK_DEADLINE_MS,
  DELEGATION_RUNTIME_CONTEXT_SCHEMA,
  delegationToolDescription,
  delegationToolName,
  extractDelegations,
} from '@/plugins/llm-agent/remote-agent-registry/delegation-tool-factory'
export type {
  RemoteAgentHandle,
  RemoteAgentRegistry,
  RemoteAgentRegistryOptions,
  RemoteAgentResolver,
} from '@/plugins/llm-agent/remote-agent-registry/remote-agent-registry'
export {
  createRemoteAgentRegistry,
  DEFAULT_AGENT_CARD_CACHE_TTL_MS,
} from '@/plugins/llm-agent/remote-agent-registry/remote-agent-registry'
export type { SendMessageResult } from '@/plugins/llm-agent/remote-agent-registry/send-message-result'
export { SEND_MESSAGE_RESULT_SCHEMA } from '@/plugins/llm-agent/remote-agent-registry/send-message-result'

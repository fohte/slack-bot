export type {
  Delegation,
  DelegationPushNotificationConfig,
} from '#plugins/llm-agent/remote-agent-registry/delegation-tool-factory'
export {
  createDelegationTools,
  DEFAULT_A2A_TASK_DEADLINE_MS,
  DELEGATION_RUNTIME_CONTEXT_SCHEMA,
  extractDelegations,
} from '#plugins/llm-agent/remote-agent-registry/delegation-tool-factory'
export type {
  RemoteAgentHandle,
  RemoteAgentRegistry,
} from '#plugins/llm-agent/remote-agent-registry/remote-agent-registry'
export { createRemoteAgentRegistry } from '#plugins/llm-agent/remote-agent-registry/remote-agent-registry'
export { SEND_MESSAGE_RESULT_SCHEMA } from '#plugins/llm-agent/remote-agent-registry/send-message-result'

# llm-agent ↔ kubeopencode contract

The `llm-agent` plugin runs Slack mentions on the [kubeopencode](https://github.com/fohte/infra) operator: it creates a `Task` CR in the cluster, the operator spawns an opencode runner Pod, and the plugin fetches the assistant reply via opencode's HTTP API. This document captures everything the plugin requires from the surrounding kubeopencode deployment so the infra side has a single reference and breaking changes can be detected without grepping the code.

All line references are to files in this repository.

## Topology

```
Slack event
  └─► dispatcher (src/plugins/llm-agent/dispatcher.ts)
        └─► submitTask (src/plugins/llm-agent/steps/submit-task.ts)
              ├─► (optional) ConfigMap with Slack images
              └─► Task CR  ──watch──►  kubeopencode operator
                                              └─► opencode runner Pod
                                                     └─► opencode HTTP API
        └─► waitForCompletion (poll Task CR status.phase)
        └─► respond (src/plugins/llm-agent/steps/respond.ts)
              └─► opencode HTTP API (GET /session, /session/{id}/message)
              └─► Slack chat.postMessage
              └─► ConfigMap delete (cleanup)
```

## Task CR

### GVK

| Field   | Value                |
| ------- | -------------------- |
| group   | `kubeopencode.io`    |
| version | `v1alpha1`           |
| kind    | `Task`               |
| plural  | `tasks` (namespaced) |

Source: `src/plugins/llm-agent/task-cr-client.ts:9-11`.

### Name (idempotency key)

Task CR names are derived from the Slack `event_id`:

```
slack-<sha256(event_id)[:16]>
```

Source: `taskCrNameForSlackEvent` at `src/plugins/llm-agent/task-cr-client.ts:86-89`.

The Slack `event_id` (e.g. `Ev08AB12CDE`) is hashed to keep names RFC 1123 label-safe, and the same event always maps to the same name. The plugin treats HTTP 409 from `createNamespacedCustomObject` as `already_exists` and continues as if the create succeeded (`src/plugins/llm-agent/task-cr-client.ts:132-137`), so Slack-side retries of the same delivery converge on a single Task CR rather than creating duplicates.

### Spec (what slack-bot writes)

Built by `buildTaskCrManifest` at `src/plugins/llm-agent/task-cr-client.ts:54-81`:

```yaml
apiVersion: kubeopencode.io/v1alpha1
kind: Task
metadata:
  name: slack-<hash>
  namespace: kubeopencode
spec:
  agentRef:
    name: slack-bot
  description: <prompt text for opencode>
  contexts:
    - name: <string>
      type: Text | ConfigMap
      mountPath: <string>
      # Text
      text: <string>
      # ConfigMap
      configMap:
        name: <configmap name>
```

`spec.contexts` always carries the two Slack-thread anchors, plus the optional session-resume hint and image mount. The exact set is assembled in `buildContexts` at `src/plugins/llm-agent/steps/submit-task.ts:20-56`:

| `name`                | `type`      | `mountPath`                | Present when                                                     | Source                                       |
| --------------------- | ----------- | -------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| `slack-channel`       | `Text`      | `slack-context/channel`    | Always                                                           | `submit-task.ts:26-31`                       |
| `slack-thread-ts`     | `Text`      | `slack-context/thread-ts`  | Always                                                           | `submit-task.ts:32-37`                       |
| `opencode-session-id` | `Text`      | `slack-context/session-id` | The Slack thread has a prior opencode session recorded           | `submit-task.ts:39-46`, `respond.ts:211-219` |
| `slack-images`        | `ConfigMap` | `slack-images`             | The Slack message has image attachments that fit the size budget | `submit-task.ts:47-54`                       |

The `description` field is the prompt: the Slack message text with image-handling hints prepended when attachments are present (`composeDescription` at `src/plugins/llm-agent/steps/submit-task.ts:238-253`).

`ContextType` here intentionally only uses the `Text` and `ConfigMap` variants of the kubeopencode v1alpha1 schema; `Git`, `Runtime`, and `URL` are not produced by this plugin (`src/plugins/llm-agent/task-cr-client.ts:13-15`).

### Status (what slack-bot reads)

`parseTaskCrItem` at `src/plugins/llm-agent/task-cr-client.ts:97-111` reads exactly two fields from the Task CR status subresource:

- `status.phase` — string
- `status.message` — string, surfaced verbatim into Slack when `phase == Failed`

`waitForCompletion` (`src/plugins/llm-agent/steps/wait-for-completion.ts:68-115`) treats phases as follows:

| `status.phase` | Behaviour                                                |
| -------------- | -------------------------------------------------------- |
| `Pending`      | Show "Preparing" bubble in the Slack thread              |
| `Queued`       | Show "Waiting in queue…" bubble                          |
| `Running`      | Show "Working on it…" bubble                             |
| `Completed`    | Terminal — proceed to fetch the opencode reply           |
| `Failed`       | Terminal — post `Task failed: <status.message>` to Slack |
| anything else  | Treated as in-progress; no bubble update                 |

The operator MUST drive the CR to one of `Completed` or `Failed` for the plugin to ever stop polling. The plugin polls via `list` (not `watch`) every `DEFAULT_POLL_INTERVAL_MS = 5000` ms (`src/plugins/llm-agent/process-mention-deps.ts:13`). If a Task CR disappears mid-poll (no item with the expected name in the list response), `waitForCompletion` throws and the dispatcher gives up on that Slack event (`wait-for-completion.ts:94-103`).

## Image ConfigMap

When a Slack message has image attachments, the plugin first creates a ConfigMap in the same namespace and references it from `spec.contexts` (`src/plugins/llm-agent/steps/submit-task.ts:204-222`).

- Name: `<task-cr-name>-images` (`configMapNameForSlackEvent` at `src/plugins/llm-agent/steps/submit-task.ts:97-98`)
- Labels: `slack-bot.fohte.net/slack-event-id: <event_id>` (`submit-task.ts:218-220`)
- Payload: `binaryData` keyed by `<NN>-<slack-file-id>.<ext>`, base64-encoded raw bytes (`buildConfigMapManifest` at `src/plugins/llm-agent/configmap-client.ts:43-60`)
- Size budget: ≤ 500 KiB per image and ≤ 700 KiB total before base64 expansion (`submit-task.ts:17-18`); over-budget images are dropped pre-create

The ConfigMap is mounted into the opencode runner workspace at `slack-images/` (the `mountPath` of the `slack-images` context). The plugin deletes the ConfigMap on terminal phase (`src/plugins/llm-agent/steps/respond.ts:236-250`); a 404 is treated as a no-op, so the operator does not have to keep the object alive after the runner exits.

## opencode HTTP API

The plugin reaches opencode directly over HTTP — not through the operator — for both the resume-session hint and the final assistant reply.

### Connection

- Default base URL: `http://slack-bot.kubeopencode.svc.cluster.local:4096`
- Source: `DEFAULT_OPENCODE_BASE_URL` at `src/plugins/llm-agent/opencode-client.ts:1-2`
- Retry: 3 attempts with a 1000 ms fixed delay between attempts (`DEFAULT_OPENCODE_FETCH_ATTEMPTS` at `src/plugins/llm-agent/opencode-client.ts:4`, `DEFAULT_OPENCODE_RETRY_DELAY_MS` at `src/plugins/llm-agent/opencode-client.ts:5`; retry loops inside `fetchLatestAssistantText` and `findSessionIdByTitle`)

The default base URL implies a `Service` named `slack-bot` in the `kubeopencode` namespace whose target port serves opencode's HTTP API on port `4096`.

### Endpoints consumed

| Method | Path                           | Used by                                                                                                                          | Expectation                                                                                                                                                                                                                                      |
| ------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/session`                     | `findSessionIdByTitle` at `opencode-client.ts:128-142` (single-attempt helper `findSessionIdOnce` at `opencode-client.ts:73-95`) | Returns a JSON array; each entry has `id` (string) and `title` (string). The plugin picks the first entry whose `title` matches a candidate value (see below).                                                                                   |
| `GET`  | `/session/{sessionId}/message` | `fetchLatestAssistantText` at `opencode-client.ts:113-127` (single-attempt helper `fetchOnce` at `opencode-client.ts:45-71`)     | Returns a JSON array of messages, oldest first; each entry has `info.role` (string) and `parts[]` with `{ type: "text", text: string }`. The plugin walks from the end and returns the joined text parts of the most recent `assistant` message. |

### Session-title convention

On the first Slack mention in a thread, `respond` looks the opencode session up by title using the **Task CR name** as the title (`src/plugins/llm-agent/steps/respond.ts:56-58`). On later turns it uses the session id remembered in the plugin's own `thread_session_map`. This means the kubeopencode runner / wrapper invoking opencode MUST set the opencode session title to the Task CR name (`metadata.name`) on first run; otherwise the plugin cannot find the session and falls back to a placeholder message.

## Pre-existing cluster resources

The plugin assumes the following objects already exist when it starts dispatching:

| Resource                                                        | Name                    | Notes                                                                                                                                                           |
| --------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Namespace`                                                     | `kubeopencode`          | Hardcoded default (`DEFAULT_TASK_CR_NAMESPACE` at `src/plugins/llm-agent/process-mention-deps.ts:11`). Not configurable via env var.                            |
| `Agent` CR                                                      | `slack-bot`             | Hardcoded default (`DEFAULT_TASK_CR_AGENT_NAME` at `src/plugins/llm-agent/process-mention-deps.ts:12`). Referenced from every Task CR via `spec.agentRef.name`. |
| opencode `Service`                                              | `slack-bot` (port 4096) | Implied by `DEFAULT_OPENCODE_BASE_URL` (`opencode-client.ts:1-2`). The service must front opencode's HTTP API.                                                  |
| `CustomResourceDefinition` for `tasks.kubeopencode.io` v1alpha1 | —                       | Required for the Task CR create/list calls to succeed (`task-cr-client.ts:9-11`). Owned by the kubeopencode operator install.                                   |

## RBAC required by the slack-bot Pod

The plugin uses `KubeConfig.loadFromDefault()` (`src/plugins/llm-agent/task-cr-client.ts:118` and `src/plugins/llm-agent/configmap-client.ts:67`), which in-cluster resolves to the Pod's ServiceAccount. That ServiceAccount needs at least the verbs the code calls:

| API group / resource                 | Verbs              | Used by                                                         |
| ------------------------------------ | ------------------ | --------------------------------------------------------------- |
| `kubeopencode.io/tasks` (namespaced) | `create`, `list`   | `createKubernetesTaskCrClient` (`task-cr-client.ts:120-156`)    |
| `""/configmaps` (namespaced)         | `create`, `delete` | `createKubernetesConfigMapClient` (`configmap-client.ts:69-99`) |

All access is scoped to the `kubeopencode` namespace; no cluster-scoped permissions are needed from this plugin.

## Summary of what infra owns vs. what slack-bot owns

| Owned by infra (kubeopencode side)                                                             | Owned by slack-bot (this repo)                                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Task` CRD + operator implementation, including phase transitions and `status.{phase,message}` | Task CR `metadata.name` format and idempotency, `spec.*` contents            |
| `Agent` CR named `slack-bot` and whatever runner image / scheduling it drives                  | Creating one Task CR per Slack event, referencing `agentRef.name: slack-bot` |
| opencode HTTP API exposed as a `Service` reachable at the default base URL                     | Calling `GET /session` and `GET /session/{id}/message`; retry policy         |
| Setting the opencode session title to the Task CR name on first run                            | Looking the session up by that title on the first turn of a Slack thread     |
| RoleBinding granting the slack-bot ServiceAccount the verbs listed above                       | Using only those verbs from in-cluster credentials                           |

# llm-agent ↔ kubeopencode contract

The `llm-agent` plugin runs Slack mentions on the [kubeopencode](https://github.com/fohte/infra) operator: it creates a `Task` CR in the cluster, the operator spawns an opencode runner Pod, and the plugin fetches the assistant reply via opencode's HTTP API. This document captures everything the plugin requires from the surrounding kubeopencode deployment so the infra side has a single reference to consult when changing the operator-side chart or the operator itself.

Every claim below names the source symbol (`createTaskDispatcher`, `buildTaskCrManifest`, etc.) instead of line numbers, so a reader can grep `src/plugins/llm-agent/` for the symbol when the doc and the code drift.

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

Source: `TASK_CR_GROUP` / `TASK_CR_VERSION` / `TASK_CR_PLURAL` in `src/plugins/llm-agent/task-cr-client.ts`.

### Name (idempotency key)

Task CR names are derived from the Slack `event_id`:

```
slack-<sha256(event_id)[:16]>
```

Source: `taskCrNameForSlackEvent` in `src/plugins/llm-agent/task-cr-client.ts`.

The Slack `event_id` is hashed to keep names RFC 1123 label-safe, and the same event always maps to the same name. The plugin treats HTTP 409 from `createNamespacedCustomObject` as `already_exists` and continues as if the create succeeded, so Slack-side retries of the same delivery converge on a single Task CR rather than creating duplicates.

### Spec (what slack-bot writes)

Built by `buildTaskCrManifest` in `src/plugins/llm-agent/task-cr-client.ts`:

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

`spec.contexts` always carries the two Slack-thread anchors, plus the optional session-resume hint and image mount. The exact set is assembled in `buildContexts` in `src/plugins/llm-agent/steps/submit-task.ts`:

| `name`                | `type`      | `mountPath`                | Present when                                                                |
| --------------------- | ----------- | -------------------------- | --------------------------------------------------------------------------- |
| `slack-channel`       | `Text`      | `slack-context/channel`    | Always                                                                      |
| `slack-thread-ts`     | `Text`      | `slack-context/thread-ts`  | Always                                                                      |
| `opencode-session-id` | `Text`      | `slack-context/session-id` | The Slack thread already has an opencode session recorded (resumed thread)  |
| `slack-images`        | `ConfigMap` | `slack-images`             | The Slack message has image attachments that fit the per-image / total caps |

The `description` field is the prompt: the Slack message text with image-handling hints prepended when attachments are present (`composeDescription` in `src/plugins/llm-agent/steps/submit-task.ts`).

`ContextType` only uses the `Text` and `ConfigMap` variants of the kubeopencode v1alpha1 schema; `Git`, `Runtime`, and `URL` are not produced by this plugin.

### Status (what slack-bot reads)

`parseTaskCrItem` in `src/plugins/llm-agent/task-cr-client.ts` reads exactly two fields from the Task CR status subresource:

- `status.phase` — string
- `status.message` — string, surfaced verbatim into Slack when `phase == Failed`

`waitForCompletion` (`src/plugins/llm-agent/steps/wait-for-completion.ts`) treats phases as follows:

| `status.phase` | Behaviour                                                |
| -------------- | -------------------------------------------------------- |
| `Pending`      | Show "Preparing" bubble in the Slack thread              |
| `Queued`       | Show "Waiting in queue…" bubble                          |
| `Running`      | Show "Working on it…" bubble                             |
| `Completed`    | Terminal — proceed to fetch the opencode reply           |
| `Failed`       | Terminal — post `Task failed: <status.message>` to Slack |
| anything else  | Treated as in-progress; no bubble update                 |

The operator MUST drive the CR to one of `Completed` or `Failed` for the plugin to ever stop polling. The plugin polls via `list` (not `watch`) every `DEFAULT_POLL_INTERVAL_MS` (5000 ms; see `src/plugins/llm-agent/process-mention-deps.ts`). If a Task CR disappears mid-poll, `waitForCompletion` throws and the dispatcher gives up on that Slack event.

## Image ConfigMap

When a Slack message has image attachments, the plugin first creates a ConfigMap in the same namespace and references it from `spec.contexts` (see `submitTask` / `ensureImageConfigMap` in `src/plugins/llm-agent/steps/submit-task.ts`).

- Name: `<task-cr-name>-images` (`configMapNameForSlackEvent`)
- Labels: `slack-bot.fohte.net/slack-event-id: <event_id>`
- Payload: `binaryData` keyed by `<NN>-<slack-file-id>.<ext>`, base64-encoded raw bytes (`buildConfigMapManifest` in `src/plugins/llm-agent/configmap-client.ts`)
- Size budget: ≤ 500 KiB per image and ≤ 700 KiB total before base64 expansion (see `SINGLE_IMAGE_BYTE_CAP` / `TOTAL_IMAGE_BYTE_CAP` in `submit-task.ts`); over-budget images are dropped pre-create

The ConfigMap is mounted into the opencode runner workspace at `slack-images/` (the `mountPath` of the `slack-images` context). The plugin deletes the ConfigMap on terminal phase; a 404 is treated as a no-op, so the operator does not have to keep the object alive after the runner exits.

## opencode HTTP API

The plugin reaches opencode directly over HTTP — not through the operator — for both the resume-session hint and the final assistant reply.

### Connection

- Default base URL: `http://slack-bot.kubeopencode.svc.cluster.local:4096` (`DEFAULT_OPENCODE_BASE_URL` in `src/plugins/llm-agent/opencode-client.ts`)
- Retry: 3 attempts with a 1000 ms fixed delay between attempts (`DEFAULT_OPENCODE_FETCH_ATTEMPTS` / `DEFAULT_OPENCODE_RETRY_DELAY_MS` in the same file)

The default base URL implies a `Service` named `slack-bot` in the `kubeopencode` namespace whose target port serves opencode's HTTP API on port `4096`.

### Endpoints consumed

| Method | Path                           | Used by                                                              | Expectation                                                                                                                                                                                                                                      |
| ------ | ------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/session`                     | `findSessionIdByTitle` in `src/plugins/llm-agent/opencode-client.ts` | Returns a JSON array; each entry has `id` (string) and `title` (string). The plugin picks the first entry whose `title` matches a candidate value (see below).                                                                                   |
| `GET`  | `/session/{sessionId}/message` | `fetchLatestAssistantText` in the same file                          | Returns a JSON array of messages, oldest first; each entry has `info.role` (string) and `parts[]` with `{ type: "text", text: string }`. The plugin walks from the end and returns the joined text parts of the most recent `assistant` message. |

### Session-title convention

On the first Slack mention in a thread, `respond` looks the opencode session up by title using the **Task CR name** as the title (see `resolveSessionId` in `src/plugins/llm-agent/steps/respond.ts`). On later turns it uses the session id remembered in the plugin's own `thread_session_map`. This means the kubeopencode runner / wrapper invoking opencode MUST set the opencode session title to the Task CR name (`metadata.name`) on first run; otherwise the plugin cannot find the session and falls back to a placeholder message.

## Pre-existing cluster resources

The plugin assumes the following objects already exist when it starts dispatching:

| Resource                                                        | Name                    | Notes                                                                                                                             |
| --------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Namespace`                                                     | `kubeopencode`          | Hardcoded default (`DEFAULT_TASK_CR_NAMESPACE` in `src/plugins/llm-agent/process-mention-deps.ts`). Not configurable via env var. |
| `Agent` CR                                                      | `slack-bot`             | Hardcoded default (`DEFAULT_TASK_CR_AGENT_NAME` in the same file). Referenced from every Task CR via `spec.agentRef.name`.        |
| opencode `Service`                                              | `slack-bot` (port 4096) | Implied by `DEFAULT_OPENCODE_BASE_URL`. The service must front opencode's HTTP API.                                               |
| `CustomResourceDefinition` for `tasks.kubeopencode.io` v1alpha1 | —                       | Required for the Task CR create/list calls to succeed. Owned by the kubeopencode operator install.                                |

## RBAC required by the slack-bot Pod

The plugin uses `KubeConfig.loadFromDefault()` in both `task-cr-client.ts` and `configmap-client.ts`, which in-cluster resolves to the Pod's ServiceAccount. That ServiceAccount needs at least the verbs the code calls:

| API group / resource                 | Verbs              | Used by                                                    |
| ------------------------------------ | ------------------ | ---------------------------------------------------------- |
| `kubeopencode.io/tasks` (namespaced) | `create`, `list`   | `createKubernetesTaskCrClient` in `task-cr-client.ts`      |
| `""/configmaps` (namespaced)         | `create`, `delete` | `createKubernetesConfigMapClient` in `configmap-client.ts` |

All access is scoped to the `kubeopencode` namespace; no cluster-scoped permissions are needed from this plugin.

## Summary of what infra owns vs. what slack-bot owns

| Owned by infra (kubeopencode side)                                                             | Owned by slack-bot (this repo)                                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Task` CRD + operator implementation, including phase transitions and `status.{phase,message}` | Task CR `metadata.name` format and idempotency, `spec.*` contents            |
| `Agent` CR named `slack-bot` and whatever runner image / scheduling it drives                  | Creating one Task CR per Slack event, referencing `agentRef.name: slack-bot` |
| opencode HTTP API exposed as a `Service` reachable at the default base URL                     | Calling `GET /session` and `GET /session/{id}/message`; retry policy         |
| Setting the opencode session title to the Task CR name on first run                            | Looking the session up by that title on the first turn of a Slack thread     |
| RoleBinding granting the slack-bot ServiceAccount the verbs listed above                       | Using only those verbs from in-cluster credentials                           |

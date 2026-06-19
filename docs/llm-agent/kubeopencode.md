# llm-agent ↔ kubeopencode contract

The `llm-agent` plugin runs each Slack mention on the [kubeopencode](https://github.com/fohte/infra) operator: it creates a `Task` CR in the cluster, the operator spawns an opencode runner Pod, and the plugin fetches the assistant reply via opencode's HTTP API. This document is the contract between the two sides — what slack-bot writes / reads, and what the kubeopencode deployment must provide. It does not describe slack-bot's internal structure; that's owned by the source.

## Topology

```
Slack event
  │
  ▼
slack-bot ──create──► Task CR  ──watch──► kubeopencode operator
                          │                        │
                          │                        ▼
                          │                opencode runner Pod
                          │                        │
                          │                        ▼
                          └◄──poll status── (writes status.phase /
                                             status.message)
                                                   │
                          opencode HTTP API ◄──────┘
                              ▲
                              │  GET /session
                              │  GET /session/{id}/message
                          slack-bot
```

## Task CR

### GVK

| Field   | Value                |
| ------- | -------------------- |
| group   | `kubeopencode.io`    |
| version | `v1alpha1`           |
| kind    | `Task`               |
| plural  | `tasks` (namespaced) |

### Name (idempotency key)

Each Slack mention maps to a Task CR whose name is derived from the Slack `event_id`:

```
slack-<sha256(event_id)[:16]>
```

The Slack `event_id` is hashed to keep names RFC 1123 label-safe. The same `event_id` always maps to the same name, so retried deliveries of the same Slack event converge on a single Task CR. slack-bot treats `AlreadyExists` (HTTP 409) on create as a successful no-op for this reason.

### Spec written by slack-bot

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
      type: <Text | ConfigMap>
      mountPath: <string>
      # Text
      text: <string>
      # ConfigMap
      configMap:
        name: <configmap name>
```

`spec.description` is the prompt. It is the Slack message text after stripping the bot mention prefix, with image-handling hints prepended when the message has image attachments.

`spec.contexts` always carries the two Slack-thread anchors, plus an optional session-resume hint and an optional image mount:

| `name`                | `type`      | `mountPath`                | Present when                                                                |
| --------------------- | ----------- | -------------------------- | --------------------------------------------------------------------------- |
| `slack-channel`       | `Text`      | `slack-context/channel`    | Always                                                                      |
| `slack-thread-ts`     | `Text`      | `slack-context/thread-ts`  | Always                                                                      |
| `opencode-session-id` | `Text`      | `slack-context/session-id` | The Slack thread already has a recorded opencode session (resumed thread)   |
| `slack-images`        | `ConfigMap` | `slack-images`             | The Slack message has image attachments that fit the per-image / total caps |

slack-bot only produces the `Text` and `ConfigMap` variants of `ContextType`; the v1alpha1 `Git`, `Runtime`, and `URL` variants are not used.

### Status read by slack-bot

slack-bot reads exactly two fields from the status subresource:

- `status.phase` — string
- `status.message` — string, surfaced verbatim into Slack on failure

Phase handling:

| `status.phase` | Behaviour                                                |
| -------------- | -------------------------------------------------------- |
| `Pending`      | Show "Preparing" bubble in the Slack thread              |
| `Queued`       | Show "Waiting in queue…" bubble                          |
| `Running`      | Show "Working on it…" bubble                             |
| `Completed`    | Terminal — proceed to fetch the opencode reply           |
| `Failed`       | Terminal — post `Task failed: <status.message>` to Slack |
| anything else  | Treated as in-progress; no bubble update                 |

slack-bot polls the Task CR via `list` (not `watch`) on a fixed 5 s interval. The operator MUST eventually drive the CR to `Completed` or `Failed`; otherwise slack-bot polls forever. If the CR disappears mid-poll, slack-bot gives up on that Slack event.

## Image ConfigMap

When a Slack message has image attachments, slack-bot creates a ConfigMap in the same namespace before the Task CR and references it from `spec.contexts`.

- Name: `<task-cr-name>-images`
- Label: `slack-bot.fohte.net/slack-event-id: <event_id>`
- Payload: `binaryData` keyed by `<NN>-<slack-file-id>.<ext>`, base64-encoded raw bytes
- Size budget: ≤ 500 KiB per image and ≤ 700 KiB total before base64 expansion; over-budget images are dropped before create

The ConfigMap is mounted into the opencode runner workspace at `slack-images/`. slack-bot deletes it on terminal phase and treats `NotFound` as a no-op, so the operator does not need to keep the object alive after the runner exits.

## opencode HTTP API

slack-bot reaches opencode directly over HTTP — not through the operator — to fetch the final assistant reply.

### Connection

- Default base URL: `http://slack-bot.kubeopencode.svc.cluster.local:4096`
- Implies a `Service` named `slack-bot` in the `kubeopencode` namespace exposing port `4096` (which routes to opencode's HTTP API)
- slack-bot retries each request up to 3 times with a 1000 ms fixed delay between attempts

### Endpoints consumed

| Method | Path                           | Expectation                                                                                                                                                                                                                                     |
| ------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/session`                     | Returns a JSON array; each entry has `id` (string) and `title` (string). slack-bot picks the first entry whose `title` matches the candidate value described below.                                                                             |
| `GET`  | `/session/{sessionId}/message` | Returns a JSON array of messages, oldest first; each entry has `info.role` (string) and `parts[]` with `{ type: "text", text: string }`. slack-bot walks from the end and returns the joined text parts of the most recent `assistant` message. |

### Session-title convention

On the first Slack mention in a thread, slack-bot looks the opencode session up by title using the **Task CR name** as the title. On later turns it uses the session id it remembered locally on the previous turn. The kubeopencode runner / wrapper that invokes opencode therefore MUST set the opencode session title to the Task CR name (`metadata.name`) on first run; otherwise slack-bot cannot find the session and falls back to a placeholder message.

## Pre-existing cluster resources

slack-bot assumes the following objects already exist when it starts dispatching:

| Resource                                                        | Name                    | Notes                                                                                              |
| --------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| `Namespace`                                                     | `kubeopencode`          | Injected as a plugin dependency with this default; not exposed as a runtime configuration knob.    |
| `Agent` CR                                                      | `slack-bot`             | Referenced from every Task CR via `spec.agentRef.name`. Same dependency-with-default arrangement.  |
| opencode `Service`                                              | `slack-bot` (port 4096) | Must front opencode's HTTP API at the default base URL above.                                      |
| `CustomResourceDefinition` for `tasks.kubeopencode.io` v1alpha1 | —                       | Required for the Task CR create/list calls to succeed. Owned by the kubeopencode operator install. |

## RBAC required by the slack-bot Pod

slack-bot authenticates to the API server with its in-cluster ServiceAccount. The ServiceAccount needs at least:

| API group / resource                 | Verbs              |
| ------------------------------------ | ------------------ |
| `kubeopencode.io/tasks` (namespaced) | `create`, `list`   |
| `""/configmaps` (namespaced)         | `create`, `delete` |

All access is scoped to the `kubeopencode` namespace; no cluster-scoped permissions are needed from this plugin.

## Summary of what infra owns vs. what slack-bot owns

| Owned by infra (kubeopencode side)                                                             | Owned by slack-bot (this repo)                                               |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Task` CRD + operator implementation, including phase transitions and `status.{phase,message}` | Task CR `metadata.name` format and idempotency, `spec.*` contents            |
| `Agent` CR named `slack-bot` and whatever runner image / scheduling it drives                  | Creating one Task CR per Slack event, referencing `agentRef.name: slack-bot` |
| opencode HTTP API exposed as a `Service` reachable at the default base URL                     | Calling `GET /session` and `GET /session/{id}/message`; retry policy         |
| Setting the opencode session title to the Task CR name on first run                            | Looking the session up by that title on the first turn of a Slack thread     |
| RoleBinding granting the slack-bot ServiceAccount the verbs listed above                       | Using only those verbs from in-cluster credentials                           |

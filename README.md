# slack-bot

A pluggable Slack bot core for personal use, hosting multiple apps (crawlers, blog publish, etc.) behind a single Slack App.

## Overview

slack-bot is an HTTP-only Request URL receiver for Slack: it does not use Socket Mode. Every incoming request is verified with HMAC-SHA256 against `SLACK_SIGNING_SECRET` before any plugin sees it. Plugins register declaratively with the slash commands they own and the handlers for each interaction type, and the core dispatches to the right plugin by command name or by the `<plugin-name>:` prefix on `action_id` / `callback_id`. The bot runs as a single replica behind Cloudflare Tunnel and Cloudflare Access, with the Slack endpoints exposed via Service Auth Bypass.

## Endpoints

| Method | Path                       | Purpose                                                                                   |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------- |
| POST   | `/api/slack/commands`      | Slash Commands Request URL.                                                               |
| POST   | `/api/slack/interactivity` | Interactivity & Shortcuts Request URL (block actions, view submissions, shortcuts, etc.). |
| POST   | `/api/slack/events`        | Events API Request URL. Also handles the `url_verification` challenge automatically.      |
| GET    | `/health/live`             | Liveness probe.                                                                           |
| GET    | `/health/ready`            | Readiness probe. Returns 503 until plugins finish registering and the server is ready.    |

## Environment variables

| Variable                                      | Required | Default | Description                                                                                                    |
| --------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`                        | Yes      | -       | Slack App signing secret. Used for HMAC-SHA256 verification of every Slack request.                            |
| `SLACK_BOT_TOKEN`                             | Yes      | -       | Bot User OAuth Token (`xoxb-...`). Used by the Slack Web API client.                                           |
| `PORT`                                        | No       | `8080`  | TCP port the HTTP server listens on.                                                                           |
| `MAX_CONCURRENT_TASKS`                        | No       | `32`    | Maximum number of concurrent in-memory scheduler tasks. Registration beyond this limit fails.                  |
| `MAX_WEB_API_RETRIES`                         | No       | `3`     | Maximum retry count for Slack Web API calls that hit HTTP 429.                                                 |
| `LOG_LEVEL`                                   | No       | `info`  | One of `debug`, `info`, `warn`, `error`.                                                                       |
| `DATABASE_URL`                                | No       | -       | Postgres connection string consumed by `pnpm migrate`. Required only for plugins that own a logical DB.        |
| `CF_ACCESS_<PLUGIN_NAME_UPPER>_CLIENT_ID`     | No       | -       | Cloudflare Access Service Token client ID for the named plugin. Hyphens in the plugin name become underscores. |
| `CF_ACCESS_<PLUGIN_NAME_UPPER>_CLIENT_SECRET` | No       | -       | Cloudflare Access Service Token client secret for the named plugin. Same naming rule as above.                 |

Secrets must not be committed. In production they are injected via a Kubernetes Secret. Locally, place them in `.env`, which is gitignored.

## Slack App setup

Perform these steps once per Slack workspace.

1. Create a new Slack App at https://api.slack.com/apps using "From scratch".
2. Open **Basic Information**, copy the **Signing Secret**, and set it as `SLACK_SIGNING_SECRET`.
3. Open **OAuth & Permissions** and add the bot scopes you need. The minimum recommended set is `chat:write`, `commands`, and `chat:write.public`. Plugins may require additional scopes (for example, `views:write` for modal-based flows). Install the app to the workspace, copy the **Bot User OAuth Token** (`xoxb-...`), and set it as `SLACK_BOT_TOKEN`.
4. Open **Slash Commands** and register each command exposed by the deployed plugins (for example, `/crawl-list`). Follow the hyphenated naming convention described below. Set the Request URL to `https://<your-host>/api/slack/commands`.
5. Open **Interactivity & Shortcuts**, enable interactivity, and set the Request URL to `https://<your-host>/api/slack/interactivity`.
6. Open **Event Subscriptions** (only required when a plugin uses it), enable events, and set the Request URL to `https://<your-host>/api/slack/events`. Slack sends a `url_verification` challenge on save; the bot answers it automatically.

The slash command list can also be generated as a Slack App manifest fragment via `PluginRegistry.buildAppManifestCommands()` instead of being entered by hand.

## Local development

1. Install runtimes and tooling: `mise install` (Node.js 24, lefthook, etc.).
2. Enable corepack for pnpm: `corepack enable`.
3. Install dependencies: `pnpm install`.
4. Create a `.env` file based on the table above. Do not commit it.
5. Start the bot: `pnpm start` (runs `tsx src/main.ts`).
6. Expose the local server to Slack with ngrok: `ngrok http 8080`. Use the `https://...ngrok-free.app` URL as the Request URL prefix in the Slack App settings while developing.
7. Run checks: `pnpm test` (typecheck plus unit) and `pnpm lint`.

## Database migrations

Plugin-owned schemas live under `migrations/` and are managed by [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate). The migrator reads `DATABASE_URL` and applies any pending files in timestamp order.

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/slack_bot_llm_agent pnpm migrate:up
DATABASE_URL=... pnpm migrate:down
DATABASE_URL=... pnpm migrate:create some-name      # scaffolds a new .ts migration
```

In CI / production the same `pnpm migrate:up` is invoked against the target database before the bot starts. Migrations should be reversible (`up` / `down`) and idempotent enough to re-apply after a rollback.

The migration schema is covered by an integration test that spins up an ephemeral Postgres via Testcontainers. It is opt-in (requires a reachable Docker daemon) and is skipped by `pnpm test`. Run it explicitly with `pnpm test:db`.

## Adding a plugin

A plugin is an object that declares a `name`, the `commands` it owns, and one or more handler methods. Register plugins by passing them to `bootstrap`.

```typescript
import { bootstrap, type Plugin } from 'slack-bot'

const pingPlugin: Plugin = {
  name: 'ping',
  commands: [
    {
      command: '/ping',
      description: 'Reply with pong.',
    },
  ],
  async onCommand(ctx, body) {
    // Acknowledge synchronously within the 3-second Slack deadline.
    ctx.ack({ text: 'thinking...' })

    // Long-running work happens after ack().
    const reply = await computeReply(body.text)

    // Edit the original ack message.
    await ctx.originalUpdater().patch({ text: reply })

    // Or send a new follow-up message via response_url.
    await ctx.followUp({ text: 'done' })
  },
}

bootstrap({ plugins: [pingPlugin] })
```

When a plugin needs core services (the in-memory scheduler, the Cloudflare Access fetch helper, the Slack Web API client, the logger, or the resolved config), pass a factory function instead. `bootstrap` invokes the factory with a `PluginDeps` object at startup.

```typescript
import { bootstrap, type PluginFactory } from 'slack-bot'

const crawlPlugin: PluginFactory = ({ scheduler, cfAccess, logger }) => {
  const http = cfAccess.forPlugin('crawl')
  return {
    name: 'crawl',
    commands: [{ command: '/crawl-run', description: 'Start a crawl.' }],
    async onCommand(ctx, body) {
      ctx.ack({ text: 'starting...' })
      scheduler.schedule({
        name: `crawl:${body.text}`,
        intervalMs: 5000,
        maxDurationMs: 30 * 60 * 1000,
        async tick() {
          const res = await http.request(
            `https://crawlers.fohte.net/api/runs/${body.text}`,
          )
          const status = (await res.json()) as { done: boolean }
          await ctx
            .originalUpdater()
            .patch({ text: `status: ${String(status.done)}` })
          return { done: status.done }
        },
        async onError(err) {
          logger.error({ event: 'crawl_tick_error', err: String(err) })
        },
      })
    },
  }
}

bootstrap({ plugins: [crawlPlugin] })
```

Rules:

- Plugin `name` must match `/^[a-z][a-z0-9-]{0,31}$/`.
- Plugin `name` and slash command names must be globally unique within the bot. Boot fails fast on conflict.
- `ack()` must be called within 3 seconds (Slack requirement). Long work runs after `ack()` and uses `followUp()` or `originalUpdater().patch()`.

## Naming conventions

### Slash commands

Recommended pattern: `/<plugin-name>-<action>` (for example, `/crawl-list`, `/crawl-run`, `/blog-post`). Slack does not namespace slash commands across apps installed in a workspace, so prefixing with the plugin name reduces the chance of collision with unrelated apps. The bot does not enforce this; it is a convention for plugin authors.

### `action_id` / `block_id` / `callback_id`

Required pattern: `<plugin-name>:<action>[:<payload>]`. The router dispatches interactivity payloads by splitting on the first `:` and looking up the registered plugin by that prefix. A payload whose prefix does not match any registered plugin produces an ephemeral error reply.

Examples: `crawl:start:42`, `blog:retry`, `crawl:modal`.

## Logging

The bot emits structured JSON logs to stdout via pino. A redact filter scrubs known secret keys (bot token, signing secret, `authorization`, `*_token`, `*_secret`) so plugins do not have to think about it when logging context. Log level is configured via `LOG_LEVEL`.

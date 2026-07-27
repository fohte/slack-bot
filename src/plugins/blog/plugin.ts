import { okAsync, ResultAsync } from 'neverthrow'

import type { InteractionContext } from '#interaction/context'
import type { Logger } from '#logger/logger'
import { noopLogger } from '#logger/logger'
import type { Plugin, SlackAppManifestCommand } from '#plugin/plugin'
import type { CiWatcher } from '#plugins/blog/ci-watcher'
import { createCiWatcher } from '#plugins/blog/ci-watcher'
import type { BlogPluginConfig } from '#plugins/blog/config'
import { translateException } from '#plugins/blog/error-translator'
import { handleApplyButton } from '#plugins/blog/handlers/apply-button'
import { handleCancelButton } from '#plugins/blog/handlers/cancel-button'
import { handleCancelCommand } from '#plugins/blog/handlers/cancel-command'
import { handlePostCommand } from '#plugins/blog/handlers/post-command'
import { handleSelectSubmit } from '#plugins/blog/handlers/select-submit'
import { handleStatusCommand } from '#plugins/blog/handlers/status-command'
import type { BlogServiceClient } from '#plugins/blog/service-client'
import { createBlogServiceClient } from '#plugins/blog/service-client'
import type { InMemoryScheduler } from '#scheduler/scheduler'

export const BLOG_PLUGIN_NAME = 'blog'

export const BLOG_COMMANDS: readonly SlackAppManifestCommand[] = [
  {
    command: '/blog-post',
    description: 'Pick blog notes and create a publish PR',
  },
  { command: '/blog-status', description: 'List open blog publish PRs' },
  {
    command: '/blog-cancel',
    description: 'Cancel an open blog publish PR',
    usage_hint: '<pr_number>',
  },
]

export interface BlogPluginOptions {
  readonly config: BlogPluginConfig
  readonly client?: BlogServiceClient | undefined
  readonly logger?: Logger | undefined
  readonly scheduler?: InMemoryScheduler | undefined
  readonly ciWatcher?: CiWatcher | undefined
}

export const createBlogPlugin = (options: BlogPluginOptions): Plugin => {
  const client =
    options.client ??
    createBlogServiceClient({
      baseUrl: options.config.serviceUrl,
      bearerToken: options.config.serviceToken,
    })
  const logger = options.logger ?? noopLogger
  const ciWatcher =
    options.ciWatcher ??
    (options.scheduler !== undefined
      ? createCiWatcher({ scheduler: options.scheduler, client, logger })
      : undefined)
  const allowedUsers = new Set(options.config.allowedSlackUserIds)

  const isAllowed = (userId: string | undefined): boolean => {
    if (allowedUsers.size === 0) return true
    if (userId === undefined) return false
    return allowedUsers.has(userId)
  }

  return {
    name: BLOG_PLUGIN_NAME,
    commands: BLOG_COMMANDS,
    onCommand(ctx, body) {
      if (!isAllowed(body.user_id)) {
        ctx.ack({
          response_type: 'ephemeral',
          text: 'このコマンドを実行する権限がありません。',
        })
        return okAsync(undefined)
      }
      return ResultAsync.fromSafePromise(
        dispatchAndReport(ctx, logger, () => {
          switch (body.command) {
            case '/blog-post':
              return handlePostCommand({ ctx, body, client })
            case '/blog-status':
              return handleStatusCommand({ ctx, body, client })
            case '/blog-cancel':
              return handleCancelCommand({ ctx, body, client })
            default:
              ctx.ack({
                response_type: 'ephemeral',
                text: `未対応のコマンドです: ${body.command}`,
              })
              return okAsync(undefined)
          }
        }),
      )
    },
    onBlockAction(ctx, payload) {
      if (!isAllowed(payload.user?.id)) {
        ctx.ack({
          response_type: 'ephemeral',
          text: 'この操作を実行する権限がありません。',
        })
        return okAsync(undefined)
      }
      const action = payload.actions[0]
      if (action === undefined) {
        ctx.ack()
        return okAsync(undefined)
      }
      return ResultAsync.fromSafePromise(
        dispatchAndReport(ctx, logger, () => {
          switch (action.action_id) {
            case 'blog:select-submit':
              return handleSelectSubmit({ ctx, payload, action, client })
            case 'blog:apply':
              return handleApplyButton({
                ctx,
                payload,
                action,
                client,
                ...(ciWatcher !== undefined
                  ? {
                      onSuccess: (success) => {
                        ciWatcher.startWatching({
                          prNumber: success.prNumber,
                          prUrl: success.prUrl,
                          updater: success.ctx.originalUpdater(),
                        })
                      },
                    }
                  : {}),
              })
            case 'blog:cancel':
              return handleCancelButton({ ctx, payload, action })
            default:
              ctx.ack()
              return okAsync(undefined)
          }
        }),
      )
    },
  }
}

// Turns a handler's Err into the Plugin interface's throw-free contract: a
// single isErr() branch routes every failure to reportError, instead of
// duplicating the same check per event.
const dispatchAndReport = async (
  ctx: InteractionContext,
  logger: Logger,
  dispatch: () => ResultAsync<void, unknown>,
): Promise<void> => {
  const result = await dispatch()
  if (result.isErr()) {
    await reportError(ctx, result.error, logger)
  }
}

const reportError = async (
  ctx: InteractionContext,
  err: unknown,
  logger: Logger,
): Promise<void> => {
  logger.error({ err }, 'blog plugin handler failed')
  ctx.ack()
  const text = translateException(err)
  const followUpResult = await ctx.followUp({
    response_type: 'ephemeral',
    text,
  })
  if (followUpResult.isErr()) {
    logger.error({ err: followUpResult.error }, 'blog plugin followUp failed')
  }
}

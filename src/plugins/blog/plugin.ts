import type { Plugin, SlackAppManifestCommand } from '@/plugin/plugin'
import type { BlogPluginConfig } from '@/plugins/blog/config'
import { translateException } from '@/plugins/blog/error-translator'
import { handleApplyButton } from '@/plugins/blog/handlers/apply-button'
import { handleCancelButton } from '@/plugins/blog/handlers/cancel-button'
import { handleCancelCommand } from '@/plugins/blog/handlers/cancel-command'
import { handlePostCommand } from '@/plugins/blog/handlers/post-command'
import { handleSelectSubmit } from '@/plugins/blog/handlers/select-submit'
import { handleStatusCommand } from '@/plugins/blog/handlers/status-command'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import { createBlogServiceClient } from '@/plugins/blog/service-client'

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
}

export const createBlogPlugin = (options: BlogPluginOptions): Plugin => {
  const client =
    options.client ??
    createBlogServiceClient({
      baseUrl: options.config.serviceUrl,
      bearerToken: options.config.serviceToken,
    })
  const allowedUsers = new Set(options.config.allowedSlackUserIds)

  const isAllowed = (userId: string | undefined): boolean => {
    if (allowedUsers.size === 0) return true
    if (userId === undefined) return false
    return allowedUsers.has(userId)
  }

  return {
    name: BLOG_PLUGIN_NAME,
    commands: BLOG_COMMANDS,
    async onCommand(ctx, body) {
      if (!isAllowed(body.user_id)) {
        ctx.ack({
          response_type: 'ephemeral',
          text: 'このコマンドを実行する権限がありません。',
        })
        return
      }
      try {
        switch (body.command) {
          case '/blog-post':
            await handlePostCommand({ ctx, body, client })
            return
          case '/blog-status':
            await handleStatusCommand({ ctx, body, client })
            return
          case '/blog-cancel':
            await handleCancelCommand({ ctx, body, client })
            return
          default:
            ctx.ack({
              response_type: 'ephemeral',
              text: `未対応のコマンドです: ${body.command}`,
            })
        }
      } catch (err) {
        await reportError(ctx, err)
      }
    },
    async onBlockAction(ctx, payload) {
      if (!isAllowed(payload.user?.id)) {
        ctx.ack({
          response_type: 'ephemeral',
          text: 'この操作を実行する権限がありません。',
        })
        return
      }
      const action = payload.actions[0]
      if (action === undefined) {
        ctx.ack()
        return
      }
      try {
        switch (action.action_id) {
          case 'blog:select-submit':
            await handleSelectSubmit({ ctx, payload, action, client })
            return
          case 'blog:apply':
            await handleApplyButton({ ctx, payload, action, client })
            return
          case 'blog:cancel':
            await handleCancelButton({ ctx, payload, action })
            return
          default:
            ctx.ack()
        }
      } catch (err) {
        await reportError(ctx, err)
      }
    },
  }
}

const reportError = async (
  ctx: import('@/interaction/context').InteractionContext,
  err: unknown,
): Promise<void> => {
  ctx.ack()
  const text = translateException(err)
  try {
    await ctx.followUp({ response_type: 'ephemeral', text })
  } catch {
    // ignore secondary failure
  }
}

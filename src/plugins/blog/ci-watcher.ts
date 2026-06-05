import type { CiStatus } from '@fohte/blog-publisher-contract'

import type { MessageUpdater } from '@/interaction/message-updater'
import type { Logger } from '@/logger/logger'
import { noopLogger } from '@/logger/logger'
import { escapeMrkdwn } from '@/plugins/blog/plan-presenter'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type { InMemoryScheduler } from '@/scheduler/scheduler'

export const CI_WATCH_INTERVAL_MS = 30_000
export const CI_WATCH_MAX_DURATION_MS = 15 * 60 * 1000

export interface CiWatchInput {
  readonly prNumber: number
  readonly prUrl: string
  readonly updater: MessageUpdater
}

export interface CiWatcher {
  startWatching(input: CiWatchInput): void
}

export interface CiWatcherOptions {
  readonly scheduler: InMemoryScheduler
  readonly client: BlogServiceClient
  readonly logger?: Logger | undefined
  readonly intervalMs?: number | undefined
  readonly maxDurationMs?: number | undefined
}

interface RenderedMessage {
  readonly text: string
  readonly blocks: unknown[]
}

export const renderCiSuccessBlocks = (options: {
  prNumber: number
  prUrl: string
  previewUrl: string | undefined
}): RenderedMessage => {
  const prUrl = escapeMrkdwn(options.prUrl)
  const previewUrl =
    options.previewUrl !== undefined
      ? escapeMrkdwn(options.previewUrl)
      : undefined
  const previewLine =
    previewUrl !== undefined ? `\nPreview: <${previewUrl}|${previewUrl}>` : ''
  const text = `:white_check_mark: PR #${String(options.prNumber)} CI 成功`
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:white_check_mark: PR #${String(options.prNumber)} の CI が成功しました\n<${prUrl}|${prUrl}>${previewLine}`,
        },
      },
    ],
  }
}

export const renderCiFailureBlocks = (options: {
  prNumber: number
  prUrl: string
  failedChecks: readonly string[]
}): RenderedMessage => {
  const prUrl = escapeMrkdwn(options.prUrl)
  const checks =
    options.failedChecks.length > 0
      ? options.failedChecks.map((c) => `\`${escapeMrkdwn(c)}\``).join(', ')
      : '(詳細なし)'
  const text = `:x: PR #${String(options.prNumber)} CI 失敗`
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:x: PR #${String(options.prNumber)} の CI が失敗しました\n<${prUrl}|${prUrl}>\nFailed checks: ${checks}`,
        },
      },
    ],
  }
}

export const renderCiTimeoutBlocks = (options: {
  prNumber: number
  prUrl: string
}): RenderedMessage => {
  const prUrl = escapeMrkdwn(options.prUrl)
  const text = `:hourglass: PR #${String(options.prNumber)} CI 監視タイムアウト`
  return {
    text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:hourglass: PR #${String(options.prNumber)} の CI 監視が 15 分でタイムアウトしました\n<${prUrl}|${prUrl}>\n\`/blog-status\` で最新状況を確認してください。`,
        },
      },
    ],
  }
}

export const createCiWatcher = (options: CiWatcherOptions): CiWatcher => {
  const logger = options.logger ?? noopLogger
  const intervalMs = options.intervalMs ?? CI_WATCH_INTERVAL_MS
  const maxDurationMs = options.maxDurationMs ?? CI_WATCH_MAX_DURATION_MS

  const safePatch = async (
    updater: MessageUpdater,
    rendered: RenderedMessage,
    taskName: string,
  ): Promise<void> => {
    try {
      await updater.patch(rendered)
    } catch (err) {
      logger.error(
        {
          event: 'blog_ci_watch_patch_failed',
          task: taskName,
          error: serializeError(err),
        },
        'CiWatcher failed to patch Slack message',
      )
    }
  }

  return {
    startWatching(input) {
      const taskName = `blog:ci-watch:${String(input.prNumber)}`
      try {
        options.scheduler.schedule({
          name: taskName,
          intervalMs,
          maxDurationMs,
          tick: async () => {
            const status: CiStatus = await options.client.getCiStatus(
              input.prNumber,
            )
            if (status.state === 'pending') {
              return { done: false }
            }
            const rendered =
              status.state === 'success'
                ? renderCiSuccessBlocks({
                    prNumber: input.prNumber,
                    prUrl: input.prUrl,
                    previewUrl: status.previewUrl,
                  })
                : renderCiFailureBlocks({
                    prNumber: input.prNumber,
                    prUrl: input.prUrl,
                    failedChecks: status.failedChecks,
                  })
            await safePatch(input.updater, rendered, taskName)
            return { done: true }
          },
          onTimeout: async () => {
            const rendered = renderCiTimeoutBlocks({
              prNumber: input.prNumber,
              prUrl: input.prUrl,
            })
            await safePatch(input.updater, rendered, taskName)
          },
          onError: (err) => {
            logger.warn(
              {
                event: 'blog_ci_watch_tick_error',
                task: taskName,
                prNumber: input.prNumber,
                error: serializeError(err),
              },
              'CiWatcher tick failed; continuing polling',
            )
            return Promise.resolve()
          },
        })
      } catch (err) {
        logger.warn(
          {
            event: 'blog_ci_watch_schedule_failed',
            task: taskName,
            prNumber: input.prNumber,
            error: serializeError(err),
          },
          'CiWatcher could not start scheduler task',
        )
      }
    },
  }
}

const serializeError = (err: unknown): Record<string, unknown> => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message }
  }
  return { value: String(err) }
}

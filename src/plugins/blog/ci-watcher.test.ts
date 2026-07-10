import type { CiStatus } from '@fohte/blog-publisher-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessageUpdater } from '@/interaction/message-updater'
import {
  CI_WATCH_INTERVAL_MS,
  CI_WATCH_MAX_DURATION_MS,
  createCiWatcher,
} from '@/plugins/blog/ci-watcher'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import { createScheduler } from '@/scheduler/scheduler'

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const makeUpdater = (): {
  updater: MessageUpdater
  patch: ReturnType<typeof vi.fn>
} => {
  const patch = vi.fn(async () => undefined)
  const del = vi.fn(async () => undefined)
  return { updater: { patch, delete: del }, patch }
}

const makeClientFromStatuses = (
  statuses: readonly CiStatus[],
): {
  client: BlogServiceClient
  getCiStatus: ReturnType<typeof vi.fn>
} => {
  const queue = [...statuses]
  const getCiStatus = vi.fn(async () => {
    if (queue.length === 0) throw new Error('no statuses left')
    if (queue.length === 1) return queue[0] as CiStatus
    return queue.shift() as CiStatus
  })
  const client = { getCiStatus } as unknown as BlogServiceClient
  return { client, getCiStatus }
}

const sectionBlock = (text: string): unknown => ({
  type: 'section',
  text: { type: 'mrkdwn', text },
})

describe('CiWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('polls every 30s and patches a success message with preview URL on success', async () => {
    const { updater, patch } = makeUpdater()
    const { client, getCiStatus } = makeClientFromStatuses([
      { state: 'pending', failedChecks: [] },
      {
        state: 'success',
        failedChecks: [],
        previewUrl: 'https://preview.example/x',
      },
    ])
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    const watcher = createCiWatcher({ scheduler, client })

    watcher.startWatching({
      prNumber: 42,
      prUrl: 'https://github.com/x/y/pull/42',
      updater,
    })

    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(getCiStatus).toHaveBeenCalledTimes(1)
    expect(patch).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(getCiStatus).toHaveBeenCalledTimes(2)
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenNthCalledWith(1, {
      text: ':white_check_mark: PR #42 CI 成功',
      blocks: [
        sectionBlock(
          ':white_check_mark: PR #42 の CI が成功しました\n' +
            '<https://github.com/x/y/pull/42|https://github.com/x/y/pull/42>\n' +
            'Preview: <https://preview.example/x|https://preview.example/x>',
        ),
      ],
    })
    expect(scheduler.listActive()).toHaveLength(0)
  })

  it('omits the preview line when previewUrl is missing on success', async () => {
    const { updater, patch } = makeUpdater()
    const { client } = makeClientFromStatuses([
      { state: 'success', failedChecks: [] },
    ])
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    const watcher = createCiWatcher({ scheduler, client })

    watcher.startWatching({
      prNumber: 3,
      prUrl: 'https://github.com/x/y/pull/3',
      updater,
    })

    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(patch).toHaveBeenNthCalledWith(1, {
      text: ':white_check_mark: PR #3 CI 成功',
      blocks: [
        sectionBlock(
          ':white_check_mark: PR #3 の CI が成功しました\n' +
            '<https://github.com/x/y/pull/3|https://github.com/x/y/pull/3>',
        ),
      ],
    })
  })

  it('patches a failure message with failed checks on failure', async () => {
    const { updater, patch } = makeUpdater()
    const { client } = makeClientFromStatuses([
      {
        state: 'failure',
        failedChecks: ['build', 'lint'],
      },
    ])
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    const watcher = createCiWatcher({ scheduler, client })

    watcher.startWatching({
      prNumber: 7,
      prUrl: 'https://github.com/x/y/pull/7',
      updater,
    })

    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(patch).toHaveBeenNthCalledWith(1, {
      text: ':x: PR #7 CI 失敗',
      blocks: [
        sectionBlock(
          ':x: PR #7 の CI が失敗しました\n' +
            '<https://github.com/x/y/pull/7|https://github.com/x/y/pull/7>\n' +
            'Failed checks: `build`, `lint`',
        ),
      ],
    })
    expect(scheduler.listActive()).toHaveLength(0)
  })

  it('renders "(詳細なし)" when failedChecks is empty on failure', async () => {
    const { updater, patch } = makeUpdater()
    const { client } = makeClientFromStatuses([
      { state: 'failure', failedChecks: [] },
    ])
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    const watcher = createCiWatcher({ scheduler, client })

    watcher.startWatching({
      prNumber: 8,
      prUrl: 'https://github.com/x/y/pull/8',
      updater,
    })

    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(patch).toHaveBeenNthCalledWith(1, {
      text: ':x: PR #8 CI 失敗',
      blocks: [
        sectionBlock(
          ':x: PR #8 の CI が失敗しました\n' +
            '<https://github.com/x/y/pull/8|https://github.com/x/y/pull/8>\n' +
            'Failed checks: (詳細なし)',
        ),
      ],
    })
  })

  it('patches a timeout message when 15 minutes elapse with no completion', async () => {
    const { updater, patch } = makeUpdater()
    let nowVal = 0
    const getCiStatus = vi.fn(async (): Promise<CiStatus> => ({
      state: 'pending',
      failedChecks: [],
    }))
    const client = { getCiStatus } as unknown as BlogServiceClient
    const scheduler = createScheduler({
      maxConcurrentTasks: 8,
      now: () => nowVal,
    })
    const watcher = createCiWatcher({ scheduler, client })

    watcher.startWatching({
      prNumber: 99,
      prUrl: 'https://github.com/x/y/pull/99',
      updater,
    })

    for (let i = 0; i < 5; i++) {
      nowVal += CI_WATCH_INTERVAL_MS
      await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
      await flush()
    }
    expect(patch).not.toHaveBeenCalled()
    expect(getCiStatus).toHaveBeenCalledTimes(5)

    nowVal = CI_WATCH_MAX_DURATION_MS + 1
    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(patch).toHaveBeenNthCalledWith(1, {
      text: ':hourglass: PR #99 CI 監視タイムアウト',
      blocks: [
        sectionBlock(
          ':hourglass: PR #99 の CI 監視が 15 分でタイムアウトしました\n' +
            '<https://github.com/x/y/pull/99|https://github.com/x/y/pull/99>\n' +
            '`/blog-status` で最新状況を確認してください。',
        ),
      ],
    })
    expect(scheduler.listActive()).toHaveLength(0)
  })

  it('escapes mrkdwn-special characters in URLs', async () => {
    const { updater, patch } = makeUpdater()
    const { client } = makeClientFromStatuses([
      {
        state: 'success',
        failedChecks: [],
        previewUrl: 'https://p.example/?a=1&b=<2>',
      },
    ])
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    const watcher = createCiWatcher({ scheduler, client })

    watcher.startWatching({
      prNumber: 5,
      prUrl: 'https://github.com/x/y/pull/5?c=<x>&d=1',
      updater,
    })

    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(patch).toHaveBeenNthCalledWith(1, {
      text: ':white_check_mark: PR #5 CI 成功',
      blocks: [
        sectionBlock(
          ':white_check_mark: PR #5 の CI が成功しました\n' +
            '<https://github.com/x/y/pull/5?c=&lt;x&gt;&amp;d=1|https://github.com/x/y/pull/5?c=&lt;x&gt;&amp;d=1>\n' +
            'Preview: <https://p.example/?a=1&amp;b=&lt;2&gt;|https://p.example/?a=1&amp;b=&lt;2&gt;>',
        ),
      ],
    })
  })

  it('continues polling when getCiStatus throws (onError logs only)', async () => {
    const { updater, patch } = makeUpdater()
    const getCiStatus = vi
      .fn<() => Promise<CiStatus>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ state: 'success', failedChecks: [] })
    const client = { getCiStatus } as unknown as BlogServiceClient
    const scheduler = createScheduler({ maxConcurrentTasks: 8 })
    const watcher = createCiWatcher({ scheduler, client })

    watcher.startWatching({
      prNumber: 1,
      prUrl: 'https://github.com/x/y/pull/1',
      updater,
    })

    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(patch).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(CI_WATCH_INTERVAL_MS)
    await flush()
    expect(getCiStatus).toHaveBeenCalledTimes(2)
    expect(patch).toHaveBeenCalledTimes(1)
  })
})

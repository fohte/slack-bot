import type { Plan } from '@fohte/blog-publisher-contract'

import { translateIssues } from '@/plugins/blog/error-translator'
import { ButtonValueOverflow } from '@/plugins/blog/errors'

export const BUTTON_VALUE_LIMIT = 2000

export interface RenderPlanOptions {
  readonly plan: Plan
}

export interface RenderPlanResult {
  readonly text: string
  readonly blocks: unknown[]
  readonly applyDisabled: boolean
  readonly applyHidden: boolean
  readonly buttonValue: string | undefined
}

export const encodeDocIds = (docIds: readonly string[]): string => {
  const value = JSON.stringify({ docIds: [...docIds] })
  if (value.length > BUTTON_VALUE_LIMIT) {
    throw new ButtonValueOverflow(value.length, BUTTON_VALUE_LIMIT)
  }
  return value
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const decodeDocIds = (value: string): string[] => {
  const json: unknown = JSON.parse(value)
  if (!isRecord(json)) {
    throw new Error('Invalid button value: not an object')
  }
  const docIds = json['docIds']
  if (!Array.isArray(docIds)) {
    throw new Error('Invalid button value: docIds missing')
  }
  if (!docIds.every((d): d is string => typeof d === 'string')) {
    throw new Error('Invalid button value: docIds must be strings')
  }
  return docIds
}

export const renderPlanBlocks = (
  options: RenderPlanOptions,
): RenderPlanResult => {
  const { plan } = options
  const docIds = plan.items.map((i) => i.docId)
  let buttonValue: string | undefined
  let applyHidden = false
  try {
    buttonValue = encodeDocIds(docIds)
  } catch (err) {
    if (err instanceof ButtonValueOverflow) {
      applyHidden = true
      buttonValue = undefined
    } else {
      throw err
    }
  }
  const applyDisabled = plan.errors.length > 0

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':memo: Publish Plan' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `signature: \`${plan.signature}\` · items: ${String(plan.items.length)} · warnings: ${String(plan.warnings.length)} · errors: ${String(plan.errors.length)}`,
        },
      ],
    },
    { type: 'divider' },
  ]

  if (plan.items.length > 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: formatItems(plan) },
    })
  }

  if (plan.errors.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:x: *エラー (Apply 不可)*\n${translateIssues(plan.errors)
          .map((s) => `- ${s}`)
          .join('\n')}`,
      },
    })
  }

  if (plan.warnings.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:warning: *警告*\n${translateIssues(plan.warnings)
          .map((s) => `- ${s}`)
          .join('\n')}`,
      },
    })
  }

  if (applyHidden) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':warning: 選択数が多すぎて Apply ボタンを表示できません。25 件以下に絞ってください。',
        },
      ],
    })
  }

  const actionElements: unknown[] = []
  if (!applyHidden && buttonValue !== undefined) {
    const applyButton: Record<string, unknown> = {
      type: 'button',
      style: 'primary',
      text: { type: 'plain_text', text: 'Apply' },
      action_id: 'blog:apply',
      value: buttonValue,
    }
    if (applyDisabled) applyButton['disabled'] = true
    actionElements.push(applyButton)
  }
  actionElements.push({
    type: 'button',
    style: 'danger',
    text: { type: 'plain_text', text: 'Cancel' },
    action_id: 'blog:cancel',
  })

  blocks.push({ type: 'actions', elements: actionElements })

  const text =
    plan.errors.length > 0
      ? ':x: Plan にエラーがあります'
      : `:memo: Plan (${String(plan.items.length)} items)`

  return { text, blocks, applyDisabled, applyHidden, buttonValue }
}

const formatItems = (plan: Plan): string =>
  plan.items
    .map((item) => {
      const icon =
        item.kind === 'added'
          ? ':new:'
          : item.kind === 'modified'
            ? ':pencil2:'
            : ':fast_forward:'
      const stat =
        item.diffStat !== undefined
          ? ` (+${String(item.diffStat.added)} / -${String(item.diffStat.removed)})`
          : ''
      const skip =
        item.skipReason !== undefined ? ` — skip: ${item.skipReason}` : ''
      return `${icon} *${item.title}* — \`${item.publishedFilename}\`${stat}${skip}`
    })
    .join('\n')

export interface RenderAppliedOptions {
  readonly prUrl: string
  readonly prNumber: number
  readonly branch?: string | undefined
}

export const renderAppliedBlocks = (
  options: RenderAppliedOptions,
): { text: string; blocks: unknown[] } => {
  const text = `:white_check_mark: PR を作成しました: ${options.prUrl}`
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:white_check_mark: PR #${String(options.prNumber)} を作成しました\n<${options.prUrl}|${options.prUrl}>`,
      },
    },
  ]
  if (options.branch !== undefined) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `branch: \`${options.branch}\`` }],
    })
  }
  return { text, blocks }
}

export const renderAlreadyAppliedBlocks = (options: {
  prUrl: string
  prNumber: number
}): { text: string; blocks: unknown[] } => ({
  text: `:information_source: 既に PR #${String(options.prNumber)} があります: ${options.prUrl}`,
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:information_source: 同じ docId 集合の PR が既に存在します: <${options.prUrl}|#${String(options.prNumber)}>`,
      },
    },
  ],
})

export const renderCancelledBlocks = (): {
  text: string
  blocks: unknown[]
} => ({
  text: ':wastebasket: 破棄しました',
  blocks: [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: ':wastebasket: Plan を破棄しました。' },
    },
  ],
})

export const renderApplyingBlocks = (): {
  text: string
  blocks: unknown[]
} => ({
  text: ':hourglass_flowing_sand: Applying...',
  blocks: [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':hourglass_flowing_sand: Apply 中です...',
      },
    },
  ],
})

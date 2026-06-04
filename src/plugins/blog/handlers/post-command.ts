import type { Note } from '@fohte/blog-publisher-contract'

import type { InteractionContext } from '@/interaction/context'
import type { BlogServiceClient } from '@/plugins/blog/service-client'
import type { SlashCommandBody } from '@/types/slack-payloads'

const SLACK_STATIC_SELECT_OPTION_LIMIT = 100

export interface HandlePostCommandInput {
  readonly ctx: InteractionContext
  readonly body: SlashCommandBody
  readonly client: BlogServiceClient
}

export const handlePostCommand = async (
  input: HandlePostCommandInput,
): Promise<void> => {
  const { ctx, client } = input
  ctx.ack()
  const notes = await client.listNotes()
  await ctx.followUp({
    response_type: 'ephemeral',
    text: buildHeaderText(notes),
    blocks: buildSelectBlocks(notes),
  })
}

const buildHeaderText = (notes: readonly Note[]): string => {
  if (notes.length === 0) {
    return '公開候補のノートが見つかりませんでした。'
  }
  return `公開候補 ${String(notes.length)} 件から選択してください。`
}

export const buildSelectBlocks = (notes: readonly Note[]): unknown[] => {
  if (notes.length === 0) {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':information_source: 公開候補のノートが見つかりませんでした。',
        },
      },
    ]
  }

  const truncated = notes.slice(0, SLACK_STATIC_SELECT_OPTION_LIMIT)
  const options = truncated.map((note) => ({
    text: {
      type: 'plain_text',
      text: truncate(`${kindLabel(note.kind)} ${note.title}`, 75),
    },
    description:
      note.description !== undefined && note.description.length > 0
        ? { type: 'plain_text', text: truncate(note.description, 75) }
        : undefined,
    value: note.docId,
  }))

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:memo: 公開するノートを選択してください (${String(notes.length)} 件)`,
      },
    },
    {
      type: 'actions',
      block_id: 'blog:select',
      elements: [
        {
          type: 'multi_static_select',
          action_id: 'blog:select-options',
          placeholder: { type: 'plain_text', text: 'ノートを選択' },
          options,
        },
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Submit' },
          action_id: 'blog:select-submit',
        },
      ],
    },
  ]

  if (notes.length > SLACK_STATIC_SELECT_OPTION_LIMIT) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:warning: 候補が ${String(notes.length)} 件あり、先頭 ${String(SLACK_STATIC_SELECT_OPTION_LIMIT)} 件のみ表示しています。`,
        },
      ],
    })
  }

  return blocks
}

const kindLabel = (kind: Note['kind']): string =>
  kind === 'new' ? '[NEW]' : '[UPD]'

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`

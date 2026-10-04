import { err } from 'neverthrow'
import { describe, expect, it, vi } from 'vitest'

import { createInteractionContext } from '#interaction/context'
import {
  lastBody,
  makeFailingSlack,
  makeSlack,
} from '#plugins/blog/_test-utils'
import { ServiceUnavailable } from '#plugins/blog/errors'
import type { Note } from '#plugins/blog/generated/blog-publisher-contract'
import { handlePostCommand } from '#plugins/blog/handlers/post-command'
import type { BlogServiceClient } from '#plugins/blog/service-client'
import { SlackApiError } from '#types/errors'

const note = (overrides: Partial<Note> = {}): Note => ({
  docId: 'note:1',
  path: 'p',
  title: 'T',
  kind: 'new',
  mtime: 0,
  ...overrides,
})

const runPostCommand = async (notes: readonly Note[]) => {
  const client = {
    listNotes: vi.fn(async () => notes),
  } as unknown as BlogServiceClient
  const slack = makeSlack()
  const result = createInteractionContext({
    source: {
      kind: 'slash_command',
      command: '/blog-post',
      body: { command: '/blog-post' },
    },
    slackClient: slack.client,
    responseUrl: 'https://hooks.example/x',
  })
  await handlePostCommand({
    ctx: result.ctx,
    body: { command: '/blog-post' },
    client,
  })
  return lastBody(slack.postToResponseUrl)
}

describe('PostCommandHandler', () => {
  it('builds Static Select with one option per note plus Submit button', async () => {
    expect(
      await runPostCommand([
        note({ docId: 'a', title: 'A' }),
        note({ docId: 'b', title: 'B', kind: 'update' }),
        note({ docId: 'c', title: 'C' }),
      ]),
    ).toEqual({
      response_type: 'ephemeral',
      text: '公開候補 3 件から選択してください。',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':memo: 公開するノートを選択してください (3 件)',
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
              options: [
                {
                  text: { type: 'plain_text', text: '[NEW] A' },
                  description: undefined,
                  value: 'a',
                },
                {
                  text: { type: 'plain_text', text: '[UPD] B' },
                  description: undefined,
                  value: 'b',
                },
                {
                  text: { type: 'plain_text', text: '[NEW] C' },
                  description: undefined,
                  value: 'c',
                },
              ],
            },
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Submit' },
              action_id: 'blog:select-submit',
            },
          ],
        },
      ],
    })
  })

  it('truncates to 100 options and adds a warning', async () => {
    const notes = Array.from({ length: 150 }, (_, i) =>
      note({ docId: `n${String(i)}`, title: `T${String(i)}` }),
    )
    const expectedOptions = notes.slice(0, 100).map((n) => ({
      text: {
        type: 'plain_text',
        text: `${n.kind === 'new' ? '[NEW]' : '[UPD]'} ${n.title}`,
      },
      description: undefined,
      value: n.docId,
    }))

    expect(await runPostCommand(notes)).toEqual({
      response_type: 'ephemeral',
      text: '公開候補 150 件から選択してください。',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':memo: 公開するノートを選択してください (150 件)',
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
              options: expectedOptions,
            },
            {
              type: 'button',
              style: 'primary',
              text: { type: 'plain_text', text: 'Submit' },
              action_id: 'blog:select-submit',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: ':warning: 候補が 150 件あり、先頭 100 件のみ表示しています。',
            },
          ],
        },
      ],
    })
  })

  it('shows empty-state when no notes', async () => {
    expect(await runPostCommand([])).toEqual({
      response_type: 'ephemeral',
      text: '公開候補のノートが見つかりませんでした。',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':information_source: 公開候補のノートが見つかりませんでした。',
          },
        },
      ],
    })
  })

  it('calls listNotes and posts ephemeral followUp', async () => {
    const listNotes = vi.fn(async () => [note()])
    const client = { listNotes } as unknown as BlogServiceClient
    const slack = makeSlack()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-post',
        body: { command: '/blog-post' },
      },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    await handlePostCommand({
      ctx: result.ctx,
      body: { command: '/blog-post' },
      client,
    })
    expect(listNotes).toHaveBeenCalled()
    const body = lastBody(slack.postToResponseUrl)
    expect(body.response_type).toBe('ephemeral')
  })

  it('propagates ServiceUnavailable when listNotes fails', async () => {
    const client: BlogServiceClient = {
      listNotes: vi.fn(async () => {
        throw new ServiceUnavailable('down')
      }),
    } as unknown as BlogServiceClient
    const slack = makeSlack()
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-post',
        body: { command: '/blog-post' },
      },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    const outcome = await handlePostCommand({
      ctx: result.ctx,
      body: { command: '/blog-post' },
      client,
    })
    expect(outcome).toEqual(err(new ServiceUnavailable('down')))
  })

  it('propagates the followUp Result error when response_url posting fails', async () => {
    const listNotes = vi.fn(async () => [note()])
    const client = { listNotes } as unknown as BlogServiceClient
    const slack = makeFailingSlack(
      new SlackApiError('response_url POST failed with HTTP 410', {
        status: 410,
      }),
    )
    const result = createInteractionContext({
      source: {
        kind: 'slash_command',
        command: '/blog-post',
        body: { command: '/blog-post' },
      },
      slackClient: slack.client,
      responseUrl: 'https://hooks.example/x',
    })
    const outcome = await handlePostCommand({
      ctx: result.ctx,
      body: { command: '/blog-post' },
      client,
    })
    expect(outcome).toEqual(
      err(
        new SlackApiError('response_url POST failed with HTTP 410', {
          status: 410,
        }),
      ),
    )
  })
})

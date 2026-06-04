import type { Note } from '@fohte/blog-publisher-contract'
import { describe, expect, it, vi } from 'vitest'

import { createInteractionContext } from '@/interaction/context'
import { lastBody, makeSlack } from '@/plugins/blog/_test-utils'
import { ServiceUnavailable } from '@/plugins/blog/errors'
import {
  buildSelectBlocks,
  handlePostCommand,
} from '@/plugins/blog/handlers/post-command'
import type { BlogServiceClient } from '@/plugins/blog/service-client'

const note = (overrides: Partial<Note> = {}): Note => ({
  docId: 'note:1',
  path: 'p',
  title: 'T',
  kind: 'new',
  mtime: 0,
  ...overrides,
})

describe('PostCommandHandler', () => {
  it('builds Static Select with one option per note plus Submit button', () => {
    const blocks = buildSelectBlocks([
      note({ docId: 'a', title: 'A' }),
      note({ docId: 'b', title: 'B', kind: 'update' }),
      note({ docId: 'c', title: 'C' }),
    ])
    const actions = blocks.find(
      (b) => (b as { type?: string }).type === 'actions',
    ) as { elements: unknown[] }
    expect(actions).toBeDefined()
    const select = actions.elements[0] as {
      type: string
      options: unknown[]
    }
    expect(select.type).toBe('multi_static_select')
    expect(select.options).toHaveLength(3)
    const submit = actions.elements[1] as { action_id: string }
    expect(submit.action_id).toBe('blog:select-submit')
  })

  it('truncates to 100 options and adds a warning', () => {
    const notes = Array.from({ length: 150 }, (_, i) =>
      note({ docId: `n${String(i)}`, title: `T${String(i)}` }),
    )
    const blocks = buildSelectBlocks(notes)
    const actions = blocks.find(
      (b) => (b as { type?: string }).type === 'actions',
    ) as { elements: unknown[] }
    const select = actions.elements[0] as { options: unknown[] }
    expect(select.options).toHaveLength(100)
    expect(JSON.stringify(blocks)).toContain('150')
  })

  it('shows empty-state when no notes', () => {
    const blocks = buildSelectBlocks([])
    expect(JSON.stringify(blocks)).toContain('見つかりませんでした')
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
    await expect(
      handlePostCommand({
        ctx: result.ctx,
        body: { command: '/blog-post' },
        client,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailable)
  })
})

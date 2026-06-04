import type { Plan } from '@fohte/blog-publisher-contract'
import { describe, expect, it } from 'vitest'

import { ButtonValueOverflow } from '@/plugins/blog/errors'
import {
  decodeDocIds,
  encodeDocIds,
  renderAlreadyAppliedBlocks,
  renderAppliedBlocks,
  renderCancelledBlocks,
  renderPlanBlocks,
} from '@/plugins/blog/plan-presenter'

const plan = (overrides: Partial<Plan> = {}): Plan => ({
  signature: 'abcd1234',
  items: [
    {
      docId: 'note:a',
      kind: 'added',
      slug: 'a',
      publishedFilename: '2026-01-01-a.mdx',
      title: 'Title A',
      summary: 'summary',
      diffStat: { added: 10, removed: 0 },
    },
  ],
  warnings: [],
  errors: [],
  imagesToUpload: [],
  ...overrides,
})

const findButton = (
  blocks: unknown[],
  actionId: string,
): Record<string, unknown> | undefined => {
  for (const block of blocks) {
    const b = block as { type?: string; elements?: unknown[] }
    if (b.type !== 'actions' || !Array.isArray(b.elements)) continue
    for (const el of b.elements) {
      const e = el as { action_id?: string }
      if (e.action_id === actionId) return e as Record<string, unknown>
    }
  }
  return undefined
}

describe('PlanPresenter', () => {
  it('renders Apply button with encoded docIds when no errors', () => {
    const res = renderPlanBlocks({ plan: plan() })
    expect(res.applyDisabled).toBe(false)
    expect(res.applyHidden).toBe(false)
    const apply = findButton(res.blocks, 'blog:apply')
    expect(apply).toBeDefined()
    expect(apply?.['disabled']).toBeUndefined()
    const decoded = decodeDocIds(apply?.['value'] as string)
    expect(decoded).toEqual(['note:a'])
  })

  it('marks Apply button disabled when errors > 0', () => {
    const res = renderPlanBlocks({
      plan: plan({
        errors: [
          { docId: 'note:a', code: 'FrontmatterInvalid', message: 'bad' },
        ],
      }),
    })
    expect(res.applyDisabled).toBe(true)
    const apply = findButton(res.blocks, 'blog:apply')
    expect(apply?.['disabled']).toBe(true)
  })

  it('hides Apply button when button value overflows', () => {
    const bigDocIds = Array.from(
      { length: 100 },
      (_, i) => `note:${'x'.repeat(40)}-${String(i)}`,
    )
    const res = renderPlanBlocks({
      plan: plan({
        items: bigDocIds.map((docId) => ({
          docId,
          kind: 'added',
          slug: docId,
          publishedFilename: `${docId}.mdx`,
          title: docId,
          summary: '',
        })),
      }),
    })
    expect(res.applyHidden).toBe(true)
    expect(findButton(res.blocks, 'blog:apply')).toBeUndefined()
    expect(findButton(res.blocks, 'blog:cancel')).toBeDefined()
  })

  it('encodeDocIds throws ButtonValueOverflow when exceeding 2000 chars', () => {
    const big = Array.from(
      { length: 100 },
      (_, i) => `note:${'x'.repeat(40)}-${String(i)}`,
    )
    expect(() => encodeDocIds(big)).toThrow(ButtonValueOverflow)
  })

  it('decodeDocIds rejects malformed input', () => {
    expect(() => decodeDocIds('{}')).toThrow()
    expect(() => decodeDocIds('{"docIds":[1]}')).toThrow()
  })

  it('renderAppliedBlocks contains PR URL', () => {
    const res = renderAppliedBlocks({
      prNumber: 42,
      prUrl: 'https://github.com/x/y/pull/42',
      branch: 'blog/abcd1234',
    })
    expect(res.text).toContain('42')
    expect(JSON.stringify(res.blocks)).toContain('github.com/x/y/pull/42')
  })

  it('renderAlreadyAppliedBlocks contains PR URL', () => {
    const res = renderAlreadyAppliedBlocks({
      prNumber: 7,
      prUrl: 'https://github.com/x/y/pull/7',
    })
    expect(res.text).toContain('7')
  })

  it('renderCancelledBlocks returns dismissal message', () => {
    const res = renderCancelledBlocks()
    expect(res.text).toContain('破棄')
  })
})

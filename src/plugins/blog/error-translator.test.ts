import { describe, expect, it } from 'vitest'

import {
  translateApplyFailure,
  translateException,
  translateIssues,
} from '#plugins/blog/error-translator'
import {
  ButtonValueOverflow,
  ServiceError,
  ServiceUnavailable,
} from '#plugins/blog/errors'

describe('ErrorTranslator', () => {
  it('translates known issue codes to Japanese', () => {
    expect(
      translateIssues([
        {
          docId: 'note:a',
          code: 'FrontmatterInvalid',
          message: 'title missing',
        },
      ]),
    ).toEqual([
      'note:a: title または date が不正です (YAML frontmatter を確認) (title missing)',
    ])
  })

  it('falls back when issue code is unknown', () => {
    expect(
      translateIssues([
        { docId: 'note:b', code: 'NoSuchCode', message: 'whatever' },
      ]),
    ).toEqual(['note:b: whatever'])
  })

  it('translates ApplyResult failed', () => {
    const text = translateApplyFailure({
      kind: 'failed',
      code: 'ImageUploadFailed',
      message: 'R2 down',
    })
    expect(text).toContain('画像')
    expect(text).toContain('R2 down')
  })

  it('translateException ServiceUnavailable', () => {
    expect(translateException(new ServiceUnavailable('x'))).toContain('Service')
  })

  it('translateException ServiceError 401', () => {
    const err = new ServiceError('unauth', {
      status: 401,
      code: 'Unauthorized',
    })
    expect(translateException(err)).toContain('認証')
  })

  it('translateException ServiceError 503', () => {
    const err = new ServiceError('down', { status: 503, code: 'Unavailable' })
    expect(translateException(err)).toContain('一時的')
  })

  it('translateException ButtonValueOverflow', () => {
    expect(translateException(new ButtonValueOverflow(2500, 2000))).toContain(
      '選択数',
    )
  })
})

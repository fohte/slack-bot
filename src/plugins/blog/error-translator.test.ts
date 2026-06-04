import { describe, expect, it } from 'vitest'

import {
  translateApplyFailure,
  translateException,
  translateIssue,
} from '@/plugins/blog/error-translator'
import {
  ButtonValueOverflow,
  ServiceError,
  ServiceUnavailable,
} from '@/plugins/blog/errors'

describe('ErrorTranslator', () => {
  it('translates known issue codes to Japanese', () => {
    const text = translateIssue({
      docId: 'note:a',
      code: 'FrontmatterInvalid',
      message: 'title missing',
    })
    expect(text).toContain('note:a')
    expect(text).toContain('frontmatter')
  })

  it('falls back when issue code is unknown', () => {
    const text = translateIssue({
      docId: 'note:b',
      code: 'NoSuchCode',
      message: 'whatever',
    })
    expect(text).toContain('whatever')
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

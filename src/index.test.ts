import { describe, expect, it } from 'vitest'

import { greet } from '@/index'

describe('greet', () => {
  it('should return greeting message', () => {
    expect(greet('World')).toBe('Hello, World!')
  })

  it('should handle empty string', () => {
    expect(greet('')).toBe('Hello, !')
  })
})

import { describe, expect, it } from 'vitest'

import { isOtelConfigured } from '@/observability/otel'

describe('isOtelConfigured', () => {
  it('returns true when the endpoint is set', () => {
    expect(
      isOtelConfigured({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example/',
      }),
    ).toBe(true)
  })

  it('returns false when the endpoint is missing', () => {
    expect(isOtelConfigured({})).toBe(false)
  })

  it('returns false when the endpoint is blank', () => {
    expect(isOtelConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: '   ' })).toBe(false)
  })

  it('ignores OTEL_EXPORTER_OTLP_HEADERS when deciding configuration', () => {
    expect(
      isOtelConfigured({
        OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic abc',
      }),
    ).toBe(false)
  })
})

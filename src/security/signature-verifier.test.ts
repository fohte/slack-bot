import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createSignatureVerifier } from '@/security/signature-verifier'

const SECRET = 'shared-signing-secret'
const FIXED_NOW = 1_700_000_000

const sign = (timestamp: string, body: string, secret = SECRET): string => {
  const digest = createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')
  return `v0=${digest}`
}

describe('SignatureVerifier', () => {
  const verifier = createSignatureVerifier({
    signingSecret: SECRET,
    now: () => FIXED_NOW,
  })

  it('verifies a correctly signed request', () => {
    const ts = String(FIXED_NOW)
    const body = 'token=abc&command=%2Fping'
    expect(verifier.verify(body, sign(ts, body), ts)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const ts = String(FIXED_NOW)
    const body = 'token=abc&command=%2Fping'
    const tampered = 'token=abc&command=%2Fevil'
    expect(verifier.verify(tampered, sign(ts, body), ts)).toBe(false)
  })

  it('rejects when signed with a different secret', () => {
    const ts = String(FIXED_NOW)
    const body = 'token=abc'
    expect(verifier.verify(body, sign(ts, body, 'different-secret'), ts)).toBe(
      false,
    )
  })

  it('rejects when timestamp is outside the 5-minute window', () => {
    const stale = String(FIXED_NOW - 5 * 60 - 1)
    const body = 'token=abc'
    expect(verifier.verify(body, sign(stale, body), stale)).toBe(false)
  })

  it('rejects empty signature header', () => {
    const ts = String(FIXED_NOW)
    expect(verifier.verify('body', '', ts)).toBe(false)
  })

  it('rejects missing v0 prefix', () => {
    const ts = String(FIXED_NOW)
    const body = 'body'
    const digest = createHmac('sha256', SECRET)
      .update(`v0:${ts}:${body}`)
      .digest('hex')
    expect(verifier.verify(body, digest, ts)).toBe(false)
  })

  it('rejects non-numeric timestamp', () => {
    expect(verifier.verify('body', sign('123', 'body'), 'not-a-number')).toBe(
      false,
    )
  })

  it('rejects empty body when signature was generated for non-empty body', () => {
    const ts = String(FIXED_NOW)
    const body = 'real'
    expect(verifier.verify('', sign(ts, body), ts)).toBe(false)
  })
})

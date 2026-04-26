import { createHmac, timingSafeEqual } from 'node:crypto'

const VERSION = 'v0'
const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60

export interface SignatureVerifierOptions {
  readonly signingSecret: string
  readonly now?: (() => number) | undefined
}

export interface SignatureVerifier {
  verify(rawBody: string, signature: string, timestamp: string): boolean
}

export const createSignatureVerifier = (
  options: SignatureVerifierOptions,
): SignatureVerifier => {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    verify(rawBody, signature, timestamp) {
      if (!timestamp || !signature) return false
      const ts = Number.parseInt(timestamp, 10)
      if (!Number.isFinite(ts)) return false
      if (Math.abs(now() - ts) > MAX_TIMESTAMP_SKEW_SECONDS) return false

      if (!signature.startsWith(`${VERSION}=`)) return false
      const provided = signature.slice(VERSION.length + 1)

      const baseString = `${VERSION}:${timestamp}:${rawBody}`
      const expected = createHmac('sha256', options.signingSecret)
        .update(baseString)
        .digest('hex')

      const providedBuffer = Buffer.from(provided, 'utf8')
      const expectedBuffer = Buffer.from(expected, 'utf8')
      if (providedBuffer.length !== expectedBuffer.length) return false
      return timingSafeEqual(providedBuffer, expectedBuffer)
    },
  }
}

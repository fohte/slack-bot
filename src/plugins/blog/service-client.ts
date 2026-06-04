import {
  ApplyResult,
  BlogPrSummary,
  CiStatus,
  Note,
  Plan,
  type PlanIssue,
} from '@fohte/blog-publisher-contract'
import { z } from 'zod'

import { ServiceError, ServiceUnavailable } from '@/plugins/blog/errors'

const ErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z
      .array(
        z.object({
          docId: z.string(),
          code: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  }),
})

export interface BlogServiceClient {
  listNotes(traceId?: string): Promise<Note[]>
  buildPlan(docIds: readonly string[], traceId?: string): Promise<Plan>
  apply(docIds: readonly string[], traceId?: string): Promise<ApplyResult>
  listPrs(
    state: 'open' | 'closed' | 'all',
    traceId?: string,
  ): Promise<BlogPrSummary[]>
  cancelPr(prNumber: number, traceId?: string): Promise<void>
  getCiStatus(prNumber: number, traceId?: string): Promise<CiStatus>
}

export interface BlogServiceClientOptions {
  readonly baseUrl: string
  readonly bearerToken: string
  readonly fetchImpl?: typeof fetch | undefined
}

export const createBlogServiceClient = (
  options: BlogServiceClientOptions,
): BlogServiceClient => {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  const request = async <T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body: unknown,
    traceId: string | undefined,
  ): Promise<T> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.bearerToken}`,
      accept: 'application/json',
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (traceId !== undefined) headers['x-trace-id'] = traceId

    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)
    let response: Response
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init)
    } catch (err) {
      throw new ServiceUnavailable(
        `Failed to reach blog-publisher service: ${describeError(err)}`,
        { cause: err, traceId },
      )
    }

    if (!response.ok) {
      const text = await safeReadText(response)
      const parsed = parseErrorBody(text)
      throw new ServiceError(parsed.message, {
        status: response.status,
        code: parsed.code,
        issues: parsed.issues,
        traceId,
      })
    }

    const text = await safeReadText(response)
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (err) {
      throw new ServiceError(
        `Response body is not valid JSON: ${describeError(err)}`,
        { status: response.status, code: 'InvalidResponseBody', traceId },
      )
    }
    const parsedResult = schema.safeParse(json)
    if (!parsedResult.success) {
      throw new ServiceError(
        `Response body did not match schema: ${parsedResult.error.message}`,
        { status: response.status, code: 'InvalidResponseSchema', traceId },
      )
    }
    return parsedResult.data
  }

  return {
    listNotes: (traceId) =>
      request('GET', '/notes', z.array(Note), undefined, traceId),
    buildPlan: (docIds, traceId) =>
      request('POST', '/plan', Plan, { docIds }, traceId),
    apply: (docIds, traceId) =>
      request('POST', '/apply', ApplyResult, { docIds }, traceId),
    listPrs: (state, traceId) =>
      request(
        'GET',
        `/prs?state=${encodeURIComponent(state)}`,
        z.array(BlogPrSummary),
        undefined,
        traceId,
      ),
    cancelPr: async (prNumber, traceId) => {
      await request(
        'POST',
        `/prs/${String(prNumber)}/cancel`,
        z.object({ closed: z.literal(true) }),
        undefined,
        traceId,
      )
    },
    getCiStatus: (prNumber, traceId) =>
      request(
        'GET',
        `/prs/${String(prNumber)}/ci`,
        CiStatus,
        undefined,
        traceId,
      ),
  }
}

interface ParsedError {
  readonly code: string
  readonly message: string
  readonly issues: readonly PlanIssue[] | undefined
}

const parseErrorBody = (text: string): ParsedError => {
  if (text.length === 0) {
    return { code: 'UnknownError', message: 'Empty error body', issues: undefined }
  }
  try {
    const json: unknown = JSON.parse(text)
    const parsed = ErrorBody.safeParse(json)
    if (parsed.success) {
      return {
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        issues: parsed.data.error.issues,
      }
    }
  } catch {
    // fall through
  }
  return {
    code: 'UnknownError',
    message: text.length > 200 ? `${text.slice(0, 200)}...` : text,
    issues: undefined,
  }
}

const safeReadText = async (response: Response): Promise<string> => {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

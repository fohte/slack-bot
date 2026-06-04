import type { ApplyResult, PlanIssue } from '@fohte/blog-publisher-contract'

import {
  ButtonValueOverflow,
  ServiceError,
  ServiceUnavailable,
} from '@/plugins/blog/errors'

const ISSUE_MESSAGES: Record<string, string> = {
  FrontmatterInvalid: 'title または date が不正です (YAML frontmatter を確認)',
  SlugRequired: '非 ASCII タイトルには frontmatter の slug を追加してください',
  WikiLinkUnresolved: 'wikilink が解決できません',
  UnsupportedSyntax: '未対応の記法が含まれています',
  PublishedFileMissing:
    'publishedFilename で指定されたファイルが fohte.net に存在しません',
  ImageNotFound: '参照画像が vault に見つかりません',
  ButtonValueOverflow: '選択数が多すぎます。25 件以下に絞ってください',
  MissingDescription: 'description が未設定です',
  NoChanges: '既存と同一の内容のためスキップしました',
}

export const translateIssue = (issue: PlanIssue): string => {
  const base = ISSUE_MESSAGES[issue.code]
  const detail = issue.message
  if (base === undefined) {
    return `${issue.docId}: ${detail}`
  }
  if (detail.length > 0 && detail !== base) {
    return `${issue.docId}: ${base} (${detail})`
  }
  return `${issue.docId}: ${base}`
}

export const translateIssues = (issues: readonly PlanIssue[]): string[] =>
  issues.map(translateIssue)

export const translateApplyFailure = (
  result: Extract<ApplyResult, { kind: 'failed' }>,
): string => {
  const codeMessages: Record<string, string> = {
    ImageUploadFailed:
      '画像 upload に失敗しました。少し待ってから再実行してください。',
    GitHubApiError:
      'GitHub API でエラーが発生しました。設定または rate limit を確認してください。',
    GitHubBranchConflict:
      'GitHub ブランチが競合しました。既存 PR を確認してください。',
    NoteDecryptFailed:
      'ノートの復号に失敗しました。Service の Secret 設定を確認してください。',
  }
  const base = codeMessages[result.code]
  if (base === undefined) {
    return `Apply に失敗しました (${result.code}): ${result.message}`
  }
  return `${base} (${result.message})`
}

export const translateServiceError = (err: ServiceError): string => {
  switch (err.status) {
    case 400:
      return 'リクエストが不正です。bot のログを確認してください。'
    case 401:
      return '認証エラー (bearer token 不一致)。設定を確認してください。'
    case 404:
      return '対象が見つかりません。'
    case 503:
      return 'Service が一時的に利用できません。少し待ってから再実行してください。'
    default:
      if (err.status >= 500) {
        return `Service でエラーが発生しました (${err.code})。少し待ってから再実行してください。`
      }
      return `Service エラー (${err.code}): ${err.message}`
  }
}

export const translateException = (err: unknown): string => {
  if (err instanceof ServiceUnavailable) {
    return 'Service に接続できません。ネットワークまたは Service の稼働状況を確認してください。'
  }
  if (err instanceof ServiceError) {
    return translateServiceError(err)
  }
  if (err instanceof ButtonValueOverflow) {
    return ISSUE_MESSAGES['ButtonValueOverflow'] ?? '選択数が多すぎます。'
  }
  if (err instanceof Error) {
    return `予期しないエラーが発生しました: ${err.message}`
  }
  return '予期しないエラーが発生しました。'
}

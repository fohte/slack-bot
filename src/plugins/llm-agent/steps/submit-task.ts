import type { ConfigMapBinaryEntry } from '@/plugins/llm-agent/configmap-client'
import type {
  ProcessMentionDeps,
  ResolvedDeps,
  SlackEnvelope,
} from '@/plugins/llm-agent/process-mention-deps'
import { resolveDeps } from '@/plugins/llm-agent/process-mention-deps'
import type { TaskCrContext } from '@/plugins/llm-agent/task-cr-client'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'
import type { SlackFile } from '@/types/slack-payloads'

export const SLACK_IMAGES_MOUNT_PATH = 'slack-images'
// ConfigMap binaryData is stored base64-encoded inside the etcd object, which
// inflates by 4/3. A single ConfigMap object is capped at ~1 MiB, so the raw
// bytes that fit are ~768 KiB minus a margin for metadata, labels, and key
// names. Caps below are on the raw bytes before encoding.
const SINGLE_IMAGE_BYTE_CAP = 500 * 1024
const TOTAL_IMAGE_BYTE_CAP = 700 * 1024

const buildContexts = (
  env: SlackEnvelope,
  opencodeSessionId: string | undefined,
  imageConfigMapName: string | undefined,
): TaskCrContext[] => {
  const contexts: TaskCrContext[] = [
    {
      kind: 'text',
      name: 'slack-channel',
      mountPath: 'slack-context/channel',
      text: env.channelId,
    },
    {
      kind: 'text',
      name: 'slack-thread-ts',
      mountPath: 'slack-context/thread-ts',
      text: env.threadRootTs,
    },
  ]
  if (opencodeSessionId !== undefined) {
    contexts.push({
      kind: 'text',
      name: 'opencode-session-id',
      mountPath: 'slack-context/session-id',
      text: opencodeSessionId,
    })
  }
  if (imageConfigMapName !== undefined) {
    contexts.push({
      kind: 'configMap',
      name: 'slack-images',
      mountPath: SLACK_IMAGES_MOUNT_PATH,
      configMapName: imageConfigMapName,
    })
  }
  return contexts
}

const MIME_TO_EXT: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
])

const extForImage = (file: SlackFile): string => {
  const mime = typeof file.mimetype === 'string' ? file.mimetype : ''
  const fromMime = MIME_TO_EXT.get(mime)
  if (fromMime !== undefined) return fromMime
  const name = file.name ?? file.title ?? ''
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) {
    return name.slice(dot + 1).toLowerCase()
  }
  return 'bin'
}

// ConfigMap binaryData keys must be DNS-subdomain-ish: lowercase alnum, dot,
// hyphen. The numeric index prefix guarantees uniqueness even if two files
// share the same id, which Slack does not formally promise.
const configMapKeyFor = (file: SlackFile, index: number): string => {
  const idPart =
    typeof file.id === 'string' && file.id.length > 0
      ? file.id.toLowerCase().replace(/[^a-z0-9.-]/g, '-')
      : `image`
  const prefix = String(index + 1).padStart(2, '0')
  return `${prefix}-${idPart}.${extForImage(file)}`
}

const configMapNameForSlackEvent = (taskName: string): string =>
  `${taskName}-images`

interface DownloadedImage {
  readonly file: SlackFile
  readonly key: string
  readonly bytes: Uint8Array
}

const downloadImages = async (
  resolved: ResolvedDeps,
  env: SlackEnvelope,
): Promise<readonly DownloadedImage[]> => {
  const downloaded: DownloadedImage[] = []
  let totalBytes = 0
  // Serial download: downloadFile does not retry, so issuing all images in
  // parallel would 429 the whole batch on a single rate-limit hit.
  for (let index = 0; index < env.images.length; index++) {
    const file = env.images[index]
    if (file === undefined) continue
    const url = file.url_private_download ?? file.url_private
    if (typeof url !== 'string' || url.length === 0) continue
    let bytes: Uint8Array
    try {
      const result = await resolved.slackClient.downloadFile(url)
      bytes = result.bytes
    } catch (err) {
      resolved.logger.warn(
        {
          event: 'llm_agent_slack_image_download_failed',
          event_id: env.eventId,
          slack_file_id: file.id,
          err,
        },
        'slack image download failed; dropping this attachment',
      )
      continue
    }
    if (bytes.byteLength > SINGLE_IMAGE_BYTE_CAP) {
      resolved.logger.warn(
        {
          event: 'llm_agent_slack_image_too_large',
          event_id: env.eventId,
          slack_file_id: file.id,
          bytes: bytes.byteLength,
          cap: SINGLE_IMAGE_BYTE_CAP,
        },
        'slack image exceeds per-image cap; dropping this attachment',
      )
      continue
    }
    if (totalBytes + bytes.byteLength > TOTAL_IMAGE_BYTE_CAP) {
      resolved.logger.warn(
        {
          event: 'llm_agent_slack_image_total_cap_reached',
          event_id: env.eventId,
          slack_file_id: file.id,
          total_bytes: totalBytes,
          cap: TOTAL_IMAGE_BYTE_CAP,
        },
        'slack image would push ConfigMap over total cap; dropping this and any later attachments',
      )
      break
    }
    totalBytes += bytes.byteLength
    downloaded.push({
      file,
      key: configMapKeyFor(file, index),
      bytes,
    })
  }
  return downloaded
}

const ensureImageConfigMap = async (
  resolved: ResolvedDeps,
  env: SlackEnvelope,
  configMapName: string,
  downloaded: readonly DownloadedImage[],
): Promise<void> => {
  const entries: ConfigMapBinaryEntry[] = downloaded.map((d) => ({
    filename: d.key,
    bytes: d.bytes,
  }))
  await resolved.configMapClient.create({
    name: configMapName,
    namespace: resolved.namespace,
    binaryEntries: entries,
    labels: {
      'slack-bot.fohte.net/slack-event-id': env.eventId,
    },
  })
}

const describeImagesForAgent = (
  downloaded: readonly DownloadedImage[],
): string => {
  const lines = downloaded.map((d) => {
    const displayName = d.file.name ?? d.file.title ?? d.key
    return `- ${SLACK_IMAGES_MOUNT_PATH}/${d.key} (originally "${displayName}")`
  })
  return [
    `The user attached ${String(downloaded.length)} image file(s) to this Slack message.`,
    `They are mounted in the workspace at \`${SLACK_IMAGES_MOUNT_PATH}/\`. Call the Read tool on each path below to view the image:`,
    ...lines,
  ].join('\n')
}

const composeDescription = (
  envText: string,
  attachedCount: number,
  downloaded: readonly DownloadedImage[],
): string => {
  const dropped = attachedCount - downloaded.length
  const blocks: string[] = []
  if (downloaded.length > 0) blocks.push(describeImagesForAgent(downloaded))
  if (dropped > 0) {
    blocks.push(
      `Note: ${String(dropped)} attached image(s) could not be loaded (download failed or exceeded the workspace size budget) and are not available. Tell the user you couldn't read those images.`,
    )
  }
  if (envText.length > 0) blocks.push(envText)
  return blocks.join('\n\n')
}

const lookupResumeSessionId = async (
  resolved: ResolvedDeps,
  env: SlackEnvelope,
): Promise<string | undefined> => {
  // lookup failure falls through to undefined so the Task starts a fresh
  // opencode session instead of aborting dispatch.
  try {
    return await resolved.threadSessionStore.lookup({
      slackTeamId: env.teamId,
      slackChannelId: env.channelId,
      threadRootTs: env.threadRootTs,
    })
  } catch (error) {
    resolved.logger.error(
      {
        event: 'llm_agent_dispatch_thread_session_lookup_failed',
        event_id: env.eventId,
        err: error,
      },
      'failed to look up opencode session during dispatch; proceeding without resume',
    )
    return undefined
  }
}

export interface SubmitTaskResult {
  readonly taskName: string
}

// Synchronously create the Task CR for this Slack mention and record its
// name on the matching event_log row. Run from the dispatcher's
// foreground so a create() failure propagates up to the plugin layer for
// event_log rollback; everything after this step runs in the background.
export const submitTask = async (
  env: SlackEnvelope,
  deps: ProcessMentionDeps,
): Promise<SubmitTaskResult> => {
  const resolved = resolveDeps(deps)
  const taskName = taskCrNameForSlackEvent(env.eventId)
  const opencodeSessionId = await lookupResumeSessionId(resolved, env)
  const downloaded =
    env.images.length > 0 ? await downloadImages(resolved, env) : []
  let imageConfigMapName: string | undefined
  if (downloaded.length > 0) {
    imageConfigMapName = configMapNameForSlackEvent(taskName)
    await ensureImageConfigMap(resolved, env, imageConfigMapName, downloaded)
  }
  const outcome = await resolved.taskCrClient.create({
    name: taskName,
    namespace: resolved.namespace,
    agentName: resolved.agentName,
    description: composeDescription(env.text, env.images.length, downloaded),
    contexts: buildContexts(env, opencodeSessionId, imageConfigMapName),
  })
  const { updated } = await resolved.eventLogStore.markTaskName(
    env.eventId,
    taskName,
  )
  if (updated === 0) {
    resolved.logger.warn(
      {
        event: 'llm_agent_event_log_task_name_orphan',
        event_id: env.eventId,
        task_name: taskName,
      },
      'event_log row missing when recording task_name',
    )
  }
  resolved.logger.info(
    {
      event: 'llm_agent_task_dispatched',
      event_id: env.eventId,
      task_name: taskName,
      namespace: resolved.namespace,
      outcome,
      session_resumed: opencodeSessionId !== undefined,
      image_count: downloaded.length,
      attached_images: env.images.length,
    },
    outcome === 'created'
      ? 'llm-agent dispatched Task CR'
      : 'llm-agent Task CR already existed; treated as accepted',
  )
  return { taskName }
}

import { describe, expect, it } from 'vitest'

import {
  createScriptedEventLogStore,
  createScriptedTaskCrClient,
  createScriptedThreadSessionStore,
  createStubSlackClient,
  fixedOpencodeClient,
  noopConfigMapClient,
  TEST_ENV,
} from '@/plugins/llm-agent/_test-utils'
import type {
  ConfigMapClient,
  ConfigMapSpec,
} from '@/plugins/llm-agent/configmap-client'
import type { ProcessMentionDeps } from '@/plugins/llm-agent/process-mention'
import { submitTask } from '@/plugins/llm-agent/process-mention'
import { taskCrNameForSlackEvent } from '@/plugins/llm-agent/task-cr-client'
import type { SlackWebClient } from '@/slack/web-client'
import type { SlackFile } from '@/types/slack-payloads'

interface RecordingConfigMapClient extends ConfigMapClient {
  readonly creates: readonly ConfigMapSpec[]
}

const createRecordingConfigMapClient = (): RecordingConfigMapClient => {
  const creates: ConfigMapSpec[] = []
  return {
    creates,
    async create(spec) {
      creates.push(spec)
      return 'created'
    },
  }
}

const createSlackClientWithDownloads = (
  bytesByUrl: ReadonlyMap<string, Uint8Array>,
): SlackWebClient =>
  ({
    ...createStubSlackClient(),
    async downloadFile(url: string) {
      const bytes = bytesByUrl.get(url)
      if (bytes === undefined) {
        throw new Error(`unexpected url: ${url}`)
      }
      return { bytes, contentType: 'image/png' }
    },
  }) as SlackWebClient

describe('submitTask', () => {
  it('creates a Task CR with the Slack envelope contexts and records the task_name', async () => {
    const taskCrClient = createScriptedTaskCrClient([])
    const eventLogStore = createScriptedEventLogStore()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      configMapClient: noopConfigMapClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore,
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient: createStubSlackClient(),
    }

    const result = await submitTask(TEST_ENV, deps)

    const expectedName = taskCrNameForSlackEvent(TEST_ENV.eventId)
    expect({
      result,
      creates: taskCrClient.creates,
      marked: eventLogStore.markedTaskNames,
    }).toEqual({
      result: { taskName: expectedName },
      creates: [
        {
          name: expectedName,
          namespace: 'kubeopencode',
          agentName: 'slack-bot',
          description: 'hello bot',
          contexts: [
            {
              kind: 'text',
              name: 'slack-channel',
              mountPath: 'slack-context/channel',
              text: 'C1',
            },
            {
              kind: 'text',
              name: 'slack-thread-ts',
              mountPath: 'slack-context/thread-ts',
              text: '111.222',
            },
          ],
        },
      ],
      marked: [{ id: 'Ev1', name: expectedName }],
    })
  })

  it('attaches the opencode session id when a thread is already mapped', async () => {
    const taskCrClient = createScriptedTaskCrClient([])
    const eventLogStore = createScriptedEventLogStore()
    const deps: ProcessMentionDeps = {
      taskCrClient,
      configMapClient: noopConfigMapClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore,
      threadSessionStore: createScriptedThreadSessionStore({
        lookup: () => 'ses_abc',
      }),
      slackClient: createStubSlackClient(),
    }

    const result = await submitTask(TEST_ENV, deps)

    const expectedName = taskCrNameForSlackEvent(TEST_ENV.eventId)
    expect({
      result,
      creates: taskCrClient.creates,
      marked: eventLogStore.markedTaskNames,
    }).toEqual({
      result: { taskName: expectedName },
      creates: [
        {
          name: expectedName,
          namespace: 'kubeopencode',
          agentName: 'slack-bot',
          description: 'hello bot',
          contexts: [
            {
              kind: 'text',
              name: 'slack-channel',
              mountPath: 'slack-context/channel',
              text: 'C1',
            },
            {
              kind: 'text',
              name: 'slack-thread-ts',
              mountPath: 'slack-context/thread-ts',
              text: '111.222',
            },
            {
              kind: 'text',
              name: 'opencode-session-id',
              mountPath: 'slack-context/session-id',
              text: 'ses_abc',
            },
          ],
        },
      ],
      marked: [{ id: 'Ev1', name: expectedName }],
    })
  })

  it('downloads attached images, mounts them via a ConfigMap context, and prepends a Read-tool prompt block', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const slackClient = createSlackClientWithDownloads(
      new Map([
        ['https://files.slack.com/img-1.png', pngBytes],
        ['https://files.slack.com/img-2.jpg', jpgBytes],
      ]),
    )
    const taskCrClient = createScriptedTaskCrClient([])
    const eventLogStore = createScriptedEventLogStore()
    const configMapClient = createRecordingConfigMapClient()
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'screen.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/img-1.png',
      },
      {
        id: 'F2',
        name: 'photo.jpg',
        mimetype: 'image/jpeg',
        url_private: 'https://files.slack.com/img-2.jpg',
      },
    ]
    const deps: ProcessMentionDeps = {
      taskCrClient,
      configMapClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore,
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
    }

    const result = await submitTask(
      { ...TEST_ENV, text: 'look at these', images },
      deps,
    )

    const expectedTaskName = taskCrNameForSlackEvent(TEST_ENV.eventId)
    const expectedConfigMapName = `${expectedTaskName}-images`
    const expectedDescription = [
      'The user attached 2 image file(s) to this Slack message.',
      'They are mounted in the workspace at `slack-images/`. Call the Read tool on each path below to view the image:',
      '- slack-images/01-f1.png (originally "screen.png")',
      '- slack-images/02-f2.jpg (originally "photo.jpg")',
      '',
      'look at these',
    ].join('\n')
    expect({
      result,
      creates: taskCrClient.creates,
      configMaps: configMapClient.creates,
    }).toEqual({
      result: { taskName: expectedTaskName },
      creates: [
        {
          name: expectedTaskName,
          namespace: 'kubeopencode',
          agentName: 'slack-bot',
          description: expectedDescription,
          contexts: [
            {
              kind: 'text',
              name: 'slack-channel',
              mountPath: 'slack-context/channel',
              text: 'C1',
            },
            {
              kind: 'text',
              name: 'slack-thread-ts',
              mountPath: 'slack-context/thread-ts',
              text: '111.222',
            },
            {
              kind: 'configMap',
              name: 'slack-images',
              mountPath: 'slack-images',
              configMapName: expectedConfigMapName,
            },
          ],
        },
      ],
      configMaps: [
        {
          name: expectedConfigMapName,
          namespace: 'kubeopencode',
          binaryEntries: [
            { filename: '01-f1.png', bytes: pngBytes },
            { filename: '02-f2.jpg', bytes: jpgBytes },
          ],
          labels: {
            'slack-bot.fohte.net/slack-event-id': 'Ev1',
          },
        },
      ],
    })
  })

  it('drops images whose download fails and continues with the rest', async () => {
    const okBytes = new Uint8Array([1, 2, 3])
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async downloadFile(url: string) {
        if (url === 'https://files.slack.com/bad.png') {
          throw new Error('403')
        }
        return { bytes: okBytes, contentType: 'image/png' }
      },
    } as SlackWebClient
    const taskCrClient = createScriptedTaskCrClient([])
    const configMapClient = createRecordingConfigMapClient()
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'bad.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/bad.png',
      },
      {
        id: 'F2',
        name: 'good.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/good.png',
      },
    ]
    const deps: ProcessMentionDeps = {
      taskCrClient,
      configMapClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
    }

    await submitTask({ ...TEST_ENV, images }, deps)

    expect({
      configMaps: configMapClient.creates.map((c) => ({
        name: c.name,
        keys: c.binaryEntries.map((e) => e.filename),
      })),
      contextKinds: taskCrClient.creates[0]?.contexts.map((c) => c.kind),
    }).toEqual({
      configMaps: [
        {
          name: `${taskCrNameForSlackEvent('Ev1')}-images`,
          keys: ['02-f2.png'],
        },
      ],
      contextKinds: ['text', 'text', 'configMap'],
    })
  })

  it('skips the ConfigMap entirely when every image download fails', async () => {
    const slackClient: SlackWebClient = {
      ...createStubSlackClient(),
      async downloadFile() {
        throw new Error('boom')
      },
    } as SlackWebClient
    const taskCrClient = createScriptedTaskCrClient([])
    const configMapClient = createRecordingConfigMapClient()
    const images: readonly SlackFile[] = [
      {
        id: 'F1',
        name: 'a.png',
        mimetype: 'image/png',
        url_private: 'https://files.slack.com/a.png',
      },
    ]
    const deps: ProcessMentionDeps = {
      taskCrClient,
      configMapClient,
      opencodeClient: fixedOpencodeClient(),
      eventLogStore: createScriptedEventLogStore(),
      threadSessionStore: createScriptedThreadSessionStore(),
      slackClient,
    }

    await submitTask({ ...TEST_ENV, images }, deps)

    expect({
      configMaps: configMapClient.creates,
      contextKinds: taskCrClient.creates[0]?.contexts.map((c) => c.kind),
      description: taskCrClient.creates[0]?.description,
    }).toEqual({
      configMaps: [],
      contextKinds: ['text', 'text'],
      description:
        "Note: 1 attached image(s) could not be loaded (download failed or exceeded the workspace size budget) and are not available. Tell the user you couldn't read those images.\n\nhello bot",
    })
  })
})

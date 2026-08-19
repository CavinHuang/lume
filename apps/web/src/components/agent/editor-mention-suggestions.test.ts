import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { AGENT_IPC_CHANNELS } from '@lume/shared'

mock.restore()

const defaultSidecarCall = async (channel: string, _payload?: Record<string, unknown>) => {
  if (channel === AGENT_IPC_CHANNELS.LIST_INVOCABLE_CAPABILITIES) {
    return { capabilities: [
      { uri: 'lume-skill://global-writer', kind: 'skill', displayName: 'Global Writer', description: 'Write reusable drafts', source: 'filesystem', scope: 'user', version: '1.2.3', callable: true },
      { uri: 'lume-plugin://review', kind: 'plugin', displayName: 'Review Plugin', source: 'plugin', scope: 'global-plugin', callable: true },
    ], diagnostics: [] }
  }
  if (channel === AGENT_IPC_CHANNELS.GET_THREAD_PATH) {
    return '/tmp/thread-1'
  }
  if (channel === AGENT_IPC_CHANNELS.GET_MCP_CONFIG) {
    return { servers: {} }
  }
  throw new Error(`Unexpected sidecarCall: ${channel}`)
}

const sidecarCallMock = mock(defaultSidecarCall)

;(globalThis as any).__lumeDesktopApiMocks = {
  sidecarCall: sidecarCallMock,
  getMcpConfig: mock(async () => ({ servers: {} })),
  getMcpStatus: mock(async () => ({ servers: {} })),
}

function getDesktopApiMocks() {
  return (globalThis as any).__lumeDesktopApiMocks ?? {}
}

mock.module('@/lib/desktop-api', () => ({
  analyzeSkillImprovement: (...args: unknown[]) => getDesktopApiMocks().analyzeSkillImprovement?.(...args),
  applySkillImprovement: (...args: unknown[]) => getDesktopApiMocks().applySkillImprovement?.(...args),
  deleteWorkspaceSkill: (...args: unknown[]) => getDesktopApiMocks().deleteWorkspaceSkill?.(...args),
  getEditableSkill: (...args: unknown[]) => getDesktopApiMocks().getEditableSkill?.(...args),
  getMcpConfig: (...args: unknown[]) => getDesktopApiMocks().getMcpConfig?.(...args),
  getMcpStatus: (...args: unknown[]) => getDesktopApiMocks().getMcpStatus?.(...args),
  listSkillVersions: (...args: unknown[]) => getDesktopApiMocks().listSkillVersions?.(...args),
  restoreSkillVersion: (...args: unknown[]) => getDesktopApiMocks().restoreSkillVersion?.(...args),
  saveWorkspaceSkill: (...args: unknown[]) => getDesktopApiMocks().saveWorkspaceSkill?.(...args),
  sidecarCall: (...args: Parameters<typeof sidecarCallMock>) => getDesktopApiMocks().sidecarCall?.(...args),
}))

const { createSuggestionRenderer, fetchSuggestions } = await import('./editor-mention-suggestions')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitForSidecarCalls(count: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (sidecarCallMock.mock.calls.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`Expected ${count} sidecar calls`)
}

describe('fetchSuggestions', () => {
  beforeEach(() => {
    ;(globalThis as any).__lumeDesktopApiMocks = {
      sidecarCall: sidecarCallMock,
      getMcpConfig: mock(async () => ({ servers: {} })),
      getMcpStatus: mock(async () => ({ servers: {} })),
    }
    sidecarCallMock.mockClear()
    sidecarCallMock.mockImplementation(defaultSidecarCall)
  })

  test('does not expose the removed dollar trigger', async () => {
    const items = await fetchSuggestions('$', 'writer', 'thread-1', 'workspace-1')
    expect(items).toEqual([])
    expect(sidecarCallMock).not.toHaveBeenCalled()
  })

  test('uses the authoritative invocable catalog for slash suggestions', async () => {
    const items = await fetchSuggestions('/', 'writer', 'thread-1', 'workspace-1')

    expect(sidecarCallMock).toHaveBeenCalledWith(
      AGENT_IPC_CHANNELS.LIST_INVOCABLE_CAPABILITIES,
      { workspaceSlug: 'workspace-1', cwd: '/tmp/thread-1' },
    )
    expect(items).toEqual([
      expect.objectContaining({
        id: 'lume-skill://global-writer',
        label: 'Global Writer',
        uri: 'lume-skill://global-writer',
        subtitle: 'Write reusable drafts',
        meta: '用户全局 · 1.2.3',
      }),
    ])
  })

  test('keeps the newest suggestion results when requests resolve out of order', async () => {
    const firstResult = deferred<{ capabilities: Array<Record<string, unknown>>; diagnostics: [] }>()
    const secondResult = deferred<{ capabilities: Array<Record<string, unknown>>; diagnostics: [] }>()
    let catalogCallCount = 0
    sidecarCallMock.mockImplementation(async (channel: string) => {
      if (channel === AGENT_IPC_CHANNELS.GET_THREAD_PATH) return '/tmp/thread-1'
      if (channel === AGENT_IPC_CHANNELS.LIST_INVOCABLE_CAPABILITIES) {
        catalogCallCount++
        return catalogCallCount === 1 ? firstResult.promise : secondResult.promise
      }
      throw new Error(`Unexpected sidecarCall: ${channel}`)
    })

    const renderer = createSuggestionRenderer('/', 'thread-1', '/', () => 'workspace-1', () => {})
    const firstRequest = renderer.items({ query: 'global' })
    await waitForSidecarCalls(2)
    const secondRequest = renderer.items({ query: 'review' })
    await waitForSidecarCalls(4)

    secondResult.resolve({
      capabilities: [{ uri: 'lume-plugin://review', kind: 'plugin', displayName: 'Review Plugin', source: 'plugin', scope: 'global-plugin', callable: true }],
      diagnostics: [],
    })
    const latestItems = await secondRequest
    firstResult.resolve({
      capabilities: [{ uri: 'lume-skill://global-writer', kind: 'skill', displayName: 'Global Writer', source: 'filesystem', scope: 'user', callable: true }],
      diagnostics: [],
    })

    expect(await firstRequest).toEqual(latestItems)
    expect(latestItems).toEqual([expect.objectContaining({ id: 'lume-plugin://review' })])
  })
})

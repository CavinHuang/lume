import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { AGENT_IPC_CHANNELS } from '@lume/shared'

mock.restore()

const sidecarCallMock = mock(async (channel: string, _payload?: Record<string, unknown>) => {
  if (channel === AGENT_IPC_CHANNELS.GET_SKILLS) {
    return [
      {
        slug: 'workspace-review',
        name: 'Workspace Review',
        description: 'Review workspace code',
      },
    ]
  }
  if (channel === AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS) {
    return [
      {
        slug: 'global-writer',
        name: 'Global Writer',
        description: 'Write reusable drafts',
        whenToUse: 'When writing from any workspace',
        storageScope: 'user',
        version: '1.2.3',
      },
      {
        slug: 'workspace-review',
        name: 'Workspace Review',
        description: 'Review workspace code',
        storageScope: 'workspace',
      },
    ]
  }
  if (channel === AGENT_IPC_CHANNELS.GET_MCP_CONFIG) {
    return { servers: {} }
  }
  throw new Error(`Unexpected sidecarCall: ${channel}`)
})

;(globalThis as any).__lumeDesktopApiMocks = {
  sidecarCall: sidecarCallMock,
  getMcpConfig: mock(async () => ({ servers: {} })),
  getMcpStatus: mock(async () => ({ servers: {} })),
  listEditableSkills: async (workspaceSlug: string) =>
    sidecarCallMock(AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS, { workspaceSlug }),
}

function getDesktopApiMocks() {
  return (globalThis as any).__lumeDesktopApiMocks ?? {}
}

mock.module('@/lib/desktop-api', () => ({
  deleteWorkspaceSkill: (...args: unknown[]) => getDesktopApiMocks().deleteWorkspaceSkill?.(...args),
  getEditableSkill: (...args: unknown[]) => getDesktopApiMocks().getEditableSkill?.(...args),
  getMcpConfig: (...args: unknown[]) => getDesktopApiMocks().getMcpConfig?.(...args),
  getMcpStatus: (...args: unknown[]) => getDesktopApiMocks().getMcpStatus?.(...args),
  listEditableSkills: (...args: unknown[]) => getDesktopApiMocks().listEditableSkills?.(...args),
  saveWorkspaceSkill: (...args: unknown[]) => getDesktopApiMocks().saveWorkspaceSkill?.(...args),
  sidecarCall: (...args: Parameters<typeof sidecarCallMock>) => getDesktopApiMocks().sidecarCall?.(...args),
}))

const { fetchSuggestions } = await import('./editor-mention-suggestions')

describe('fetchSuggestions', () => {
  beforeEach(() => {
    ;(globalThis as any).__lumeDesktopApiMocks = {
      sidecarCall: sidecarCallMock,
      getMcpConfig: mock(async () => ({ servers: {} })),
      getMcpStatus: mock(async () => ({ servers: {} })),
      listEditableSkills: async (workspaceSlug: string) =>
        sidecarCallMock(AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS, { workspaceSlug }),
    }
    sidecarCallMock.mockClear()
  })

  test('uses editable skills for dollar skill suggestions', async () => {
    const items = await fetchSuggestions('$', 'writer', 'thread-1', 'workspace-1')

    expect(sidecarCallMock).toHaveBeenCalledWith(
      AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS,
      { workspaceSlug: 'workspace-1' },
    )
    expect(items).toEqual([
      expect.objectContaining({
        id: 'global-writer',
        label: 'global-writer',
        title: '$global-writer',
        subtitle: 'Write reusable drafts',
        meta: '用户全局 · 1.2.3',
      }),
    ])
  })

  test('uses editable skills for slash manual skill suggestions', async () => {
    const items = await fetchSuggestions('/', 'any workspace', 'thread-1', 'workspace-1')

    expect(sidecarCallMock).toHaveBeenCalledWith(
      AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS,
      { workspaceSlug: 'workspace-1' },
    )
    expect(items).toEqual([
      expect.objectContaining({
        id: 'global-writer',
        label: 'global-writer',
        title: '/global-writer',
        subtitle: 'Write reusable drafts',
        meta: '用户全局 · 1.2.3',
      }),
    ])
  })
})

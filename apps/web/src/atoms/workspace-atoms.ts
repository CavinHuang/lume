import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentWorkspace } from '@lume/shared'

export const agentWorkspacesAtom = atom<AgentWorkspace[]>([])
export const currentWorkspaceIdAtom = atomWithStorage<string | null>('current-workspace-id', null)

/** 置顶的工作区 ID 列表（localStorage 持久化） */
export const workspacePinnedIdsAtom = atomWithStorage<string[]>('workspace-pinned-ids', [])

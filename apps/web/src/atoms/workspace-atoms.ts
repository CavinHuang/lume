import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import type { AgentWorkspace, WorkspaceCapabilities } from '@lume/shared'

export const agentWorkspacesAtom = atom<AgentWorkspace[]>([])
export const currentWorkspaceIdAtom = atomWithStorage<string | null>('current-workspace-id', null)

/** 工作区能力缓存：按 workspaceSlug 索引（MCP 服务器 + Skill 摘要） */
export const agentWorkspaceCapabilitiesAtom = atom<Record<string, WorkspaceCapabilities>>({})

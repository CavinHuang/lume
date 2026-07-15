/**
 * useWorkspaceBootstrap - 应用启动时引导工作区
 *
 * 职责：
 * 1. 加载所有工作区到全局 atom
 * 2. 确保 currentWorkspaceIdAtom 指向一个合法的工作区；没有项目时保持为空
 */

import { useEffect, useRef, useState } from 'react'
import { useAtom } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentWorkspace } from '@lume/shared'
import { bootstrapWorkspaces } from './workspace-bootstrap-state'

export function useWorkspaceBootstrap() {
  const [, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const currentIdRef = useRef(currentId)
  const [ready, setReady] = useState(false)

  currentIdRef.current = currentId

  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        await bootstrapWorkspaces({
          listWorkspaces: async () => {
            const result = await sidecarCall<AgentWorkspace[]>('agent:list-workspaces', {})
            return Array.isArray(result) ? result : []
          },
          getCurrentWorkspaceId: () => currentIdRef.current,
          setWorkspaces,
          setCurrentWorkspaceId: setCurrentId,
          isCancelled: () => cancelled,
        })
      } catch (err) {
        console.error('[useWorkspaceBootstrap] 加载工作区失败:', err)
      } finally {
        if (!cancelled) setReady(true)
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setWorkspaces, setCurrentId])

  return ready
}

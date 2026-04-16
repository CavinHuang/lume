/**
 * useWorkspaceBootstrap - 应用启动时引导工作区
 *
 * 职责：
 * 1. 加载所有工作区到全局 atom
 * 2. 若后端返回空列表，自动创建「默认」工作区
 * 3. 确保 currentWorkspaceIdAtom 指向一个合法的工作区
 */

import { useEffect, useRef } from 'react'
import { useAtom } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentWorkspace } from '@lume/shared'

export function useWorkspaceBootstrap() {
  const [, setWorkspaces] = useAtom(agentWorkspacesAtom)
  const [currentId, setCurrentId] = useAtom(currentWorkspaceIdAtom)
  const done = useRef(false)

  useEffect(() => {
    if (done.current) return
    done.current = true

    let cancelled = false
    ;(async () => {
      try {
        const result = await sidecarCall<AgentWorkspace[]>('agent:list-workspaces', {})
        let list = Array.isArray(result) ? result : []

        // 空列表 → 自动创建「默认」工作区，避免用户每次手动创建
        if (list.length === 0) {
          try {
            const ws = await sidecarCall<AgentWorkspace>('agent:create-workspace', { name: '默认' })
            list = [ws]
          } catch (err) {
            console.error('[useWorkspaceBootstrap] 创建默认工作区失败:', err)
          }
        }

        if (cancelled) return
        setWorkspaces(list)

        // 当前选中的 workspace 已失效（删除/重建），回退到第一个
        const stillValid = currentId && list.some((w) => w.id === currentId)
        if (!stillValid && list[0]) {
          setCurrentId(list[0].id)
        }
      } catch (err) {
        console.error('[useWorkspaceBootstrap] 加载工作区失败:', err)
      }
    })()

    return () => {
      cancelled = true
    }
    // currentId 变动不需要重跑 bootstrap，done ref 已经保证只跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setWorkspaces, setCurrentId])
}

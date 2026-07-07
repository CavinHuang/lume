import { useEffect, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { createThread } from '@/lib/desktop-api'
import { invoke } from '@/lib/desktop-runtime/core'
import { useGlobalAgentListeners } from '@/hooks/useGlobalAgentListeners'
import { useWorkspaceBootstrap } from '@/hooks/useWorkspaceBootstrap'
import { AgentView } from '@/components/agent/AgentView'
import { QuickInputWorkspaceSelector } from './QuickInputWorkspaceSelector'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DRAG_REGION, NO_DRAG_REGION } from '@/components/app-shell/app-region'
import { WindowButtons } from '@/components/app-shell/WindowButtons'
import { toast } from 'sonner'

/**
 * 快速输入窗口主体：管理 threadId 与 workspace，装配全局监听器，
 * Esc 隐藏窗口，「新建对话」与 workspace 切换都会重建会话。
 */
export function QuickInput() {
  useGlobalAgentListeners()
  useWorkspaceBootstrap()
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const setAgentThreads = useSetAtom(agentThreadsAtom)
  const [threadId, setThreadId] = useState<string | null>(null)

  // 创建会话并写入 atom + 本地 threadId。写入 agentThreadsAtom 让 AgentView/AgentInput
  // 的 thread 解析（workspaceSlug、模型/权限/思考默认值）与主窗口一致。
  const createAndSetThread = (workspaceId?: string) =>
    createThread(workspaceId)
      .then((thread: any) => {
        const tid = thread?.id ?? null
        if (tid && thread) {
          setAgentThreads((prev) => (prev.some((t) => t.id === tid) ? prev : [...prev, thread]))
        }
        setThreadId(tid)
      })
      .catch((err) => {
        console.error('[QuickInput] createThread failed:', err)
        toast.error('创建会话失败')
      })

  // workspace 就绪后创建首个会话（useWorkspaceBootstrap 首次启动时异步创建默认 workspace）
  useEffect(() => {
    if (threadId || workspaces.length === 0) return
    const seed = currentWorkspaceId ?? workspaces[0]?.id
    createAndSetThread(seed ?? undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces.length])

  const handleNewThread = () => {
    const seed = currentWorkspaceId ?? workspaces[0]?.id
    createAndSetThread(seed ?? undefined)
  }

  const handleWorkspaceChange = (workspaceId: string) => {
    setCurrentWorkspaceId(workspaceId)
    // 切换即新建：让选择器始终反映当前会话的 workspace
    createAndSetThread(workspaceId)
  }

  // Esc 隐藏窗口
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        invoke('quick_input_hide').catch(() => {})
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden rounded-[10px] bg-[var(--lume-bg-app)] text-[var(--lume-text-primary)]">
      <header style={DRAG_REGION} className="flex items-center gap-2 px-3 h-10 border-b border-border/40 select-none">
        <div style={NO_DRAG_REGION} className="flex items-center">
          <QuickInputWorkspaceSelector onChange={handleWorkspaceChange} />
        </div>
        <div className="flex-1" />
        <div style={NO_DRAG_REGION}>
          <Button variant="ghost" onClick={handleNewThread} className="flex items-center gap-1 px-2 py-1 text-[12px] text-foreground/60 hover:bg-foreground/[0.06]">
            <Plus size={13} />
            新建对话
          </Button>
        </div>
        <div style={NO_DRAG_REGION} className="flex items-center">
          <WindowButtons showMaximize={false} />
        </div>
      </header>
      <main className="flex-1 min-h-0 flex min-w-0">
        {threadId ? (
          <AgentView threadId={threadId} />
        ) : (
          <div className="h-full grid place-items-center text-[12px] text-muted-foreground">准备会话…</div>
        )}
      </main>
    </div>
  )
}

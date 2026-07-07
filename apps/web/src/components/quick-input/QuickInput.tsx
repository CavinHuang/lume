import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { createThread } from '@/lib/desktop-api'
import { invoke } from '@/lib/desktop-runtime/core'
import { useGlobalAgentListeners } from '@/hooks/useGlobalAgentListeners'
import { useWorkspaceBootstrap } from '@/hooks/useWorkspaceBootstrap'
import { AgentView } from '@/components/agent/AgentView'
import { QuickInputWorkspaceSelector } from './QuickInputWorkspaceSelector'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DRAG_REGION, NO_DRAG_REGION } from '@/components/app-shell/app-region'
import { toast } from 'sonner'
import type { DesktopContextTarget } from '@lume/shared'

/**
 * 快速输入窗口主体：管理 threadId 与 workspace，装配全局监听器，
 * Esc 隐藏窗口，「新建对话」与 workspace 切换都会重建会话。
 */
export function QuickInput() {
  useGlobalAgentListeners()
  useWorkspaceBootstrap()
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messageMetadata, setMessageMetadata] = useState<Record<string, unknown> | undefined>()
  const [desktopContextTarget, setDesktopContextTarget] = useState<DesktopContextTarget | undefined>()

  // workspace 就绪后创建首个会话（useWorkspaceBootstrap 首次启动时异步创建默认 workspace）
  useEffect(() => {
    if (threadId || workspaces.length === 0) return
    const seed = currentWorkspaceId ?? workspaces[0]?.id
    createThread(seed ?? undefined)
      .then((thread) => setThreadId((thread as any)?.id ?? null))
      .catch((err) => {
        console.error('[QuickInput] createThread failed:', err)
        toast.error('创建会话失败')
      })
  }, [workspaces.length])

  useEffect(() => {
    let cancelled = false
    const refreshContext = () => {
      invoke<QuickInputContextResult>('quick_input_get_context')
        .then((result) => {
          if (cancelled) return
          const target = quickInputContextToTarget(result)
          setDesktopContextTarget(target)
          setMessageMetadata(target ? createDesktopContextMessageMetadata(target) : undefined)
        })
        .catch(() => {
          if (!cancelled) {
            setDesktopContextTarget(undefined)
            setMessageMetadata(undefined)
          }
        })
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'hidden') refreshContext()
    }
    refreshContext()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  const handleNewThread = () => {
    const seed = currentWorkspaceId ?? workspaces[0]?.id
    createThread(seed ?? undefined)
      .then((thread) => setThreadId((thread as any)?.id ?? null))
      .catch((err) => {
        console.error('[QuickInput] createThread failed:', err)
        toast.error('创建会话失败')
      })
  }

  const handleWorkspaceChange = (workspaceId: string) => {
    setCurrentWorkspaceId(workspaceId)
    // 切换即新建：让选择器始终反映当前会话的 workspace
    createThread(workspaceId)
      .then((thread) => setThreadId((thread as any)?.id ?? null))
      .catch((err) => {
        console.error('[QuickInput] createThread failed:', err)
        toast.error('创建会话失败')
      })
  }

  const handleSelectDesktopContextTarget = (target: DesktopContextTarget) => {
    setMessageMetadata(createDesktopContextMessageMetadata(target))
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
        {desktopContextTarget && typeof messageMetadata?.desktopContextSnapshotId === 'string' && (
          <Badge variant="secondary" className="max-w-[260px] truncate font-normal">
            已附加 {desktopContextTarget.app.name}
          </Badge>
        )}
        <div className="flex-1" />
        <div style={NO_DRAG_REGION}>
          <Button variant="ghost" onClick={handleNewThread} className="flex items-center gap-1 px-2 py-1 text-[12px] text-foreground/60 hover:bg-foreground/[0.06]">
            <Plus size={13} />
            新建对话
          </Button>
        </div>
      </header>
      <main className="flex-1 min-h-0">
        {threadId ? (
          <AgentView
            threadId={threadId}
            messageMetadata={messageMetadata}
            onMessageMetadataConsumed={() => {
              if (!desktopContextTarget) setMessageMetadata(undefined)
            }}
            desktopContextTarget={desktopContextTarget}
            onSelectDesktopContextTarget={handleSelectDesktopContextTarget}
          />
        ) : (
          <div className="h-full grid place-items-center text-[12px] text-muted-foreground">准备会话…</div>
        )}
      </main>
    </div>
  )
}

type QuickInputContextResult = {
  status?: string
  snapshotId?: string
  app?: { id?: unknown; name?: unknown }
  window?: { id?: unknown; title?: unknown }
  capturedAt?: unknown
}

function quickInputContextToTarget(result: QuickInputContextResult | undefined): DesktopContextTarget | undefined {
  if (
    result?.status !== 'ok'
    || typeof result.snapshotId !== 'string'
    || typeof result.app?.id !== 'string'
    || typeof result.app?.name !== 'string'
    || typeof result.window?.id !== 'string'
    || typeof result.window?.title !== 'string'
  ) return undefined
  return {
    snapshotId: result.snapshotId,
    app: { id: result.app.id, name: result.app.name },
    window: { id: result.window.id, title: result.window.title },
    ...(typeof result.capturedAt === 'number' ? { capturedAt: result.capturedAt } : {}),
  }
}

function createDesktopContextMessageMetadata(target: DesktopContextTarget): Record<string, unknown> {
  return {
    desktopContextSnapshotId: target.snapshotId,
    desktopApp: target.app,
    desktopWindow: target.window,
  }
}

import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { invoke } from '@/lib/desktop-runtime/core'
import { useGlobalAgentListeners } from '@/hooks/useGlobalAgentListeners'
import { useWorkspaceBootstrap } from '@/hooks/useWorkspaceBootstrap'
import { AgentView } from '@/components/agent/AgentView'
import { WelcomeView } from '@/components/welcome/WelcomeView'
import {
  createDesktopContextMessageMetadata,
  isLumeShellDesktopContextTarget,
} from '@/components/agent/agent-input-desktop-context'
import { QuickInputWorkspaceSelector } from './QuickInputWorkspaceSelector'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DRAG_REGION, NO_DRAG_REGION } from '@/components/app-shell/app-region'
import { WindowButtons } from '@/components/app-shell/WindowButtons'
import type { DesktopContextTarget } from '@lume/shared'
import { QuickInputTodoCapture } from './QuickInputTodoCapture'

/**
 * 快速输入窗口主体：管理 threadId 与 workspace，装配全局监听器，
 * 首次提交被接收后才建立 thread；窗口通过 Alt+L 或窗口按钮关闭。
 */
export function QuickInput() {
  useGlobalAgentListeners()
  const workspacesReady = useWorkspaceBootstrap()
  const [currentWorkspaceId, setCurrentWorkspaceId] = useAtom(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [mode, setMode] = useState<'chat' | 'todo'>('chat')
  const [todoPrefill, setTodoPrefill] = useState('')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [messageMetadata, setMessageMetadata] = useState<Record<string, unknown> | undefined>()
  const [desktopContextTarget, setDesktopContextTarget] = useState<DesktopContextTarget | undefined>()

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
    setThreadId(null)
  }

  const handleWorkspaceChange = (workspaceId: string | null) => {
    setCurrentWorkspaceId(workspaceId)
    setThreadId(null)
  }

  const handleSelectDesktopContextTarget = (target: DesktopContextTarget) => {
    setDesktopContextTarget(target)
    setMessageMetadata(createDesktopContextMessageMetadata(target))
  }

  const handleClearDesktopContextTarget = () => {
    setDesktopContextTarget(undefined)
    setMessageMetadata(undefined)
  }

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
          <Button variant="ghost" onClick={() => setMode((value) => value === 'chat' ? 'todo' : 'chat')} className="px-2 py-1 text-[12px]">{mode === 'todo' ? '聊天' : '待办'}</Button>
          <Button variant="ghost" onClick={handleNewThread} className="flex items-center gap-1 px-2 py-1 text-[12px] text-foreground/60 hover:bg-foreground/[0.06]">
            <Plus size={13} />
            新建对话
          </Button>
        </div>
        <div style={NO_DRAG_REGION} className="flex items-center">
          <WindowButtons showMaximize={false} />
        </div>
      </header>
      <main className="flex-1 min-h-0 flex min-w-0" onInputCapture={(event) => {
        if (mode !== 'chat') return
        const target = event.target as HTMLElement & { value?: unknown }
        const value = typeof target.value === 'string' ? target.value : target.textContent ?? ''
        const match = value.match(/^\s*\/todo(?:\s+([\s\S]*))?$/u)
        if (match) {
          setTodoPrefill(match[1]?.trim() ?? '')
          setMode('todo')
        }
      }}>
        {!workspacesReady ? (
          <div className="h-full grid flex-1 place-items-center text-[12px] text-muted-foreground">正在加载项目…</div>
        ) : mode === 'todo' ? (
          <QuickInputTodoCapture workspaces={workspaces} workspaceId={currentWorkspaceId} initialTitle={todoPrefill} onSaved={() => undefined} />
        ) : threadId ? (
          <AgentView
            threadId={threadId}
            messageMetadata={messageMetadata}
            onMessageMetadataConsumed={() => {
              if (!desktopContextTarget) setMessageMetadata(undefined)
            }}
            desktopContextTarget={desktopContextTarget}
            onSelectDesktopContextTarget={handleSelectDesktopContextTarget}
            onClearDesktopContextTarget={handleClearDesktopContextTarget}
          />
        ) : (
          <WelcomeView
            compact
            draftSurface="quick-input"
            workspaceId={currentWorkspaceId ?? undefined}
            desktopContextTarget={desktopContextTarget}
            onThreadCreated={(thread) => setThreadId(thread.id)}
          />
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
  const target = {
    snapshotId: result.snapshotId,
    app: { id: result.app.id, name: result.app.name },
    window: { id: result.window.id, title: result.window.title },
    ...(typeof result.capturedAt === 'number' ? { capturedAt: result.capturedAt } : {}),
  }
  return isLumeShellDesktopContextTarget(target) ? undefined : target
}

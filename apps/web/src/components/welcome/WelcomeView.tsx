import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Send, Loader2, Paperclip } from 'lucide-react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { useState, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import {
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  tabsAtom,
  activeTabIdAtom,
  agentSDKMessagesAtom,
} from '@/atoms'
import { sidecarCall, agentSend, openFileDialog } from '@/lib/desktop-api'
import { ThinkingLevelPicker } from '@/components/agent/ThinkingLevelPicker'
import { WelcomeModelPicker } from './WelcomeModelPicker'
import { WorkspaceSelector } from './WorkspaceSelector'
import { RecentThreads } from './RecentThreads'
import type { AgentThreadMeta, LumeConfigThinkingLevel } from '@lume/shared'
import { cn } from '@/lib/utils'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'

interface WelcomeViewProps {
  workspaceId?: string
}

export function WelcomeView({ workspaceId: initialWorkspaceId }: WelcomeViewProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useAtom(activeTabIdAtom)[1]
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const setCurrentWorkspaceId = useAtom(currentWorkspaceIdAtom)[1]

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    initialWorkspaceId ?? currentWorkspaceId ?? null
  )
  const [modelRef, setModelRef] = useState<string | undefined>()
  const [channelId, setChannelId] = useState<string | undefined>()
  const [modelId, setModelId] = useState<string | undefined>()
  const [thinkingLevel, setThinkingLevel] = useState<LumeConfigThinkingLevel>('off')
  const [sending, setSending] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<Array<{ filename: string; sourcePath: string }>>([])

  useEffect(() => {
    getEffectiveLumeConfig()
      .then((config) => {
        if (config.agent?.thinkingLevel) setThinkingLevel(config.agent.thinkingLevel)
      })
      .catch(() => {})
  }, [])

  const selectedWorkspace = useMemo(
    () => workspaces.find((ws) => ws.id === selectedWorkspaceId),
    [workspaces, selectedWorkspaceId]
  )

  const workspaceSlug = selectedWorkspace?.slug ?? null

  const recentThreads = useMemo(() => {
    if (!selectedWorkspaceId) return []
    return threads
      .filter((t) => t.workspaceId === selectedWorkspaceId && !t.pinned)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 3)
  }, [threads, selectedWorkspaceId])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Placeholder.configure({ placeholder: '描述你想完成的任务...' }),
    ],
    editorProps: {
      attributes: { class: 'outline-none min-h-[80px] max-h-[200px] overflow-y-auto text-[14px] leading-relaxed' },
      handleKeyDown(_, event) {
        if (event.key === 'Enter' && !event.shiftKey && !sending) {
          event.preventDefault()
          handleSend()
          return true
        }
        return false
      },
    },
  })

  const handleSend = async () => {
    if (!editor || sending) return
    const text = editor.getText().trim()
    if (!text) return

    setSending(true)
    try {
      const meta = await sidecarCall<AgentThreadMeta>('agent:create-thread', {
        workspaceId: selectedWorkspaceId ?? undefined,
        modelRef,
        channelId,
        modelId,
      })

      if (pendingFiles.length > 0) {
        await sidecarCall('agent:save-files-to-thread', {
          threadId: meta.id,
          files: pendingFiles,
          workspaceSlug,
        })
      }

      const now = Date.now()
      const userMsg = {
        type: 'user' as const,
        uuid: `user:${meta.id}:${now}`,
        session_id: meta.id,
        timestamp: new Date(now).toISOString(),
        parent_tool_use_id: null,
        message: {
          role: 'user' as const,
          content: [{ type: 'text' as const, text }],
        },
      }
      setSDKMessages((prev) => ({
        ...prev,
        [meta.id]: [...(prev[meta.id] ?? []), userMsg as any],
      }))

      await agentSend({
        threadId: meta.id,
        userMessage: text,
        thinkingLevel,
      } as any)

      setTabs((prev) => {
        const withoutWelcome = prev.filter((t) => t.id !== '__welcome__')
        return [
          { id: meta.id, type: 'agent' as const, title: meta.title, threadId: meta.id },
          ...withoutWelcome,
        ]
      })
      setActiveTabId(meta.id)
      setThreads((prev) => [meta, ...prev])
    } catch (err) {
      console.error('[WelcomeView] 发送失败:', err)
      toast.error('发送失败，请重试')
    } finally {
      setSending(false)
    }
  }

  const handleAttach = async () => {
    try {
      const result = await openFileDialog()
      if (result.files.length === 0) return
      setPendingFiles((prev) => [
        ...prev,
        ...result.files.map((f) => ({ filename: f.filename, sourcePath: f.sourcePath })),
      ])
      toast.success(`已添加 ${result.files.length} 个文件`)
    } catch (err) {
      console.error('[WelcomeView] 文件选择失败:', err)
      toast.error('文件选择失败')
    }
  }

  const handleSelectWorkspace = (wsId: string) => {
    setSelectedWorkspaceId(wsId)
    setCurrentWorkspaceId(wsId)
    setTabs((prev) =>
      prev.map((t) =>
        t.id === '__welcome__' ? { ...t, workspaceId: wsId } : t
      )
    )
  }

  const handleOpenThread = (thread: AgentThreadMeta) => {
    setActiveTabId(thread.id)
    if (!tabs.find((t) => t.id === thread.id)) {
      setTabs((prev) => [...prev, { id: thread.id, type: 'agent' as const, title: thread.title, threadId: thread.id }])
    }
  }

  const hasText = editor?.getText().trim().length > 0

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-4 overflow-y-auto">
      <div className="w-full max-w-xl flex flex-col items-center">
        <h2 className="text-xl font-semibold text-foreground mb-6">
          What should we work on
          {selectedWorkspace ? (
            <>
              {' '}in{' '}
              <span className="bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent">
                {selectedWorkspace.name}
              </span>
            </>
          ) : null}
          ?
        </h2>

        <div className={cn(
          'w-full rounded-2xl border border-border/60 bg-background shadow-sm transition-colors',
          sending && 'opacity-60'
        )}>
          <div className="px-4 py-3">
            <EditorContent editor={editor} />
          </div>

          {pendingFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-2">
              {pendingFiles.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 text-[11px] bg-muted px-2 py-0.5 rounded"
                >
                  {f.filename}
                  <button
                    onClick={() => setPendingFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between px-3 pb-2 gap-2">
            <div className="flex items-center gap-1 min-w-0 flex-wrap">
              <WorkspaceSelector
                workspaces={workspaces}
                selectedId={selectedWorkspaceId}
                onSelect={handleSelectWorkspace}
              />
              <WelcomeModelPicker
                onModelChange={(ref, chId, mId) => {
                  setModelRef(ref)
                  setChannelId(chId)
                  setModelId(mId)
                }}
              />
              <button
                onClick={handleAttach}
                className="p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors"
                title="附加文件"
                disabled={sending}
              >
                <Paperclip size={15} />
              </button>
              <ThinkingLevelPicker value={thinkingLevel} onChange={setThinkingLevel} />
            </div>
            {sending ? (
              <div className="p-1.5">
                <Loader2 size={14} className="animate-spin text-muted-foreground" />
              </div>
            ) : (
              <button
                onClick={handleSend}
                disabled={!hasText}
                className={cn(
                  'p-1.5 rounded-lg transition-colors',
                  hasText
                    ? 'bg-primary text-primary-foreground hover:opacity-90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
                title="发送"
              >
                <Send size={14} />
              </button>
            )}
          </div>
        </div>

        <RecentThreads threads={recentThreads} onOpen={handleOpenThread} />
      </div>
    </div>
  )
}

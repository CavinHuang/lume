import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEditor } from '@tiptap/react'
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
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { WelcomeModelPicker } from './WelcomeModelPicker'
import { WorkspaceSelector } from './WorkspaceSelector'
import type { AgentThreadMeta, LumeConfigThinkingLevel } from '@lume/shared'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'
import { LumeWelcomeSurface } from './LumeWelcomeSurface'
import { buildWelcomeSurfaceViewModel } from './welcome-surface-view-model'

interface WelcomeViewProps {
  workspaceId?: string
}

export function WelcomeView({ workspaceId: initialWorkspaceId }: WelcomeViewProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const setThreads = useSetAtom(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const setWorkspaces = useSetAtom(agentWorkspacesAtom)
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
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)

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
  }, [threads, selectedWorkspaceId])

  const welcomeSurfaceModel = useMemo(
    () =>
      buildWelcomeSurfaceViewModel({
        workspaceName: selectedWorkspace?.name ?? null,
        recentThreads,
        recentFiles: pendingFiles.map((file) => ({
          filename: file.filename,
          sourcePath: file.sourcePath,
        })),
      }),
    [pendingFiles, recentThreads, selectedWorkspace?.name]
  )

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

  const handleOpenThreadById = (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId)
    if (!thread) return
    handleOpenThread(thread)
  }

  const handleChoosePromptSeed = (promptSeed: string) => {
    if (!editor) return
    editor.commands.clearContent()
    editor.commands.insertContent(promptSeed)
    editor.commands.focus('end')
  }

  const hasText = editor?.getText().trim().length > 0

  return (
    <>
      <LumeWelcomeSurface
        model={welcomeSurfaceModel}
        workspaceSelector={
          <WorkspaceSelector
            workspaces={workspaces}
            selectedId={selectedWorkspaceId}
            onSelect={handleSelectWorkspace}
            onCreateWorkspaceClick={() => setCreateWorkspaceOpen(true)}
          />
        }
        modelPicker={
          <WelcomeModelPicker
            onModelChange={(ref, chId, mId) => {
              setModelRef(ref)
              setChannelId(chId)
              setModelId(mId)
            }}
          />
        }
        thinkingLevelPicker={
          <ThinkingLevelPicker value={thinkingLevel} onChange={setThinkingLevel} />
        }
        editor={editor}
        pendingFiles={pendingFiles}
        sending={sending}
        hasText={Boolean(hasText)}
        onSend={handleSend}
        onAttach={handleAttach}
        onOpenThread={handleOpenThreadById}
        onChoosePromptSeed={handleChoosePromptSeed}
        onRemovePendingFile={(index) =>
          setPendingFiles((prev) => prev.filter((_, itemIndex) => itemIndex !== index))
        }
      />
      <CreateWorkspaceDialog
        open={createWorkspaceOpen}
        onOpenChange={setCreateWorkspaceOpen}
        onCreated={(workspace) => {
          setWorkspaces((prev) => (prev.some((item) => item.id === workspace.id) ? prev : [...prev, workspace]))
          setSelectedWorkspaceId(workspace.id)
          setCurrentWorkspaceId(workspace.id)
          setTabs((prev) =>
            prev.map((tab) =>
              tab.id === '__welcome__' ? { ...tab, workspaceId: workspace.id } : tab
            )
          )
        }}
      />
    </>
  )
}

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
  agentRuntimeEventsAtom,
  agentStreamingStatesAtom,
  agentPlanModePhaseAtom,
  welcomePromptSeedAtom,
} from '@/atoms'
import { sidecarCall, agentSend, openFileDialog } from '@/lib/desktop-api'
import { appendRuntimeEvent } from '@/hooks/runtime-event-state'
import { PermissionModePicker } from '@/components/agent/PermissionModePicker'
import { ThinkingLevelPicker } from '@/components/agent/ThinkingLevelPicker'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { WelcomeModelPicker } from './WelcomeModelPicker'
import { WorkspaceSelector } from './WorkspaceSelector'
import { AGENT_IPC_CHANNELS, type AgentThreadMeta, type LumeConfigThinkingLevel } from '@lume/shared'
import { getEffectiveLumeConfig, updateAgentThinkingLevel } from '@/lib/desktop-api/lume-config'
import { LumeWelcomeSurface } from './LumeWelcomeSurface'
import { buildWelcomeSurfaceViewModel } from './welcome-surface-view-model'
import type { PermissionModeValue } from '@/components/settings/agent-settings-state'

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
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setPlanModePhase = useSetAtom(agentPlanModePhaseAtom)
  const setCurrentWorkspaceId = useAtom(currentWorkspaceIdAtom)[1]
  const [welcomePromptSeed, setWelcomePromptSeed] = useAtom(welcomePromptSeedAtom)

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    initialWorkspaceId ?? currentWorkspaceId ?? null
  )
  const [modelRef, setModelRef] = useState<string | undefined>()
  const [channelId, setChannelId] = useState<string | undefined>()
  const [modelId, setModelId] = useState<string | undefined>()
  const [thinkingLevel, setThinkingLevel] = useState<LumeConfigThinkingLevel>('off')
  const [permissionMode, setPermissionMode] = useState<PermissionModeValue>('default')
  const [sending, setSending] = useState(false)
  const [editorText, setEditorText] = useState('')
  const [pendingFiles, setPendingFiles] = useState<Array<{ filename: string; sourcePath: string }>>([])
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)

  useEffect(() => {
    getEffectiveLumeConfig()
      .then((config) => {
        if (config.agent?.thinkingLevel) setThinkingLevel(config.agent.thinkingLevel)
        if (config.agent?.permissionMode) setPermissionMode(config.agent.permissionMode)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    setSelectedWorkspaceId(initialWorkspaceId ?? currentWorkspaceId ?? null)
  }, [currentWorkspaceId, initialWorkspaceId])

  const selectedWorkspace = useMemo(
    () => workspaces.find((ws) => ws.id === selectedWorkspaceId),
    [workspaces, selectedWorkspaceId]
  )

  const workspaceSlug = selectedWorkspace?.slug ?? null

  useEffect(() => {
    setModelRef(undefined)
    setChannelId(undefined)
    setModelId(undefined)
  }, [workspaceSlug])

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
      Placeholder.configure({ placeholder: '输入 @文件 /Skill #MCP，或直接描述你想完成的任务...' }),
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
    onCreate({ editor }) {
      setEditorText(editor.getText())
    },
    onUpdate({ editor }) {
      setEditorText(editor.getText())
    },
  })

  useEffect(() => {
    if (!editor || !welcomePromptSeed) return
    editor.commands.clearContent()
    editor.commands.insertContent(welcomePromptSeed)
    editor.commands.focus('end')
    setWelcomePromptSeed(null)
  }, [editor, setWelcomePromptSeed, welcomePromptSeed])

  const handleSend = async () => {
    if (!editor || sending) return
    const text = editor.getText().trim()
    if (!text) return

    setSending(true)
    try {
      const meta = await sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.CREATE_THREAD, {
        workspaceId: selectedWorkspaceId ?? undefined,
        modelRef,
        channelId,
        modelId,
      })

      if (pendingFiles.length > 0) {
        await sidecarCall(AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD, {
          threadId: meta.id,
          files: pendingFiles,
          workspaceSlug,
        })
      }

      setTabs((prev) => {
        const withoutWelcome = prev.filter((t) => t.id !== '__welcome__')
        return [
          { id: meta.id, type: 'agent' as const, title: meta.title, threadId: meta.id, workspaceId: meta.workspaceId },
          ...withoutWelcome,
        ]
      })
      setActiveTabId(meta.id)
      setThreads((prev) => [meta, ...prev])
      setStreamingStates((prev) => ({ ...prev, [meta.id]: 'streaming' }))
      if (permissionMode === 'plan') {
        setPlanModePhase((prev) => ({ ...prev, [meta.id]: { threadId: meta.id, phase: 'planning' } }))
      }

      const createdAt = new Date().toISOString()
      setRuntimeEvents((prev) => appendRuntimeEvent(prev, {
        id: `optimistic:${meta.id}:${createdAt}`,
        type: 'message.user.submitted',
        threadId: meta.id,
        runId: `optimistic:${meta.id}:${createdAt}`,
        createdAt,
        text,
      }))

      await agentSend({
        threadId: meta.id,
        userMessage: text,
        thinkingLevel,
        permissionMode,
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
      } as any)
      editor.commands.clearContent()
      setEditorText('')
      setPendingFiles([])
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

  const handleThinkingLevelChange = async (value: LumeConfigThinkingLevel) => {
    setThinkingLevel(value)
    try {
      await updateAgentThinkingLevel(value)
    } catch (error) {
      console.error('[WelcomeView] 保存思考等级失败:', error)
      toast.error('保存思考等级失败')
    }
  }

  const hasText = editorText.trim().length > 0

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
            variant="hero"
            selectedChannelId={channelId}
            selectedModelRef={modelRef}
            workspaceSlug={workspaceSlug}
            onModelChange={(ref, chId, mId) => {
              setModelRef(ref)
              setChannelId(chId)
              setModelId(mId)
            }}
          />
        }
        composerModelPicker={
          <WelcomeModelPicker
            variant="composer"
            selectedChannelId={channelId}
            selectedModelRef={modelRef}
            workspaceSlug={workspaceSlug}
            onModelChange={(ref, chId, mId) => {
              setModelRef(ref)
              setChannelId(chId)
              setModelId(mId)
            }}
          />
        }
        thinkingLevelPicker={
          <ThinkingLevelPicker value={thinkingLevel} onChange={handleThinkingLevelChange} />
        }
        permissionModePicker={
          <PermissionModePicker value={permissionMode} onChange={setPermissionMode} />
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

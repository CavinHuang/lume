import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { Plus, X, Folder } from 'lucide-react'
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
import { sidecarCall, agentSend, getQuickInputContext, openFileDialog, openFolderDialog, onSidecarEvent } from '@/lib/desktop-api'
import { appendRuntimeEvent } from '@/hooks/runtime-event-state'
import { PermissionModePicker } from '@/components/agent/PermissionModePicker'
import { ThinkingLevelPicker } from '@/components/agent/ThinkingLevelPicker'
import { CreateWorkspaceDialog } from '@/components/workspace/CreateWorkspaceDialog'
import { WelcomeModelPicker } from './WelcomeModelPicker'
import { WorkspaceSelector } from './WorkspaceSelector'
import {
  AGENT_IPC_CHANNELS,
  DESKTOP_CONTEXT_IPC_CHANNELS,
  type AgentMessageAttachmentInput,
  type AgentSavedFile,
  type AgentThreadMeta,
  type AgentWelcomeSuggestion,
  type AgentWelcomeSuggestionsResult,
  type DesktopContextTarget,
  type LumeConfigThinkingLevel,
} from '@lume/shared'
import { LUME_CONFIG_IPC_CHANNELS } from '@lume/shared'
import { getEffectiveLumeConfig, updateAgentThinkingLevel } from '@/lib/desktop-api/lume-config'
import { LumeWelcomeSurface } from './LumeWelcomeSurface'
import { buildWelcomeSurfaceViewModel, DEFAULT_WELCOME_SUGGESTIONS } from './welcome-surface-view-model'
import type { PermissionModeValue } from '@/components/settings/agent-settings-state'
import { createSuggestionRenderer } from '@/components/agent/editor-mention-suggestions'
import { attachmentDataUrl, isImageAttachment } from '@/components/agent/AgentAttachmentGrid'
import {
  captureAgentInputDesktopContextState,
  createDesktopContextMessageMetadata,
  desktopPermissionRequestMessage,
} from '@/components/agent/agent-input-desktop-context'

import { Button } from '@/components/ui/button'
interface WelcomeViewProps {
  workspaceId?: string
  desktopContextTarget?: DesktopContextTarget
}

interface WelcomePendingFile {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath?: string
  data?: string
  previewUrl?: string
}

export function WelcomeView({ workspaceId: initialWorkspaceId, desktopContextTarget: initialDesktopContextTarget }: WelcomeViewProps) {
  const setThreads = useSetAtom(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const setWorkspaces = useSetAtom(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
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
  const [pendingFiles, setPendingFiles] = useState<WelcomePendingFile[]>([])
  const [pendingFolders, setPendingFolders] = useState<{ id: string; path: string; name: string }[]>([])
  const [welcomeSuggestions, setWelcomeSuggestions] = useState<AgentWelcomeSuggestion[]>(DEFAULT_WELCOME_SUGGESTIONS)
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false)
  const [capturedDesktopContextTarget, setCapturedDesktopContextTarget] = useState<DesktopContextTarget>()
  const [selectedDesktopContextTarget, setSelectedDesktopContextTarget] = useState<DesktopContextTarget | undefined>(initialDesktopContextTarget)
  const [desktopContextCaptureLoading, setDesktopContextCaptureLoading] = useState(false)
  const [desktopContextCaptureMessage, setDesktopContextCaptureMessage] = useState<string>()
  const [desktopContextPermissionRequestAvailable, setDesktopContextPermissionRequestAvailable] = useState(false)
  const [desktopContextPermissionRequestLoading, setDesktopContextPermissionRequestLoading] = useState(false)

  useEffect(() => {
    setSelectedWorkspaceId(initialWorkspaceId ?? currentWorkspaceId ?? null)
  }, [currentWorkspaceId, initialWorkspaceId])

  useEffect(() => {
    setSelectedDesktopContextTarget(initialDesktopContextTarget)
  }, [initialDesktopContextTarget])

  const selectedWorkspace = useMemo(
    () => workspaces.find((ws) => ws.id === selectedWorkspaceId),
    [workspaces, selectedWorkspaceId]
  )

  const workspaceSlug = selectedWorkspace?.slug ?? null
  const configWorkspaceSlug = workspaceSlug ?? undefined

  useEffect(() => {
    let cancelled = false
    getEffectiveLumeConfig(configWorkspaceSlug)
      .then((config) => {
        if (!cancelled) {
          if (config.agent?.thinkingLevel) setThinkingLevel(config.agent.thinkingLevel)
          if (config.agent?.permissionMode) setPermissionMode(config.agent.permissionMode)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [configWorkspaceSlug])

  useEffect(() => {
    let cancelled = false
    const unlisten = onSidecarEvent((method) => {
      if (method !== LUME_CONFIG_IPC_CHANNELS.CHANGED) return
      getEffectiveLumeConfig(configWorkspaceSlug)
        .then((config) => {
          if (!cancelled) {
            if (config.agent?.thinkingLevel) setThinkingLevel(config.agent.thinkingLevel)
            if (config.agent?.permissionMode) setPermissionMode(config.agent.permissionMode)
          }
        })
        .catch(() => {})
    })
    return () => { cancelled = true; unlisten.then((fn) => fn()) }
  }, [configWorkspaceSlug])

  useEffect(() => {
    setModelRef(undefined)
    setChannelId(undefined)
    setModelId(undefined)
  }, [workspaceSlug])

  useEffect(() => {
    let cancelled = false
    setWelcomeSuggestions(DEFAULT_WELCOME_SUGGESTIONS)
    sidecarCall<AgentWelcomeSuggestionsResult>(AGENT_IPC_CHANNELS.GENERATE_WELCOME_SUGGESTIONS, {
      workspaceSlug: configWorkspaceSlug,
      workspaceName: selectedWorkspace?.name ?? undefined,
    })
      .then((result) => {
        if (!cancelled && result.suggestions.length > 0) {
          setWelcomeSuggestions(result.suggestions)
        }
      })
      .catch(() => {
        if (!cancelled) setWelcomeSuggestions(DEFAULT_WELCOME_SUGGESTIONS)
      })
    return () => { cancelled = true }
  }, [configWorkspaceSlug, selectedWorkspace?.name])

  const welcomeSurfaceModel = useMemo(
    () =>
      buildWelcomeSurfaceViewModel({
        workspaceName: selectedWorkspace?.name ?? null,
      }),
    [selectedWorkspace?.name]
  )

  const mentionSuggestionOpenRef = useRef(false)
  const workspaceSlugRef = useRef<string | null>(workspaceSlug)
  const setMentionSuggestionOpen = useCallback((open: boolean) => {
    mentionSuggestionOpenRef.current = open
  }, [])

  useEffect(() => {
    workspaceSlugRef.current = workspaceSlug
  }, [workspaceSlug])

  const getWorkspaceSlug = () => workspaceSlugRef.current

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false, bold: false, italic: false, strike: false }),
      Placeholder.configure({ placeholder: '输入 /命令 $技能，或直接描述你想完成的任务...' }),
      Mention.configure({
        HTMLAttributes: {
          class: 'mention bg-orange-500/10 text-orange-600 dark:text-orange-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('/', '__welcome__', '/', getWorkspaceSlug, setMentionSuggestionOpen),
      }),
      Mention.extend({ name: 'skillMention' }).configure({
        HTMLAttributes: {
          class: 'mention bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('$', '__welcome__', '$', getWorkspaceSlug, setMentionSuggestionOpen),
      }),
    ],
    editorProps: {
      attributes: { class: 'outline-none min-h-[80px] max-h-[200px] overflow-y-auto text-[14px] leading-relaxed' },
      handleKeyDown(_, event) {
        if (event.key === 'Enter' && !event.shiftKey && !sending && !mentionSuggestionOpenRef.current) {
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

  const handleWelcomeSuggestionSelect = useCallback((prompt: string) => {
    if (!editor) {
      setWelcomePromptSeed(prompt)
      return
    }
    editor.commands.clearContent()
    editor.commands.insertContent(prompt)
    editor.commands.focus('end')
  }, [editor, setWelcomePromptSeed])

  const handleSend = async () => {
    if (!editor || sending) return
    const rawText = editor.getText().trim()
    if (!rawText && pendingFiles.length === 0 && pendingFolders.length === 0) return
    const text = rawText || '请解读这些附件。'

    setSending(true)
    try {
      const meta = await sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.CREATE_THREAD, {
        workspaceId: selectedWorkspaceId ?? undefined,
        modelRef,
        channelId,
        modelId,
      })

      let messageAttachments: AgentMessageAttachmentInput[] = []
      if (pendingFiles.length > 0) {
        const savedFiles = await sidecarCall<AgentSavedFile[]>(AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD, {
          threadId: meta.id,
          workspaceSlug,
          files: pendingFiles.map((file) => ({
            filename: file.filename,
            ...(file.sourcePath ? { sourcePath: file.sourcePath } : {}),
            ...(file.data ? { data: file.data } : {}),
          })),
        })
        messageAttachments = pendingFiles.map((file, index) => {
          const saved = savedFiles.find((savedFile) => savedFile.filename === file.filename) ?? savedFiles[index]
          return {
            id: file.id,
            filename: file.filename,
            mediaType: file.mediaType,
            size: file.size,
            threadPath: saved?.threadPath ?? file.filename,
          }
        })
      }

      setTabs((prev) => {
        const withoutWelcome = prev.filter((t) => t.id !== '__welcome__')
        return [
          {
            id: meta.id,
            type: 'agent' as const,
            title: meta.title,
            threadId: meta.id,
            workspaceId: meta.workspaceId,
            ...(selectedDesktopContextTarget ? { desktopContextTarget: selectedDesktopContextTarget } : {}),
          },
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
        ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
      }))

      await agentSend({
        threadId: meta.id,
        userMessage: text,
        thinkingLevel,
        permissionMode,
        ...(messageAttachments.length > 0 ? { messageAttachments } : {}),
        ...(selectedDesktopContextTarget
          ? { messageMetadata: createDesktopContextMessageMetadata(selectedDesktopContextTarget) }
          : {}),
        ...(pendingFolders.length > 0 ? { attachedDirectories: pendingFolders.map((f) => f.path) } : {}),
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
      } as any)
      editor.commands.clearContent()
      setEditorText('')
      setPendingFiles([])
      setPendingFolders([])
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
        ...result.files.map((file) => {
          const mediaType = file.mediaType || 'application/octet-stream'
          return {
            id: createWelcomePendingFileId(),
            filename: file.filename,
            mediaType,
            size: file.size,
            sourcePath: file.sourcePath,
            ...(file.data ? { data: file.data } : {}),
            ...(isImageAttachment({ filename: file.filename, mediaType })
              ? { previewUrl: attachmentDataUrl(mediaType, file.data) }
              : {}),
          }
        }),
      ])
      toast.success(`已添加 ${result.files.length} 个文件`)
    } catch (err) {
      console.error('[WelcomeView] 文件选择失败:', err)
      toast.error('文件选择失败')
    }
  }

  const handlePluginSelect = useCallback((pluginName: string) => {
    if (!editor) return
    editor.commands.insertContent(`$${pluginName} `)
    editor.commands.focus('end')
  }, [editor])

  const handleAttachMenuOpen = useCallback(async () => {
    setDesktopContextCaptureLoading(true)
    setDesktopContextCaptureMessage(undefined)
    setDesktopContextPermissionRequestAvailable(false)
    setCapturedDesktopContextTarget(undefined)
    const state = await captureAgentInputDesktopContextState(sidecarCall, getQuickInputContext)
    if (state.status === 'ready') {
      setCapturedDesktopContextTarget(state.target)
      setDesktopContextPermissionRequestAvailable(false)
    } else {
      setDesktopContextCaptureMessage(state.message)
      setDesktopContextPermissionRequestAvailable(state.permissionRequestAvailable === true)
    }
    setDesktopContextCaptureLoading(false)
  }, [])

  const handleRequestDesktopContextPermissions = useCallback(async () => {
    setDesktopContextPermissionRequestLoading(true)
    try {
      const result = await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.REQUEST_PERMISSIONS, {})
      setDesktopContextCaptureMessage(desktopPermissionRequestMessage(result))
      toast.success('已启动 Lume Computer Use.app 授权引导')
    } catch (error) {
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : '启动授权引导失败'
      setDesktopContextCaptureMessage(message)
      toast.error(message)
    } finally {
      setDesktopContextPermissionRequestLoading(false)
    }
  }, [])

  const handleSelectWorkspace = (wsId: string) => {
    setSelectedWorkspaceId(wsId)
    setCurrentWorkspaceId(wsId)
    setTabs((prev) =>
      prev.map((t) =>
        t.id === '__welcome__' ? { ...t, workspaceId: wsId } : t
      )
    )
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

  const handlePermissionModeChange = (value: PermissionModeValue) => {
    setPermissionMode(value)
  }

  const hasText = editorText.trim().length > 0 || pendingFiles.length > 0 || pendingFolders.length > 0

  const handleAttachFolder = async () => {
    try {
      const selection = await openFolderDialog()
      if (!selection.path) return
      const folderName = selection.path.split('/').filter(Boolean).pop() ?? 'folder'
      setPendingFolders((prev) => [
        ...prev,
        { id: createWelcomePendingFileId(), path: selection.path!, name: folderName },
      ])
      toast.success(`已添加文件夹 ${folderName}`)
    } catch (err) {
      console.error('[WelcomeView] 文件夹选择失败:', err)
      toast.error('文件夹选择失败')
    }
  }

  const folderBar = (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      {pendingFolders.map((folder) => (
        <span
          key={folder.id}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--surface-3)] px-2.5 py-1 text-[12px] text-[var(--text-2)]"
        >
          <Folder size={13} />
          {folder.name}
          <Button
                variant="ghost"
            type="button"
            className="ml-0.5 text-[var(--text-3)] hover:text-[var(--text-1)]"
            onClick={() => setPendingFolders((prev) => prev.filter((f) => f.id !== folder.id))}
          >
            <X size={12} />
          </Button>
        </span>
      ))}
      <Button
                variant="ghost"
        type="button"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] text-[var(--text-3)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_50%,transparent)] hover:text-[var(--text-2)]"
        onClick={handleAttachFolder}
      >
        <Plus size={13} />
        选择附加的项目文件夹
      </Button>
    </div>
  )

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
          <PermissionModePicker value={permissionMode} onChange={handlePermissionModeChange} />
        }
        editor={editor}
        pendingFiles={pendingFiles}
        sending={sending}
        hasText={Boolean(hasText)}
        onSend={handleSend}
        onAttach={handleAttach}
        onAttachMenuOpen={handleAttachMenuOpen}
        onPluginSelect={handlePluginSelect}
        desktopContextTarget={capturedDesktopContextTarget}
        selectedDesktopContextTarget={selectedDesktopContextTarget}
        desktopContextCaptureLoading={desktopContextCaptureLoading}
        desktopContextCaptureMessage={desktopContextCaptureMessage}
        desktopContextPermissionRequestAvailable={desktopContextPermissionRequestAvailable}
        desktopContextPermissionRequestLoading={desktopContextPermissionRequestLoading}
        onRequestDesktopContextPermissions={handleRequestDesktopContextPermissions}
        onSelectDesktopContextTarget={setSelectedDesktopContextTarget}
        onClearDesktopContextTarget={() => setSelectedDesktopContextTarget(undefined)}
        suggestions={welcomeSuggestions}
        onSuggestionSelect={handleWelcomeSuggestionSelect}
        onRemovePendingFile={(index) =>
          setPendingFiles((prev) => prev.filter((_, itemIndex) => itemIndex !== index))
        }
        folderBar={folderBar}
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

function createWelcomePendingFileId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `welcome-attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

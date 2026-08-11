import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEditor } from '@tiptap/react'
import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import {
  agentThreadsAtom,
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  tabsAtom,
  activeTabIdAtom,
  agentStreamingStatesAtom,
  agentPlanModePhaseAtom,
  agentThreadPermissionModesAtom,
  welcomeCapabilitySeedAtom,
  welcomePromptSeedAtom,
} from '@/atoms'
import { abortStagedAttachment, sidecarCall, agentSend, getQuickInputContext, isTerminalAgentSubmissionError, openFileDialog, onSidecarEvent } from '@/lib/desktop-api'
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
import { createCapabilityReferencePasteHandler, createSuggestionRenderer } from '@/components/agent/editor-mention-suggestions'
import { extractClipboardFiles, handleAttachmentPaste } from '@/components/agent/editor-attachment-paste'
import { createPromptEditorExtensions } from '@/components/agent/prompt-editor-extensions'
import { serializeAgentEditorMessage } from '@/components/agent/agent-editor-message-parts'
import { isImageAttachment } from '@/components/agent/AgentAttachmentGrid'
import { pendingAttachmentRejectionMessage, validatePendingAttachmentBatch } from '@/components/agent/pending-attachment-validation'
import {
  captureAgentInputDesktopContextState,
  createDesktopContextMessageMetadata,
  desktopPermissionRequestCompleted,
  desktopPermissionRequestMessage,
  desktopPermissionRequestToastMessage,
  refreshAgentInputDesktopContextState,
} from '@/components/agent/agent-input-desktop-context'

interface WelcomeViewProps {
  workspaceId?: string
  desktopContextTarget?: DesktopContextTarget
  compact?: boolean
  draftSurface?: 'welcome' | 'quick-input'
  onThreadCreated?: (thread: AgentThreadMeta) => void
}

interface WelcomePendingFile {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath?: string
  data?: string
  stagedAttachmentId?: string
  previewUrl?: string
}

export function WelcomeView({
  workspaceId: initialWorkspaceId,
  desktopContextTarget: initialDesktopContextTarget,
  compact = false,
  draftSurface = 'welcome',
  onThreadCreated,
}: WelcomeViewProps) {
  const setThreads = useSetAtom(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const setWorkspaces = useSetAtom(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const setPlanModePhase = useSetAtom(agentPlanModePhaseAtom)
  const setThreadPermissionModes = useSetAtom(agentThreadPermissionModesAtom)
  const setCurrentWorkspaceId = useAtom(currentWorkspaceIdAtom)[1]
  const [welcomePromptSeed, setWelcomePromptSeed] = useAtom(welcomePromptSeedAtom)
  const [welcomeCapabilitySeed, setWelcomeCapabilitySeed] = useAtom(welcomeCapabilitySeedAtom)

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    initialWorkspaceId ?? currentWorkspaceId ?? null
  )
  const [modelRef, setModelRef] = useState<string | undefined>()
  const [channelId, setChannelId] = useState<string | undefined>()
  const [modelId, setModelId] = useState<string | undefined>()
  const [thinkingLevel, setThinkingLevel] = useState<LumeConfigThinkingLevel>('off')
  const [permissionMode, setPermissionMode] = useState<PermissionModeValue>('default')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(sending)
  sendingRef.current = sending
  const [editorText, setEditorText] = useState('')
  const [pendingFiles, setPendingFiles] = useState<WelcomePendingFile[]>([])
  const pendingFilesRef = useRef<WelcomePendingFile[]>([])
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
  const draftStorageKey = `lume-composer-draft:${draftSurface}:${selectedWorkspaceId ?? 'none'}`
  const draftStorageKeyRef = useRef(draftStorageKey)

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
  const pendingWelcomeSubmissionRef = useRef<{
    id: string
    identity: string
    meta?: AgentThreadMeta
  } | null>(null)
  const attachmentPasteInProgressRef = useRef(false)
  const setMentionSuggestionOpen = useCallback((open: boolean) => {
    mentionSuggestionOpenRef.current = open
  }, [])
  const addPendingFiles = useCallback((files: WelcomePendingFile[]) => {
    const result = validatePendingAttachmentBatch(pendingFilesRef.current, files)
    if (result.accepted.length > 0) {
      const next = [...pendingFilesRef.current, ...result.accepted]
      pendingFilesRef.current = next
      setPendingFiles(next)
      toast.success(`已添加 ${result.accepted.length} 个附件`)
    }
    result.rejected.forEach(({ attachment, reason }) => {
      if (attachment.stagedAttachmentId) void abortStagedAttachment(attachment.stagedAttachmentId).catch(() => undefined)
      toast.error(`${attachment.filename}：${pendingAttachmentRejectionMessage(reason)}`)
    })
  }, [])
  const removePendingFile = useCallback((index: number) => {
    const removed = pendingFilesRef.current[index]
    if (removed?.stagedAttachmentId) void abortStagedAttachment(removed.stagedAttachmentId).catch(() => undefined)
    const next = pendingFilesRef.current.filter((_, itemIndex) => itemIndex !== index)
    pendingFilesRef.current = next
    setPendingFiles(next)
  }, [])

  useEffect(() => () => {
    pendingFilesRef.current.forEach((file) => {
      if (file.stagedAttachmentId) void abortStagedAttachment(file.stagedAttachmentId).catch(() => undefined)
    })
  }, [])

  useEffect(() => {
    workspaceSlugRef.current = workspaceSlug
  }, [workspaceSlug])

  const getWorkspaceSlug = () => workspaceSlugRef.current
  const slashCommandExecuteRef = useRef<(id: string) => void>(() => undefined)
  const executeSlashCommand = useCallback((id: string) => slashCommandExecuteRef.current(id), [])
  const handleCapabilityReferencePaste = createCapabilityReferencePasteHandler('__welcome__', getWorkspaceSlug)

  const editor = useEditor({
    extensions: createPromptEditorExtensions({
      placeholder: '描述你想完成的任务，使用 @ 引用已连接账户…',
      agentSuggestion: createSuggestionRenderer('@', '__welcome__', '@', getWorkspaceSlug, setMentionSuggestionOpen),
      capabilitySuggestion: createSuggestionRenderer('/', '__welcome__', '/', getWorkspaceSlug, setMentionSuggestionOpen, executeSlashCommand),
    }),
    editorProps: {
      attributes: { class: 'outline-none min-h-[80px] max-h-[200px] overflow-y-auto text-[14px] leading-relaxed' },
      handlePaste(view, event) {
        if (extractClipboardFiles(event.clipboardData).length > 0 && sendingRef.current) {
          event.preventDefault()
          toast.error('消息正在提交，请稍后粘贴附件')
          return true
        }
        if (handleAttachmentPaste(event, {
          existingAttachments: pendingFilesRef.current,
          onStart: () => { attachmentPasteInProgressRef.current = true },
          onAttachments: (attachments) => {
            addPendingFiles(attachments)
          },
          onError: (error) => {
            console.error('[WelcomeView] 粘贴附件失败:', error)
            toast.error('粘贴附件失败')
          },
          onRejected: (items) => items.forEach(({ file, reason }) => {
            toast.error(`${file.name || '剪贴板文件'}：${pendingAttachmentRejectionMessage(reason)}`)
          }),
          onSettled: () => { attachmentPasteInProgressRef.current = false },
        })) return true

        return handleCapabilityReferencePaste(view, event)
      },
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
      try {
        localStorage.setItem(draftStorageKeyRef.current, JSON.stringify({
          revision: Date.now(),
          doc: editor.getJSON(),
        }))
      } catch {
        // Draft persistence is best effort; the editor remains authoritative.
      }
    },
  })

  useEffect(() => {
    if (!editor) return
    draftStorageKeyRef.current = draftStorageKey
    try {
      const stored = localStorage.getItem(draftStorageKey)
      if (!stored) {
        editor.commands.clearContent()
        setEditorText('')
        return
      }
      const parsed = JSON.parse(stored) as { doc?: unknown }
      if (!parsed.doc) return
      editor.commands.setContent(parsed.doc as Parameters<typeof editor.commands.setContent>[0])
      setEditorText(editor.getText())
    } catch {
      localStorage.removeItem(draftStorageKey)
    }
  }, [draftStorageKey, editor])

  useEffect(() => {
    if (!editor || !welcomePromptSeed) return
    editor.commands.clearContent()
    if (welcomeCapabilitySeed && welcomePromptSeed.startsWith(welcomeCapabilitySeed.uri)) {
      editor.commands.insertContent({
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            {
              type: 'capabilityMention',
              attrs: {
                id: welcomeCapabilitySeed.uri,
                label: welcomeCapabilitySeed.label,
                uri: welcomeCapabilitySeed.uri,
                occurrenceId: crypto.randomUUID(),
                kind: welcomeCapabilitySeed.kind,
                iconUrl: welcomeCapabilitySeed.iconUrl ?? null,
              },
            },
            { type: 'text', text: welcomePromptSeed.slice(welcomeCapabilitySeed.uri.length) },
          ],
        }],
      })
    } else {
      editor.commands.insertContent(welcomePromptSeed)
    }
    editor.commands.focus('end')
    setWelcomeCapabilitySeed(null)
    setWelcomePromptSeed(null)
  }, [editor, setWelcomeCapabilitySeed, setWelcomePromptSeed, welcomeCapabilitySeed, welcomePromptSeed])

  const handleWelcomeSuggestionSelect = useCallback((prompt: string) => {
    setWelcomeCapabilitySeed(null)
    if (!editor) {
      setWelcomePromptSeed(prompt)
      return
    }
    editor.commands.clearContent()
    editor.commands.insertContent(prompt)
    editor.commands.focus('end')
  }, [editor, setWelcomeCapabilitySeed, setWelcomePromptSeed])

  const handleSend = async () => {
    if (!editor || sending) return
    if (attachmentPasteInProgressRef.current) {
      toast.info('正在读取粘贴的附件，请稍候')
      return
    }
    const serialized = serializeAgentEditorMessage(editor.getJSON())
    const rawText = serialized.userMessage
    if (!rawText && pendingFiles.length === 0) return
    const text = rawText || '请解读这些附件。'

    setSending(true)
    try {
      let desktopContextTargetForSend = selectedDesktopContextTarget
      if (desktopContextTargetForSend) {
        const state = await refreshAgentInputDesktopContextState(sidecarCall, desktopContextTargetForSend)
        if (state.status !== 'ready') {
          setDesktopContextCaptureMessage(state.message)
          setDesktopContextPermissionRequestAvailable(state.permissionRequestAvailable === true)
          toast.error(`当前应用上下文刷新失败：${state.message}`)
          return
        }
        desktopContextTargetForSend = state.target
        setSelectedDesktopContextTarget(state.target)
      }

      const submissionIdentity = JSON.stringify({
        userMessage: text,
        messageParts: serialized.messageParts,
        attachments: pendingFiles.map(({ id, filename, mediaType, size }) => ({ id, filename, mediaType, size })),
        selectedWorkspaceId,
        modelRef,
        channelId,
        modelId,
        permissionMode,
        thinkingLevel,
        desktopContextSnapshotId: desktopContextTargetForSend?.snapshotId,
      })
      if (
        pendingWelcomeSubmissionRef.current
        && pendingWelcomeSubmissionRef.current.identity !== submissionIdentity
      ) {
        const previousAttempt = pendingWelcomeSubmissionRef.current
        const aborted = await sidecarCall<{ ok: true; aborted: boolean }>(AGENT_IPC_CHANNELS.ABORT_SUBMISSION, {
          clientSubmissionId: pendingWelcomeSubmissionRef.current.id,
        }).catch(() => undefined)
        if (aborted?.aborted && previousAttempt.meta) {
          await sidecarCall(AGENT_IPC_CHANNELS.DELETE_THREAD, { threadId: previousAttempt.meta.id })
            .catch(() => undefined)
        }
        pendingWelcomeSubmissionRef.current = null
      }
      const attempt = pendingWelcomeSubmissionRef.current?.identity === submissionIdentity
        ? pendingWelcomeSubmissionRef.current
        : { id: crypto.randomUUID(), identity: submissionIdentity }
      pendingWelcomeSubmissionRef.current = attempt
      const clientSubmissionId = attempt.id

      const meta = attempt.meta ?? await sidecarCall<AgentThreadMeta>(AGENT_IPC_CHANNELS.CREATE_THREAD, {
          workspaceId: selectedWorkspaceId ?? undefined,
          modelRef,
          channelId,
          modelId,
        })
      attempt.meta = meta

      // Seed the per-thread override before the message page mounts. Otherwise
      // its config/plan-phase effects can briefly apply the global default.
      setThreadPermissionModes((prev) => ({ ...prev, [meta.id]: permissionMode }))

      let messageAttachments: AgentMessageAttachmentInput[] = []
      if (pendingFiles.length > 0) {
        const savedFiles = await sidecarCall<AgentSavedFile[]>(AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD, {
          threadId: meta.id,
          workspaceSlug,
          clientSubmissionId,
          files: pendingFiles.map((file) => ({
            id: file.id,
            filename: file.filename,
            mediaType: file.mediaType,
            size: file.size,
            ...(file.sourcePath ? { sourcePath: file.sourcePath } : {}),
            ...(file.data ? { data: file.data } : {}),
            ...(file.stagedAttachmentId ? { stagedAttachmentId: file.stagedAttachmentId } : {}),
          })),
        })
        messageAttachments = pendingFiles.map((file, index) => {
          const saved = savedFiles.find((savedFile) => savedFile.id === file.id) ?? savedFiles[index]
          return {
            id: file.id,
            filename: file.filename,
            mediaType: saved?.mediaType ?? file.mediaType,
            size: saved?.size ?? file.size,
            ...(saved?.contentHash ? { contentHash: saved.contentHash } : {}),
            threadPath: saved?.threadPath ?? file.filename,
            ...(saved?.ref ? { fileRef: saved.ref } : {}),
          }
        })
      }

      await agentSend({
        threadId: meta.id,
        userMessage: text,
        clientSubmissionId,
        ...(serialized.messageParts.some((part) => part.type === 'capability_ref' || part.type === 'link_connection_ref')
          ? { messageParts: serialized.messageParts }
          : {}),
        thinkingLevel,
        permissionMode,
        ...(messageAttachments.length > 0 ? { messageAttachments } : {}),
        ...(desktopContextTargetForSend
          ? { messageMetadata: createDesktopContextMessageMetadata(desktopContextTargetForSend) }
          : {}),
        ...(selectedWorkspaceId ? { workspaceId: selectedWorkspaceId } : {}),
      } as any)
      pendingWelcomeSubmissionRef.current = null

      setTabs((prev) => {
        const withoutWelcome = prev.filter((t) => t.id !== '__welcome__')
        return [
          {
            id: meta.id,
            type: 'agent' as const,
            title: meta.title,
            threadId: meta.id,
            workspaceId: meta.workspaceId,
            ...(desktopContextTargetForSend ? { desktopContextTarget: desktopContextTargetForSend } : {}),
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

      editor.commands.clearContent()
      setEditorText('')
      localStorage.removeItem(draftStorageKey)
      pendingFilesRef.current.forEach((file) => {
        if (file.stagedAttachmentId) void abortStagedAttachment(file.stagedAttachmentId).catch(() => undefined)
      })
      pendingFilesRef.current = []
      setPendingFiles([])
      onThreadCreated?.(meta)
    } catch (err) {
      console.error('[WelcomeView] 发送失败:', err)
      toast.error('发送失败，请重试')
      if (isTerminalAgentSubmissionError(err)) {
        const failedAttempt = pendingWelcomeSubmissionRef.current
        pendingWelcomeSubmissionRef.current = null
        if (failedAttempt?.meta) {
          await sidecarCall(AGENT_IPC_CHANNELS.DELETE_THREAD, { threadId: failedAttempt.meta.id })
            .catch(() => undefined)
        }
      }
    } finally {
      setSending(false)
    }
  }

  const handleAttach = async () => {
    try {
      const result = await openFileDialog()
      if (result.files.length === 0) return
      addPendingFiles(result.files.map((file) => {
          const mediaType = file.mediaType || 'application/octet-stream'
          return {
            id: file.id || createWelcomePendingFileId(),
            filename: file.filename,
            mediaType,
            size: file.size,
            ...(file.stagedAttachmentId
              ? { stagedAttachmentId: file.stagedAttachmentId }
              : { sourcePath: file.sourcePath }),
            ...(isImageAttachment({ filename: file.filename, mediaType }) && file.previewUrl
              ? { previewUrl: file.previewUrl }
              : {}),
          }
        }))
    } catch (err) {
      console.error('[WelcomeView] 文件选择失败:', err)
      toast.error('文件选择失败')
    }
  }

  slashCommandExecuteRef.current = (id: string) => {
    if (id !== 'reload-plugins') return
    if (
      editor?.getText().trim() !== '/reload-plugins'
      || pendingFiles.length > 0
      || Boolean(selectedDesktopContextTarget)
    ) {
      toast.error('请先清空正文、附件和当前应用上下文，再执行该动作')
      return
    }
    editor.commands.clearContent()
    setEditorText('')
    void sidecarCall(AGENT_IPC_CHANNELS.RELOAD_PLUGINS, {})
      .then(() => toast.success('插件已重新加载'))
      .catch(() => toast.error('重载插件失败'))
  }

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
      if (desktopPermissionRequestCompleted(result)) {
        setDesktopContextPermissionRequestAvailable(false)
      }
      toast.success(desktopPermissionRequestToastMessage(result))
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

  const handleSelectWorkspace = (wsId: string | null) => {
    setSelectedWorkspaceId(wsId)
    setCurrentWorkspaceId(wsId)
    setTabs((prev) =>
      prev.map((t) =>
        t.id === '__welcome__' ? { ...t, workspaceId: wsId ?? undefined } : t
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

  const hasText = editorText.trim().length > 0 || pendingFiles.length > 0

  return (
    <>
      <LumeWelcomeSurface
        compact={compact}
        model={welcomeSurfaceModel}
        workspaceSelector={
          <WorkspaceSelector
            workspaces={workspaces}
            selectedId={selectedWorkspaceId}
            onSelect={handleSelectWorkspace}
            onCreateWorkspaceClick={() => setCreateWorkspaceOpen(true)}
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
        desktopContextTarget={capturedDesktopContextTarget}
        selectedDesktopContextTarget={selectedDesktopContextTarget}
        desktopContextCaptureLoading={desktopContextCaptureLoading}
        desktopContextCaptureMessage={desktopContextCaptureMessage}
        desktopContextPermissionRequestAvailable={desktopContextPermissionRequestAvailable}
        desktopContextPermissionRequestLoading={desktopContextPermissionRequestLoading}
        onRequestDesktopContextPermissions={handleRequestDesktopContextPermissions}
        onSelectDesktopContextTarget={setSelectedDesktopContextTarget}
        onClearDesktopContextTarget={() => setSelectedDesktopContextTarget(undefined)}
        suggestions={!hasText && !selectedDesktopContextTarget ? welcomeSuggestions : []}
        onSuggestionSelect={handleWelcomeSuggestionSelect}
        onRemovePendingFile={removePendingFile}
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

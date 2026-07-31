import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import { cn } from '@/lib/utils'
import { Send, Square, FileText, Plus, LoaderCircle, MessageSquareText, MonitorOff, Globe, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  agentSend,
  getThreadMessages,
  isTerminalAgentSubmissionError,
  listAgentMessageQueue,
  onSidecarEvent,
  openFileDialog,
  promoteQueuedAgentMessageToGuidance,
  removeQueuedAgentMessage,
  reorderAgentMessageQueue,
  sidecarCall,
  updateQueuedAgentMessage,
} from '@/lib/desktop-api'
import { invoke } from '@/lib/desktop-runtime/core'
import { listChannels } from '@/lib/desktop-api/channel'
import { activeTabIdAtom, agentBrowserAttachmentsAtom, agentBrowserAttachmentsFamily, agentDiffCommentDraftsAtom, agentDiffCommentDraftsFamily, agentInputDraftAtom, agentInputDraftFamily, agentInputHistoryAtom, agentInputHistoryFamily, agentMessageQueueAtom, agentPlanModePhaseFamily, agentRuntimeEventsAtom, agentRuntimeEventsFamily, agentStreamingStatesAtom, agentThreadPermissionModesAtom, agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, settingsInitialTabAtom, tabsAtom } from '@/atoms'
import { isEmptyDraft, prependHistory, removeDraft, upsertDraft, type AgentInputDraftJSON } from '@/lib/agent-input-draft-state'
import { debounce } from 'throttle-debounce'
import {
  AGENT_IPC_CHANNELS,
  DESKTOP_CONTEXT_IPC_CHANNELS,
  LUME_CONFIG_IPC_CHANNELS,
  type AgentMessage,
  type AgentBrowserAttachment,
  type AgentBrowserTabAttachment,
  type AgentMessageAttachmentInput,
  type AgentDiffCommentAttachment,
  type AgentSavedFile,
  type Channel,
  type DesktopContextTarget,
  type LumeConfigAgentDefaultStrategy,
  type LumeEffectiveConfig,
  type LumeConfigThinkingLevel,
  type LumeRuntimeEvent,
  type AgentQueuedMessage,
  type BrowserTabDescriptor,
} from '@lume/shared'
import { appendRuntimeEvent } from '@/hooks/runtime-event-state'
import { useModelMetaVersion } from '@/lib/model-meta-context'
import { MentionList } from './MentionList'
import { serializeAgentEditorMessage } from './agent-editor-message-parts'
import { ModelPicker } from './ModelPicker'
import { PermissionModePicker } from './PermissionModePicker'
import { ThinkingLevelPicker } from './ThinkingLevelPicker'
import type { MentionListRef } from './MentionList'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import { getEffectiveLumeConfig, updateAgentThinkingLevel } from '@/lib/desktop-api/lume-config'
import { getLumeComposerPrimaryActionClassName, LumeComposer } from '@/components/composer/LumeComposer'
import { deriveLumeComposerState } from '@/components/composer/lume-composer-state'
import type { PermissionModeValue } from '@/components/settings/agent-settings-state'
import { cancelPendingDebouncedAgentInputSend, createDebouncedAgentInputSend } from './agent-input-send-debounce'
import { pendingAttachmentRejectionMessage } from './pending-attachment-validation'
import {
  deriveAgentInputSubmitState,
  resolveAgentInputConfigWorkspaceSlug,
  resolveNextActiveIndex,
  shouldReleaseAgentInputLocalSendingAfterDispatch,
  shouldSendAgentInputOnEnter,
  syncPermissionModeWithDefaultConfig,
  syncPermissionModeWithPlanModePhase,
} from './agent-input-state'
import { AgentMessageQueueList } from './AgentMessageQueueList'
import {
  createEmptyAgentMessageQueueSnapshot,
  reorderQueuedMessages,
  startEditingQueuedMessage,
  upsertAgentMessageQueueSnapshot,
} from './agent-message-queue-state'
import { type MentionItem } from './slash-command-state'
import { createCapabilityReferencePasteHandler, createSuggestionRenderer } from './editor-mention-suggestions'
import { createPromptEditorExtensions } from './prompt-editor-extensions'
import { extractClipboardFiles, handleAttachmentPaste } from './editor-attachment-paste'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { buildContextWindowProgress } from './runtime-state-projections'
import { ContextWindowIndicator } from './ContextWindowIndicator'
import { getThreadSelectionSummary } from '@/components/model-selection/model-selection-state'
import {
  applyAgentRoleMentions,
  buildAgentRoleMentionItems,
} from './agent-input-role-recommendations'
import { isImageAttachment } from './AgentAttachmentGrid'
import { PendingAttachmentList } from './PendingAttachmentList'
import { DesktopContextPlusItem } from './DesktopContextPlusItem'
import { DesktopContextSelectionChip } from './DesktopContextSelectionChip'
import {
  captureAgentInputDesktopContextState,
  desktopPermissionRequestCompleted,
  desktopPermissionRequestMessage,
  desktopPermissionRequestToastMessage,
  refreshAgentInputDesktopContextState,
  resolveAgentInputDesktopContextView,
  resolveAgentInputDesktopMessageMetadata,
} from './agent-input-desktop-context'
import { resolveOpenDesktopAssistantSettingsState } from './agent-input-desktop-settings'

import { Button } from '@/components/ui/button'
interface AgentInputProps {
  threadId: string
  streaming?: boolean
  pendingAttachments?: PendingMessageAttachment[]
  onAddPendingAttachments?: (attachments: PendingMessageAttachment[]) => void
  onRemovePendingAttachment?: (id: string) => void
  onClearPendingAttachments?: () => void
  messageMetadata?: Record<string, unknown>
  onMessageMetadataConsumed?: () => void
  desktopContextTarget?: DesktopContextTarget
  onSelectDesktopContextTarget?: (target: DesktopContextTarget) => void
  onClearDesktopContextTarget?: () => void
}

export interface PendingMessageAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath?: string
  data?: string
  stagedAttachmentId?: string
  previewUrl?: string
}

/** 占位：AgentInput 中 @ 文件 + @agent 的建议逻辑仍保留在此 */
async function fetchAgentAndFileSuggestions(
  query: string,
  threadId: string,
): Promise<MentionItem[]> {
  const agentItems = buildAgentRoleMentionItems(query)
  try {
    const result = await sidecarCall(AGENT_IPC_CHANNELS.LIST_DIRECTORY, { threadId, path: '.' }) as {
      entries: Array<{ name: string; type: string }>
    }
    const entries = result?.entries ?? []
    const fileItems = entries
      .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 10)
      .map((e) => ({
        id: e.name,
        label: e.name,
        type: 'file' as const,
        section: 'file' as const,
      }))
    return [...agentItems, ...fileItems]
  } catch {
    return agentItems
  }
}

/** AgentInput 专用的 @ suggestion renderer（包含 agent + 文件） */
function createAgentSuggestionRenderer(
  threadId: string,
  _getWorkspaceSlug: () => string | null,
  setSuggestionOpen: (open: boolean) => void,
  onEscape?: () => void,
) {
  return {
    char: '@',
    items: ({ query }: { query: string }) => fetchAgentAndFileSuggestions(query, threadId),
    render: () => {
      let component: ReactRenderer<MentionListRef> | null = null
      let wrapper: HTMLDivElement | null = null

      return {
        onStart: (props: SuggestionProps) => {
          setSuggestionOpen(true)
          wrapper = document.createElement('div')
          wrapper.style.position = 'fixed'
          wrapper.style.zIndex = '9999'
          document.body.appendChild(wrapper)

          component = new ReactRenderer(MentionList, {
            props: { ...props, trigger: '@' as const },
            editor: props.editor,
          })
          wrapper.appendChild(component.element)

          updateMentionPosition(wrapper, props)
        },

        onUpdate: (props: SuggestionProps) => {
          component?.updateProps(props)
          if (wrapper) updateMentionPosition(wrapper, props)
        },

        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === 'Escape') {
            setSuggestionOpen(false)
            wrapper?.remove()
            onEscape?.()
            return true
          }
          return component?.ref?.onKeyDown(props) ?? false
        },

        onExit: () => {
          setSuggestionOpen(false)
          component?.destroy()
          wrapper?.remove()
        },
      }
    },
  }
}

function updateMentionPosition(wrapper: HTMLDivElement, props: SuggestionProps) {
  const rect = props.clientRect?.()
  if (!rect) return
  const estimatedWidth = 360
  const safeLeft = Math.min(rect.left, window.innerWidth - estimatedWidth - 16)
  wrapper.style.left = `${Math.max(12, safeLeft)}px`
  wrapper.style.width = ''
  wrapper.style.bottom = `${window.innerHeight - rect.top + 4}px`
  wrapper.style.top = 'auto'
}

export function AgentInput({
  threadId,
  streaming = false,
  pendingAttachments = [],
  onAddPendingAttachments = () => undefined,
  onRemovePendingAttachment = () => undefined,
  onClearPendingAttachments = () => undefined,
  messageMetadata,
  onMessageMetadataConsumed = () => undefined,
  desktopContextTarget,
  onSelectDesktopContextTarget,
  onClearDesktopContextTarget,
}: AgentInputProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const thread = threads.find((item) => item.id === threadId)
  const planModePhase = useAtomValue(agentPlanModePhaseFamily(threadId))
  const runtimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const [messageQueues, setMessageQueues] = useAtom(agentMessageQueueAtom)
  const [threadPermissionModes, setThreadPermissionModes] = useAtom(agentThreadPermissionModesAtom)
  const [tabs, setTabs] = useAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setSettingsInitialTab = useSetAtom(settingsInitialTabAtom)
  const workspaceIdRef = useRef<string | null>(null)
  const workspaceSlugRef = useRef<string | null>(null)
  const defaultPermissionModeRef = useRef<PermissionModeValue>('default')
  const threadPermissionModesRef = useRef(threadPermissionModes)
  const autoSelectedPlanModeRef = useRef(false)
  const [thinkingLevel, setThinkingLevel] = useState<LumeConfigThinkingLevel>('off')
  const [permissionMode, setPermissionMode] = useState<PermissionModeValue>('default')
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsLoaded, setChannelsLoaded] = useState(false)
  const [defaultStrategy, setDefaultStrategy] = useState<LumeConfigAgentDefaultStrategy>({})
  const [editorText, setEditorText] = useState('')
  const draft = useAtomValue(agentInputDraftFamily(threadId))
  const commentAttachments: AgentDiffCommentAttachment[] = useAtomValue(agentDiffCommentDraftsFamily(threadId)) ?? []
  const setCommentDrafts = useSetAtom(agentDiffCommentDraftsAtom)
  const browserAttachments: AgentBrowserAttachment[] = useAtomValue(agentBrowserAttachmentsFamily(threadId)) ?? []
  const setBrowserAttachments = useSetAtom(agentBrowserAttachmentsAtom)
  const setDraftState = useSetAtom(agentInputDraftAtom)
  const isNavigatingHistoryRef = useRef(false) // true = 当前编辑器内容由程序填充（恢复/回溯），不应存为草稿
  const historyIndexRef = useRef(-1) // -1 = 未回溯（显示草稿）；0..n = 回溯到 history[index]
  const navigateHistoryRef = useRef<(dir: 1 | -1) => void>(() => {})
  const resetToDraftRef = useRef<() => void>(() => {})
  const draftRef = useRef(draft)
  draftRef.current = draft
  const history = useAtomValue(agentInputHistoryFamily(threadId)) ?? []
  const setHistoryState = useSetAtom(agentInputHistoryAtom)
  const historyRef = useRef(history)
  historyRef.current = history

  useEffect(() => {
    const addBrowserTab = (event: Event) => {
      const descriptor = (event as CustomEvent<BrowserTabDescriptor>).detail
      if (!descriptor?.tabId || !descriptor.providerTabId || !descriptor.url) return
      if (descriptor.ownerThreadId && descriptor.ownerThreadId !== threadId) return
      const attachment: AgentBrowserTabAttachment = {
        id: `browser-tab:${descriptor.providerTabId}:${descriptor.generation}`,
        origin: 'browser-tab',
        tabId: descriptor.tabId,
        providerTabId: descriptor.providerTabId,
        title: descriptor.title || descriptor.url,
        url: descriptor.url,
        generation: descriptor.generation,
        ...(descriptor.ownerThreadId ? { ownerThreadId: descriptor.ownerThreadId } : {}),
      }
      setBrowserAttachments((current) => {
        const existing = current[threadId] ?? []
        return {
          ...current,
          [threadId]: [...existing.filter((item) => item.id !== attachment.id && !(item.origin === 'browser-tab' && item.tabId === attachment.tabId)), attachment],
        }
      })
    }
    window.addEventListener('lume:add-browser-tab-to-chat', addBrowserTab)
    const addBrowserAttachment = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; attachment?: AgentBrowserAttachment }>).detail
      if (!detail?.attachment || (detail.threadId && detail.threadId !== threadId)) return
      setBrowserAttachments((current) => ({
        ...current,
        [threadId]: [...(current[threadId] ?? []).filter((item) => item.id !== detail.attachment!.id), detail.attachment!],
      }))
    }
    window.addEventListener('lume:add-browser-attachment-to-chat', addBrowserAttachment)
    return () => {
      window.removeEventListener('lume:add-browser-tab-to-chat', addBrowserTab)
      window.removeEventListener('lume:add-browser-attachment-to-chat', addBrowserAttachment)
    }
  }, [setBrowserAttachments, threadId])
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    destructive: boolean
    onConfirm: () => void
  }>({ open: false, title: '', description: '', confirmLabel: '确认', destructive: false, onConfirm: () => {} })
  const [localSending, setLocalSending] = useState(false)
  const localSendingRef = useRef(localSending)
  localSendingRef.current = localSending
  const [editingQueuedMessage, setEditingQueuedMessage] = useState<{
    item: AgentQueuedMessage
    expectedRevision: number
    previousDraft: AgentInputDraftJSON | undefined
  } | null>(null)
  const editingQueuedMessageRef = useRef(editingQueuedMessage)
  editingQueuedMessageRef.current = editingQueuedMessage
  const [historyMessages, setHistoryMessages] = useState<AgentMessage[]>([])
  const mentionSuggestionOpenRef = useRef(false)
  const [plusPanelOpen, setPlusPanelOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [capturedDesktopContextTarget, setCapturedDesktopContextTarget] = useState<DesktopContextTarget | undefined>()
  const [desktopContextCaptureMessage, setDesktopContextCaptureMessage] = useState<string | undefined>()
  const [desktopContextCaptureLoading, setDesktopContextCaptureLoading] = useState(false)
  const [desktopContextPermissionRequestAvailable, setDesktopContextPermissionRequestAvailable] = useState(false)
  const [desktopContextPermissionRequestLoading, setDesktopContextPermissionRequestLoading] = useState(false)
  const [localDesktopContextTarget, setLocalDesktopContextTarget] = useState<DesktopContextTarget | undefined>()
  const sendNowRef = useRef<() => void>(() => undefined)
  const stopNowRef = useRef<() => void>(() => undefined)
  const lastEscapeAtRef = useRef(0)
  const pendingSubmissionRef = useRef<{ id: string; identity: string } | null>(null)
  const cancelQueueEditRef = useRef<() => void>(() => undefined)
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  const addPendingAttachmentsRef = useRef(onAddPendingAttachments)
  addPendingAttachmentsRef.current = onAddPendingAttachments
  const pendingAttachmentsRef = useRef(pendingAttachments)
  pendingAttachmentsRef.current = pendingAttachments
  const attachmentPasteInProgressRef = useRef(false)
  const debouncedSend = useMemo(
    () => createDebouncedAgentInputSend(() => { sendNowRef.current() }),
    [threadId],
  )
  const configWorkspaceSlug = useMemo(() => resolveAgentInputConfigWorkspaceSlug({
    threadWorkspaceId: thread?.workspaceId,
    currentWorkspaceId,
    workspaces,
  }), [currentWorkspaceId, thread?.workspaceId, workspaces])
  const messageQueueSnapshot = messageQueues[threadId] ?? createEmptyAgentMessageQueueSnapshot(threadId)
  const desktopContextView = resolveAgentInputDesktopContextView({
    propTarget: desktopContextTarget,
    capturedTarget: capturedDesktopContextTarget,
    localTarget: localDesktopContextTarget,
    captureLoading: desktopContextCaptureLoading,
    captureMessage: desktopContextCaptureMessage,
  })
  const availableDesktopContextTarget = desktopContextView.plusPanelTarget
  const selectedDesktopContextTarget = desktopContextView.selectedTarget
  const effectiveMessageMetadata = useMemo(() => resolveAgentInputDesktopMessageMetadata({
    propTarget: desktopContextTarget,
    localTarget: localDesktopContextTarget,
    messageMetadata,
  }), [desktopContextTarget, localDesktopContextTarget, messageMetadata])

  const saveDraft = useCallback((json: AgentInputDraftJSON | undefined) => {
    setDraftState((prev) =>
      isEmptyDraft(json) ? removeDraft(prev, threadId) : upsertDraft(prev, threadId, json as AgentInputDraftJSON),
    )
  }, [setDraftState, threadId])

  const clearDraftState = useCallback(() => {
    setDraftState((prev) => removeDraft(prev, threadId))
  }, [setDraftState, threadId])

  const pushHistoryEntry = useCallback(
    (json: AgentInputDraftJSON) => {
      setHistoryState((prev) => prependHistory(prev, threadId, json))
    },
    [setHistoryState, threadId],
  )

  // 防抖写草稿，避免每次按键写 localStorage
  const debouncedSaveDraft = useMemo(
    () => debounce(400, (json: AgentInputDraftJSON | undefined) => saveDraft(json)),
    [saveDraft],
  )

  const applyEffectiveConfig = useCallback((config: LumeEffectiveConfig) => {
    const nextDefaultPermissionMode = config.agent?.permissionMode ?? 'default'
    defaultPermissionModeRef.current = nextDefaultPermissionMode
    setPermissionMode((current) => {
      const next = syncPermissionModeWithDefaultConfig({
        currentPermissionMode: current,
        nextDefaultPermissionMode,
        threadPermissionMode: threadPermissionModesRef.current[threadId],
        planPhase: planModePhase?.phase,
        autoSelectedPlan: autoSelectedPlanModeRef.current,
      })
      autoSelectedPlanModeRef.current = next.autoSelectedPlan
      return next.permissionMode
    })
    if (config.agent?.thinkingLevel) {
      setThinkingLevel(config.agent.thinkingLevel)
    }
    setDefaultStrategy(config.models?.agent ?? {})
  }, [planModePhase?.phase, threadId])

  useEffect(() => {
    threadPermissionModesRef.current = threadPermissionModes
  }, [threadPermissionModes])

  useEffect(() => {
    autoSelectedPlanModeRef.current = false
    setPermissionMode(threadPermissionModes[threadId] ?? defaultPermissionModeRef.current)
  }, [threadId, threadPermissionModes])

  useEffect(() => {
    listChannels()
      .then((items) => setChannels(items))
      .catch(console.error)
      .finally(() => setChannelsLoaded(true))
  }, [])

  useEffect(() => {
    let cancelled = false
    getEffectiveLumeConfig(configWorkspaceSlug)
      .then((config) => {
        if (!cancelled) applyEffectiveConfig(config)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [applyEffectiveConfig, configWorkspaceSlug])

  useEffect(() => {
    let cancelled = false
    const unlisten = onSidecarEvent((method) => {
      if (method !== LUME_CONFIG_IPC_CHANNELS.CHANGED) return
      getEffectiveLumeConfig(configWorkspaceSlug)
        .then((config) => {
          if (!cancelled) applyEffectiveConfig(config)
        })
        .catch(() => {})
    })
    return () => {
      cancelled = true
      unlisten.then((fn) => fn())
    }
  }, [applyEffectiveConfig, configWorkspaceSlug])

  useEffect(() => {
    setPermissionMode((current) => {
      const threadPermissionMode = threadPermissionModes[threadId]
      if (threadPermissionMode) {
        autoSelectedPlanModeRef.current = false
        return threadPermissionMode
      }
      const next = syncPermissionModeWithPlanModePhase({
        permissionMode: current,
        defaultPermissionMode: defaultPermissionModeRef.current,
        planPhase: planModePhase?.phase,
        autoSelectedPlan: autoSelectedPlanModeRef.current,
      })
      autoSelectedPlanModeRef.current = next.autoSelectedPlan
      return next.permissionMode
    })
  }, [planModePhase?.phase, threadId, threadPermissionModes])

  useEffect(() => {
    const targetId = thread?.workspaceId ?? currentWorkspaceId
    const ws = workspaces.find((w) => w.id === targetId)
    workspaceIdRef.current = ws?.id ?? null
    workspaceSlugRef.current = ws?.slug ?? null
  }, [thread?.workspaceId, workspaces, currentWorkspaceId])

  useEffect(() => {
    if (!streaming) setLocalSending(false)
  }, [streaming, threadId])

  useEffect(() => {
    let cancelled = false
    setHistoryMessages([])
    getThreadMessages(threadId)
      .then((messages) => {
        if (!cancelled) setHistoryMessages(messages)
      })
      .catch((error) => {
        if (!cancelled) console.error('[AgentInput] 加载线程上下文估算消息失败:', error)
      })
    return () => {
      cancelled = true
    }
  }, [threadId])

  useEffect(() => {
    let cancelled = false
    listAgentMessageQueue({ threadId })
      .then((snapshot) => {
        if (!cancelled) {
          setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, snapshot))
        }
      })
      .catch((error) => {
        if (!cancelled) console.error('[AgentInput] 加载消息队列失败:', error)
      })
    return () => {
      cancelled = true
    }
  }, [setMessageQueues, threadId])

  const getWorkspaceSlug = () => workspaceSlugRef.current
  const setMentionSuggestionOpen = useCallback((open: boolean) => {
    mentionSuggestionOpenRef.current = open
  }, [])

  const slashCommandExecuteRef = useRef<(id: string) => void>(() => {})
  const handleSlashCommandExecuteStable = useCallback((id: string) => {
    slashCommandExecuteRef.current(id)
  }, [])
  const handleLocalSuggestionEscape = useCallback(() => {
    if (!streamingRef.current) return
    lastEscapeAtRef.current = Date.now()
    toast.info('再次按 Esc 停止当前输出', { duration: 900 })
  }, [])
  const handleCapabilityReferencePaste = createCapabilityReferencePasteHandler(threadId, getWorkspaceSlug)

  const editor = useEditor({
    extensions: createPromptEditorExtensions({
      placeholder: '输入任务… 使用 / 选择动作、技能或插件，@ 引用 Agent 或文件',
      agentSuggestion: createAgentSuggestionRenderer(threadId, getWorkspaceSlug, setMentionSuggestionOpen, handleLocalSuggestionEscape),
      capabilitySuggestion: createSuggestionRenderer('/', threadId, '/', getWorkspaceSlug, setMentionSuggestionOpen, handleSlashCommandExecuteStable, handleLocalSuggestionEscape),
    }),
    editorProps: {
      attributes: {
        class:
          'outline-none min-h-[72px] max-h-[220px] overflow-y-auto text-[14px] leading-7 text-[var(--text-1)]',
      },
      handlePaste(view, event) {
        if (
          extractClipboardFiles(event.clipboardData).length > 0
          && (localSendingRef.current || editingQueuedMessageRef.current)
        ) {
          event.preventDefault()
          toast.error(editingQueuedMessageRef.current
            ? '编辑排队消息时暂不支持修改附件'
            : '消息正在提交，请稍后粘贴附件')
          return true
        }
        if (handleAttachmentPaste(event, {
          existingAttachments: pendingAttachmentsRef.current,
          onStart: () => { attachmentPasteInProgressRef.current = true },
          onAttachments: (attachments) => {
            addPendingAttachmentsRef.current(attachments)
          },
          onError: (error) => {
            console.error('[AgentInput] 粘贴附件失败:', error)
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
        if (shouldSendAgentInputOnEnter(event, mentionSuggestionOpenRef.current)) {
          event.preventDefault()
          debouncedSend()
          return true
        }
        if (!editor) return false
        const atFirstLine = editor.state.selection.empty && editor.state.selection.$from.pos === 0
        // ↑：空框或光标在首行时回溯到更旧
        if (event.key === 'ArrowUp' && (editor.isEmpty || atFirstLine)) {
          if (historyRef.current.length > 0) {
            event.preventDefault()
            navigateHistoryRef.current(1)
            return true
          }
        }
        // ↓：回溯中则走向更新
        if (event.key === 'ArrowDown' && historyIndexRef.current >= 0) {
          event.preventDefault()
          navigateHistoryRef.current(-1)
          return true
        }
        // Esc：直接回草稿
        if (event.key === 'Escape' && historyIndexRef.current >= 0) {
          event.preventDefault()
          resetToDraftRef.current()
          handleLocalSuggestionEscape()
          return true
        }
        if (event.key === 'Escape' && editingQueuedMessageRef.current) {
          event.preventDefault()
          cancelQueueEditRef.current()
          handleLocalSuggestionEscape()
          return true
        }
        if (event.key === 'Escape' && streamingRef.current && !mentionSuggestionOpenRef.current) {
          event.preventDefault()
          const now = Date.now()
          if (now - lastEscapeAtRef.current <= 800) {
            lastEscapeAtRef.current = 0
            stopNowRef.current()
          } else {
            lastEscapeAtRef.current = now
            toast.info('再次按 Esc 停止当前输出', { duration: 900 })
          }
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
      // 程序填充（回溯/恢复）用 setContent(..., { emitUpdate: false })，不会进此回调；
      // 进此回调即用户真实输入。
      if (isNavigatingHistoryRef.current) {
        isNavigatingHistoryRef.current = false
        historyIndexRef.current = -1 // 用户在回溯态手动输入 → 退出回溯
      }
      if (!editingQueuedMessageRef.current) debouncedSaveDraft(editor.getJSON())
    },
  })

  const finishQueueEdit = useCallback((restoreDraft: boolean) => {
    const editing = editingQueuedMessageRef.current
    if (!editor || !editing) return
    if (restoreDraft && editing.previousDraft && !isEmptyDraft(editing.previousDraft)) {
      editor.commands.setContent(editing.previousDraft, { emitUpdate: false })
    } else {
      editor.commands.clearContent(false)
    }
    setEditorText(editor.getText())
    setEditingQueuedMessage(null)
    queueMicrotask(() => editor.commands.focus('end'))
  }, [editor])
  cancelQueueEditRef.current = () => finishQueueEdit(true)

  // 草稿恢复：threadId 变化或 editor 就绪时，把存盘草稿填回编辑器
  useEffect(() => {
    if (!editor) return
    isNavigatingHistoryRef.current = true
    historyIndexRef.current = -1
    const json = draftRef.current
    try {
      if (json && !isEmptyDraft(json)) {
        editor.commands.setContent(json, { emitUpdate: false })
      } else {
        editor.commands.clearContent(false)
      }
    } catch {
      editor.commands.clearContent(false)
    }
    setEditorText(editor.getText())
    // 下一 tick 解除标志，让后续真实输入正常存草稿
    queueMicrotask(() => {
      isNavigatingHistoryRef.current = false
    })
  }, [threadId, editor])

  const hasComposerPayload = editorText.trim().length > 0
    || pendingAttachments.length > 0
    || commentAttachments.length > 0
    || browserAttachments.length > 0
  const submitState = deriveAgentInputSubmitState({
    hasText: hasComposerPayload,
    streaming,
    localSending,
  })
  const composerState = deriveLumeComposerState({
    hasText: hasComposerPayload,
    mode: localSending ? 'busy' : streaming && !hasComposerPayload ? 'streaming' : 'idle',
  })
  const modelMetaVersion = useModelMetaVersion()
  const selectedModelSummary = useMemo(() => getThreadSelectionSummary({
    channels,
    channelsLoaded,
    thread,
    defaultStrategy,
  }), [channels, channelsLoaded, thread, defaultStrategy, modelMetaVersion])
  const contextWindowProgress = buildContextWindowProgress(runtimeEvents, {
    contextWindow: selectedModelSummary.meta?.contextWindow,
    messages: historyMessages,
  })

  const doClear = useCallback(async () => {
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.CLEAR_THREAD, { threadId })
      setRuntimeEvents((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
      setMessageQueues((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      setCommentDrafts((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      setBrowserAttachments((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      toast.success('已清空对话')
    } catch (error) {
      console.error('[AgentInput] 清空对话失败:', error)
      toast.error('清空失败')
    }
  }, [threadId, setRuntimeEvents, setStreamingStates, setMessageQueues, setCommentDrafts, setBrowserAttachments])

  const handleSlashCommandExecute = useCallback((id: string) => {
    if (!editor) return
    const actionHasConflictingPayload = editor.getText().trim() !== `/${id}`
      || pendingAttachments.length > 0
      || commentAttachments.length > 0
      || browserAttachments.length > 0
      || Boolean(selectedDesktopContextTarget)
    if (actionHasConflictingPayload) {
      toast.error('请先清空正文、附件和当前应用上下文，再执行该动作')
      return
    }
    if (streaming) {
      toast.error('当前正在输出，请停止后再执行该动作')
      return
    }
    if (id === 'clear') {
      editor.commands.clearContent()
      setEditorText('')
      const title = threads.find((t) => t.id === threadId)?.title ?? '当前会话'
      setConfirmState({
        open: true,
        title: '清空当前对话',
        description: `将删除当前会话「${title}」的所有消息，此操作不可撤销。`,
        confirmLabel: '清空',
        destructive: true,
        onConfirm: () => { void doClear() },
      })
      return
    }
    if (id === 'reload-plugins') {
      editor.commands.clearContent()
      setEditorText('')
      void (async () => {
        try {
          await sidecarCall(AGENT_IPC_CHANNELS.RELOAD_PLUGINS, {})
          toast.success('插件已重新加载')
        } catch (error) {
          console.error('[AgentInput] 重载插件失败:', error)
          toast.error('重载插件失败')
        }
      })()
      return
    }
    if (id === 'compact') {
      editor.commands.clearContent()
      setEditorText('')
      setLocalSending(true)
      const createdAt = new Date().toISOString()
      const optimisticId = `optimistic:compact:${threadId}:${createdAt}`
      // optimistic：立即显示「正在压缩」，不等后端 compaction.started 事件到达。
      // 后端真实 compaction 事件到达后由 appendContextCompactionNotice 的 existing 分支合并到本条，不重复。
      setRuntimeEvents((prev) => appendRuntimeEvent(prev, {
        id: optimisticId,
        type: 'context.compaction.started',
        threadId,
        runId: optimisticId,
        createdAt,
        trigger: 'manual',
        preTokens: 0,
        policy: 'manual',
        source: 'manual',
      } as LumeRuntimeEvent))
      void (async () => {
        try {
          const result = await agentSend({
            threadId,
            userMessage: '/compact',
            clientSubmissionId: crypto.randomUUID(),
            messageMetadata: { hiddenFromChat: true, manualCommand: 'compact' },
            ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}),
          })
          if (shouldReleaseAgentInputLocalSendingAfterDispatch(result.mode)) {
            setLocalSending(false)
          }
          if (result.mode !== 'sent') {
            toast.success('已加入队列')
          }
        } catch (error) {
          console.error('[AgentInput] 压缩对话失败:', error)
          toast.error('压缩失败')
          setLocalSending(false)
        }
      })()
      return
    }
  }, [editor, threadId, threads, doClear, pendingAttachments.length, commentAttachments.length, browserAttachments.length, selectedDesktopContextTarget, streaming])

  slashCommandExecuteRef.current = handleSlashCommandExecute

  const handleSend = useCallback(async () => {
    if (!editor || localSending) return
    if (attachmentPasteInProgressRef.current) {
      toast.info('正在读取粘贴的附件，请稍候')
      return
    }
    const serialized = serializeAgentEditorMessage(editor.getJSON(), applyAgentRoleMentions)
    const rawText = serialized.userMessage
    if (!rawText && pendingAttachments.length === 0 && commentAttachments.length === 0 && browserAttachments.length === 0) return

    const queueEdit = editingQueuedMessageRef.current
    if (queueEdit) {
      setLocalSending(true)
      try {
        const result = await updateQueuedAgentMessage({
          threadId,
          queuedMessageId: queueEdit.item.id,
          expectedRevision: queueEdit.expectedRevision,
          queueOperationId: crypto.randomUUID(),
          userMessage: rawText,
          messageParts: serialized.messageParts,
        })
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
        if (!result.ok) {
          setEditingQueuedMessage((current) => current
            ? {
                ...current,
                expectedRevision: result.snapshot.revision,
                item: result.snapshot.queuedMessages.find((item) => item.id === current.item.id) ?? current.item,
              }
            : current)
          toast.error('队列已发生变化，请基于最新内容重新保存')
          return
        }
        finishQueueEdit(true)
        toast.success('排队消息已更新')
      } catch (error) {
        console.error('[AgentInput] 更新排队消息失败:', error)
        toast.error('更新排队消息失败')
      } finally {
        setLocalSending(false)
      }
      return
    }

    setLocalSending(true)
    const text = rawText || (commentAttachments.length > 0
      ? '请处理这些代码审阅意见。'
      : browserAttachments.length > 0
        ? '请处理这些浏览器标签与网页批注。'
        : '请解读这些附件。')
    let sendMessageMetadata = effectiveMessageMetadata
    if (selectedDesktopContextTarget) {
      const state = await refreshAgentInputDesktopContextState(sidecarCall, selectedDesktopContextTarget)
      if (state.status !== 'ready') {
        setDesktopContextCaptureMessage(state.message)
        setDesktopContextPermissionRequestAvailable(state.permissionRequestAvailable === true)
        toast.error(`当前应用上下文刷新失败：${state.message}`)
        setLocalSending(false)
        return
      }
      sendMessageMetadata = resolveAgentInputDesktopMessageMetadata({
        localTarget: state.target,
        messageMetadata,
      })
      setCapturedDesktopContextTarget(state.target)
      if (desktopContextTarget) {
        onSelectDesktopContextTarget?.(state.target)
      } else {
        setLocalDesktopContextTarget(state.target)
      }
    }
    const submissionIdentity = JSON.stringify({
      userMessage: text,
      messageParts: serialized.messageParts,
      attachments: pendingAttachments.map(({ id, filename, mediaType, size }) => ({ id, filename, mediaType, size })),
      commentAttachments,
      browserAttachments,
      thinkingLevel,
      permissionMode,
      workspaceId: workspaceIdRef.current,
      messageMetadata: sendMessageMetadata,
    })
    if (pendingSubmissionRef.current && pendingSubmissionRef.current.identity !== submissionIdentity) {
      await sidecarCall(AGENT_IPC_CHANNELS.ABORT_SUBMISSION, {
        clientSubmissionId: pendingSubmissionRef.current.id,
      }).catch(() => undefined)
      pendingSubmissionRef.current = null
    }
    const clientSubmissionId = pendingSubmissionRef.current?.identity === submissionIdentity
      ? pendingSubmissionRef.current.id
      : crypto.randomUUID()
    pendingSubmissionRef.current = { id: clientSubmissionId, identity: submissionIdentity }
    let messageAttachments: AgentMessageAttachmentInput[] = []
    try {
      if (pendingAttachments.length > 0) {
        const savedFiles = await sidecarCall<AgentSavedFile[]>(AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD, {
          threadId,
          clientSubmissionId,
          files: pendingAttachments.map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            size: attachment.size,
            ...(attachment.sourcePath ? { sourcePath: attachment.sourcePath } : {}),
            ...(attachment.data ? { data: attachment.data } : {}),
            ...(attachment.stagedAttachmentId ? { stagedAttachmentId: attachment.stagedAttachmentId } : {}),
          })),
        })
        messageAttachments = pendingAttachments.map((attachment, index) => {
          const saved = savedFiles.find((file) => file.id === attachment.id) ?? savedFiles[index]
          return {
            id: attachment.id,
            filename: attachment.filename,
            mediaType: saved?.mediaType ?? attachment.mediaType,
            size: saved?.size ?? attachment.size,
            ...(saved?.contentHash ? { contentHash: saved.contentHash } : {}),
            threadPath: saved?.threadPath ?? attachment.filename,
            ...(saved?.ref ? { fileRef: saved.ref } : {}),
          }
        })
      }
    } catch (error) {
      console.error('[AgentInput] 文件上传失败:', error)
      toast.error('文件上传失败')
      setLocalSending(false)
      return
    }
    const createdAt = new Date().toISOString()
    const sentJson = editor.getJSON()
    try {
      const result = await agentSend({
        threadId,
        userMessage: text,
        clientSubmissionId,
        ...(serialized.messageParts.some((part) => part.type === 'capability_ref')
          ? { messageParts: serialized.messageParts }
          : {}),
        thinkingLevel,
        permissionMode,
        ...(messageAttachments.length > 0 ? { messageAttachments } : {}),
        ...(commentAttachments.length > 0 ? { commentAttachments } : {}),
        ...(browserAttachments.length > 0 ? { browserAttachments } : {}),
        ...(sendMessageMetadata ? { messageMetadata: sendMessageMetadata } : {}),
        ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}),
      })
      pendingSubmissionRef.current = null
      editor.commands.clearContent()
      setEditorText('')
      pushHistoryEntry(sentJson)
      clearDraftState()
      setCommentDrafts((prev) => {
        if (!prev[threadId]) return prev
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      setBrowserAttachments((prev) => {
        if (!prev[threadId]) return prev
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      ;(debouncedSaveDraft as unknown as { cancel?: () => void }).cancel?.()
      editor.commands.focus('end')
      onMessageMetadataConsumed()
      if (shouldReleaseAgentInputLocalSendingAfterDispatch(result.mode)) {
        setLocalSending(false)
      }
      if (result.mode === 'sent') {
        setRuntimeEvents((prev) => appendRuntimeEvent(prev, {
          id: `optimistic:${threadId}:${createdAt}`,
          type: 'message.user.submitted',
          threadId,
          runId: `optimistic:${threadId}:${createdAt}`,
          createdAt,
          text,
          ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
          ...(commentAttachments.length > 0 ? { commentAttachments } : {}),
          ...(browserAttachments.length > 0 ? { browserAttachments } : {}),
          ...(serialized.messageParts.some((part) => part.type === 'capability_ref')
            ? { messageParts: serialized.messageParts }
            : {}),
        }))
        setStreamingStates((prev) => ({ ...prev, [threadId]: 'streaming' }))
      } else {
        listAgentMessageQueue({ threadId })
          .then((snapshot) => {
            setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, snapshot))
          })
          .catch((error) => {
            console.error('[AgentInput] 刷新消息队列失败:', error)
          })
        toast.success('已加入队列')
      }
      if (pendingAttachments.length > 0) {
        onClearPendingAttachments()
      }
    } catch (error) {
      console.error('[AgentInput] 发送失败:', error)
      toast.error('发送失败')
      setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
      setLocalSending(false)
      if (isTerminalAgentSubmissionError(error)) pendingSubmissionRef.current = null
    }
  }, [
    editor,
    finishQueueEdit,
    localSending,
    onClearPendingAttachments,
    onMessageMetadataConsumed,
    pendingAttachments,
    commentAttachments,
    browserAttachments,
    effectiveMessageMetadata,
    messageMetadata,
    desktopContextTarget,
    onSelectDesktopContextTarget,
    permissionMode,
    setRuntimeEvents,
    setStreamingStates,
    setMessageQueues,
    setCommentDrafts,
    setBrowserAttachments,
    streaming,
    thinkingLevel,
    threadId,
    selectedDesktopContextTarget,
    clearDraftState,
    pushHistoryEntry,
  ])
  sendNowRef.current = () => { void handleSend() }

  const applyContent = (json: AgentInputDraftJSON | undefined) => {
    if (!editor) return
    isNavigatingHistoryRef.current = true
    try {
      if (json && !isEmptyDraft(json)) {
        editor.commands.setContent(json, { emitUpdate: false })
      } else {
        editor.commands.clearContent(false)
      }
    } catch {
      editor.commands.clearContent(false)
    }
    setEditorText(editor.getText())
  }

  navigateHistoryRef.current = (dir) => {
    if (!editor) return
    const list = historyRef.current
    const nextIndex = historyIndexRef.current + dir
    if (nextIndex < 0) {
      historyIndexRef.current = -1
      applyContent(draftRef.current)
      return
    }
    if (nextIndex >= list.length) return // 超界不动
    historyIndexRef.current = nextIndex
    applyContent(list[nextIndex])
  }

  resetToDraftRef.current = () => {
    if (!editor) return
    historyIndexRef.current = -1
    applyContent(draftRef.current)
  }

  useEffect(() => () => cancelPendingDebouncedAgentInputSend(debouncedSend), [debouncedSend])

  // 卸载或 threadId 变化时，把当前编辑器内容同步写入旧 threadId 草稿，避免防抖未触发而丢草稿
  useEffect(() => {
    return () => {
      ;(debouncedSaveDraft as unknown as { cancel?: () => void }).cancel?.()
      if (editor && !isNavigatingHistoryRef.current && !editingQueuedMessageRef.current) {
        saveDraft(editor.getJSON())
      }
    }
    // 故意只依赖 threadId：仅在切换会话/卸载时 flush
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  const handleStop = async () => {
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.STOP_THREAD, { threadId })
    } catch (error) {
      console.error('[AgentInput] 停止失败:', error)
      toast.error('停止失败，请重试')
    }
  }

  const handleQueueReorder = useCallback((draggedId: string, targetId: string, placement: 'before' | 'after') => {
    const previousSnapshot = messageQueueSnapshot
    const optimisticSnapshot = reorderQueuedMessages(previousSnapshot, draggedId, targetId, placement)
    if (optimisticSnapshot === previousSnapshot) return
    setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, optimisticSnapshot))
    reorderAgentMessageQueue({
      threadId,
      orderedMessageIds: optimisticSnapshot.queuedMessages.map((item) => item.id),
      expectedRevision: previousSnapshot.revision,
      queueOperationId: crypto.randomUUID(),
    })
      .then((result) => {
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
        if (!result.ok) toast.error('队列已发生变化，已刷新最新顺序')
      })
      .catch((error) => {
        console.error('[AgentInput] 消息队列排序失败:', error)
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, previousSnapshot))
        toast.error('队列排序失败')
      })
  }, [messageQueueSnapshot, setMessageQueues, threadId])

  const handleRemoveQueuedMessage = useCallback((queuedMessageId: string) => {
    removeQueuedAgentMessage({
      threadId,
      queuedMessageId,
      expectedRevision: messageQueueSnapshot.revision,
      queueOperationId: crypto.randomUUID(),
    })
      .then((result) => {
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
        if (!result.ok) toast.error('队列已发生变化，删除未执行')
      })
      .catch((error) => {
        console.error('[AgentInput] 删除排队消息失败:', error)
        toast.error('删除排队消息失败')
      })
  }, [messageQueueSnapshot.revision, setMessageQueues, threadId])

  const handleEditQueuedMessage = useCallback((queuedMessageId: string) => {
    if (!editor) return
    const editing = startEditingQueuedMessage(messageQueueSnapshot, queuedMessageId)
    if (!editing) return
    setEditingQueuedMessage({
      item: editing.queuedMessage,
      expectedRevision: messageQueueSnapshot.revision,
      previousDraft: editor.getJSON(),
    })
    setPlusPanelOpen(false)
    setEditorMessageParts(editor, editing.queuedMessage.messageParts, editing.draftText)
    setEditorText(editor.getText())
    editor.commands.focus('end')
  }, [editor, messageQueueSnapshot, setMessageQueues, threadId])

  const handlePromoteQueuedMessageToGuidance = useCallback((queuedMessageId: string) => {
    promoteQueuedAgentMessageToGuidance({
      threadId,
      queuedMessageId,
      expectedRevision: messageQueueSnapshot.revision,
      queueOperationId: crypto.randomUUID(),
    })
      .then((result) => {
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
        if (!result.ok) toast.error('队列已发生变化，设置引导未执行')
      })
      .catch((error) => {
        console.error('[AgentInput] 设置引导失败:', error)
        toast.error('设置引导失败')
      })
  }, [messageQueueSnapshot.revision, setMessageQueues, threadId])

  const handleThinkingLevelChange = (value: LumeConfigThinkingLevel) => {
    setThinkingLevel(value)
    updateAgentThinkingLevel(value).catch((error) => {
      console.error('[AgentInput] 保存思考等级失败:', error)
      toast.error('保存思考等级失败')
    })
  }

  const handlePermissionModeChange = (value: PermissionModeValue) => {
    autoSelectedPlanModeRef.current = false
    setPermissionMode(value)
    setThreadPermissionModes((prev) => ({ ...prev, [threadId]: value }))
  }

  const handleAttach = async () => {
    try {
      const result = await openFileDialog()
      if (result.files.length === 0) return

      onAddPendingAttachments(result.files.map((file) => {
        const mediaType = file.mediaType || 'application/octet-stream'
        return {
          id: file.id || createPendingAttachmentId(),
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
    } catch (error) {
      console.error('[AgentInput] 文件选择失败:', error)
      toast.error('文件选择失败')
    }
  }

  const handleOpenDesktopAssistantSettings = useCallback(() => {
    const next = resolveOpenDesktopAssistantSettingsState(tabs)
    setTabs(next.tabs)
    setSettingsInitialTab(next.settingsInitialTab)
    setActiveTabId(next.activeTabId)
    setPlusPanelOpen(false)
  }, [setActiveTabId, setSettingsInitialTab, setTabs, tabs])

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

  const handleOpenPlusPanel = async () => {
    if (editingQueuedMessageRef.current) return
    if (plusPanelOpen) {
      setPlusPanelOpen(false)
      return
    }
    setPlusPanelOpen(true)
    setActiveIndex(0)
    setDesktopContextCaptureLoading(true)
    setDesktopContextCaptureMessage(undefined)
    setDesktopContextPermissionRequestAvailable(false)
    setCapturedDesktopContextTarget(undefined)
    captureAgentInputDesktopContextState(sidecarCall, () => invoke('quick_input_get_context'))
      .then((state) => {
        if (state.status === 'ready') {
          setCapturedDesktopContextTarget(state.target)
          setDesktopContextCaptureMessage(undefined)
          setDesktopContextPermissionRequestAvailable(false)
        } else {
          setCapturedDesktopContextTarget(undefined)
          setDesktopContextCaptureMessage(state.message)
          setDesktopContextPermissionRequestAvailable(state.permissionRequestAvailable === true)
        }
      })
      .finally(() => setDesktopContextCaptureLoading(false))
  }
  stopNowRef.current = () => { void handleStop() }

  // 面板根抢焦点：把焦点从 tiptap 编辑器收到面板根，
  // 使 ↑/↓/Enter/Esc 由面板捕获，不会冒泡成编辑器光标移动
  const plusPanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!plusPanelOpen) return
    setActiveIndex(0)
    queueMicrotask(() => plusPanelRef.current?.focus())
  }, [plusPanelOpen])

  const hasDesktopContextTarget = Boolean(availableDesktopContextTarget)
  const showDesktopContextSection = desktopContextView.showPlusPanelSection
  const desktopContextIndex = 1
  const totalPlusItems = hasDesktopContextTarget ? 2 : 1

  // 列表变化（插件加载完成）时夹紧 activeIndex，避免悬空指向已不存在的项
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, totalPlusItems - 1)))
  }, [totalPlusItems])

  // 当前焦点项滚动入可视区
  useEffect(() => {
    if (!plusPanelOpen) return
    plusPanelRef.current
      ?.querySelector<HTMLDivElement>(`[data-plus-item="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, plusPanelOpen])

  const activatePlusItem = useCallback((index: number) => {
    if (index === 0) {
      setPlusPanelOpen(false)
      void handleAttach()
      return
    }
    if (hasDesktopContextTarget && index === desktopContextIndex && availableDesktopContextTarget) {
      setPlusPanelOpen(false)
      if (onSelectDesktopContextTarget) {
        onSelectDesktopContextTarget(availableDesktopContextTarget)
      } else {
        setLocalDesktopContextTarget(availableDesktopContextTarget)
      }
      toast.success(`已将 ${availableDesktopContextTarget.app.name} 附加到对话`)
      return
    }
  }, [
    availableDesktopContextTarget,
    handleAttach,
    hasDesktopContextTarget,
    onSelectDesktopContextTarget,
  ])

  const handlePlusPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((i) => resolveNextActiveIndex({ current: i, direction: 1, total: totalPlusItems }))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((i) => resolveNextActiveIndex({ current: i, direction: -1, total: totalPlusItems }))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activatePlusItem(activeIndex)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setPlusPanelOpen(false)
      if (streamingRef.current) {
        lastEscapeAtRef.current = Date.now()
        toast.info('再次按 Esc 停止当前输出', { duration: 900 })
      }
      queueMicrotask(() => editor?.commands.focus('end'))
    }
  }

  const plusItemClass = (active: boolean) =>
    cn(
      'flex items-center gap-2.5 px-3 py-2.5 transition-colors',
      active
        ? 'bg-[var(--lume-accent-soft)]'
        : 'hover:bg-[var(--surface-3)]',
    )

  return (
    <div className="px-3 pb-4 pt-2">
      <div className="mx-auto w-full max-w-[980px] px-4">
        <div>
          <LumeComposer
            tone={composerState.tone}
            className="rounded-[1.45rem]"
            editorSlot={
              <>
                {editingQueuedMessage ? (
                  <div className="mb-2 flex items-center justify-between rounded-lg bg-[var(--lume-accent-soft)] px-2.5 py-1.5 text-xs text-[var(--lume-text-secondary)]">
                    <span>正在编辑排队消息</span>
                    <Button variant="ghost" type="button" className="h-6 px-2 text-xs" onClick={() => finishQueueEdit(true)}>
                      取消
                    </Button>
                  </div>
                ) : null}
                <AgentMessageQueueList
                  snapshot={messageQueueSnapshot}
                  onReorder={handleQueueReorder}
                  onRemove={handleRemoveQueuedMessage}
                  onEdit={handleEditQueuedMessage}
                  onPromoteToGuidance={handlePromoteQueuedMessageToGuidance}
                />
                <EditorContent
                  editor={editor}
                  className="[&_.ProseMirror]:min-h-[72px] [&_.ProseMirror]:text-[14px] [&_.ProseMirror]:leading-7 [&_.ProseMirror]:text-[var(--text-1)] [&_.ProseMirror]:outline-none"
                />
              </>
            }
            topContent={
              editingQueuedMessage?.item.messageAttachments?.length
              || editingQueuedMessage?.item.commentAttachments?.length
              || editingQueuedMessage?.item.browserAttachments?.length
              || (!editingQueuedMessage && (pendingAttachments.length > 0 || commentAttachments.length > 0 || browserAttachments.length > 0))
                ? (
                    <div className="space-y-2 px-3 pb-2 pt-3">
                      {editingQueuedMessage?.item.messageAttachments?.length ? (
                        <PendingAttachmentList
                          attachments={editingQueuedMessage.item.messageAttachments}
                          hideRemove
                          onRemove={() => undefined}
                        />
                      ) : !editingQueuedMessage && pendingAttachments.length > 0 ? (
                        <PendingAttachmentList
                          attachments={pendingAttachments}
                          onRemove={onRemovePendingAttachment}
                        />
                      ) : null}
                      {(editingQueuedMessage?.item.commentAttachments ?? commentAttachments).map((comment) => (
                        <div key={comment.id} className="flex items-center gap-2 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-2.5 py-1.5 text-xs">
                          <MessageSquareText size={13} className="shrink-0 text-[var(--lume-accent)]" />
                          <span className="min-w-0 flex-1 truncate">
                            {comment.intent === 'modify' ? '修改请求 · ' : comment.intent === 'context' ? '代码上下文 · ' : ''}
                            {comment.position.path}:L{comment.position.startLine ?? comment.position.line}
                            {(comment.position.startLine ?? comment.position.line) !== comment.position.line ? `–L${comment.position.line}` : ''}
                            {' · '}{comment.body}
                          </span>
                          {!editingQueuedMessage && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label="移除审阅意见"
                              onClick={() => setCommentDrafts((prev) => ({
                                ...prev,
                                [threadId]: (prev[threadId] ?? []).filter((item) => item.id !== comment.id),
                              }))}
                            >
                              <X size={12} />
                            </Button>
                          )}
                        </div>
                      ))}
                      {(editingQueuedMessage?.item.browserAttachments ?? browserAttachments).map((attachment) => {
                        const tab = attachment.origin === 'browser-tab' ? attachment : attachment.tab
                        return (
                          <div key={attachment.id} className="flex items-center gap-2 rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] px-2.5 py-1.5 text-xs">
                            <Globe size={13} className="shrink-0 text-[var(--lume-accent)]" />
                            <span className="min-w-0 flex-1 truncate">
                              {attachment.origin === 'browser-annotation' ? '网页批注 · ' : attachment.origin === 'browser-design-change' ? 'Design Tweaks · ' : '浏览器标签 · '}
                              {tab.title || tab.url}
                            </span>
                            {!editingQueuedMessage && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-xs"
                                aria-label="移除浏览器附件"
                                onClick={() => setBrowserAttachments((prev) => ({
                                  ...prev,
                                  [threadId]: (prev[threadId] ?? []).filter((item) => item.id !== attachment.id),
                                }))}
                              >
                                <X size={12} />
                              </Button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )
                : undefined
            }
            supportingContent={
              !editingQueuedMessage && selectedDesktopContextTarget ? (
                <div className="space-y-2 px-3 pb-2">
                  {selectedDesktopContextTarget ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <DesktopContextSelectionChip
                        target={selectedDesktopContextTarget}
                        onClear={desktopContextTarget ? onClearDesktopContextTarget : () => setLocalDesktopContextTarget(undefined)}
                      />
                    </div>
                  ) : null}
                </div>
              ) : undefined
            }
            leadingTools={
              <>
                <div className="relative">
                  <Button
                    variant="ghost"
                    onClick={handleOpenPlusPanel}
                    disabled={Boolean(editingQueuedMessage)}
                    className="inline-flex size-8 items-center justify-center rounded-lg border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_72%,transparent)] text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:border-[var(--lume-border-strong)] hover:text-[var(--lume-text-primary)]"
                    title="添加"
                    type="button"
                  >
                    <Plus size={13} />
                  </Button>
                  {plusPanelOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setPlusPanelOpen(false)} />
                      <div
                        ref={plusPanelRef}
                        tabIndex={-1}
                        onKeyDown={handlePlusPanelKeyDown}
                        className="absolute bottom-full left-0 z-50 mb-2 w-[520px] overflow-hidden rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] shadow-[0_18px_42px_-28px_hsl(var(--lume-shadow-panel)/0.62)] focus:outline-none"
                      >
                        <div className="px-3 py-2 text-xs font-medium text-[var(--text-3)]">
                          添加到对话
                        </div>
                        {[
                          { index: 0, icon: <FileText size={15} />, label: '文件或图片' },
                        ].map((row) => (
                          <Button
                            variant="ghost"
                            type="button"
                            key={row.index}
                            data-plus-item={row.index}
                            onMouseEnter={() => setActiveIndex(row.index)}
                            onClick={() => activatePlusItem(row.index)}
                            className={cn(plusItemClass(activeIndex === row.index), 'h-auto w-full justify-start rounded-none text-sm text-[var(--text-1)]')}
                          >
                            <span className="text-[var(--text-3)]">{row.icon}</span>
                            {row.label}
                          </Button>
                        ))}
                        {showDesktopContextSection && (
                          <>
                            <div className="border-t border-[var(--lume-border-subtle)]" />
                            <div className="px-3 py-2 text-xs font-medium text-[var(--text-3)]">
                              当前应用
                            </div>
                            {hasDesktopContextTarget && availableDesktopContextTarget ? (
                              <DesktopContextPlusItem
                                target={availableDesktopContextTarget}
                                active={activeIndex === desktopContextIndex}
                                itemIndex={desktopContextIndex}
                                onHover={() => setActiveIndex(desktopContextIndex)}
                                onActivate={() => activatePlusItem(desktopContextIndex)}
                              />
                            ) : (
                              <div className="px-3 pb-3">
                                <div className="rounded-xl border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--surface-2)_72%,transparent)] px-3 py-2.5">
                                  <div className="flex items-start gap-2.5">
                                    <div className="mt-0.5 text-[var(--text-3)]">
                                      {desktopContextCaptureLoading ? (
                                        <LoaderCircle size={15} className="animate-spin" />
                                      ) : (
                                        <MonitorOff size={15} />
                                      )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-medium text-[var(--text-1)]">
                                        {desktopContextCaptureLoading ? '正在检查当前应用' : '当前应用暂不可用'}
                                      </div>
                                      <div className="mt-0.5 text-xs leading-5 text-[var(--text-3)]">
                                        {desktopContextCaptureLoading
                                          ? 'Lume 正在读取前台窗口，用于附加到这次会话。'
                                          : desktopContextCaptureMessage ?? '请检查桌面助手权限和应用范围。'}
                                      </div>
                                    </div>
                                  </div>
                                  {!desktopContextCaptureLoading ? (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                      {desktopContextPermissionRequestAvailable ? (
                                        <Button
                                          variant="secondary"
                                          type="button"
                                          disabled={desktopContextPermissionRequestLoading}
                                          onClick={handleRequestDesktopContextPermissions}
                                          className="h-7 rounded-lg px-2 text-xs"
                                        >
                                          {desktopContextPermissionRequestLoading ? '等待系统授权' : '启动授权引导'}
                                        </Button>
                                      ) : null}
                                      <Button
                                        variant="ghost"
                                        type="button"
                                        onClick={handleOpenDesktopAssistantSettings}
                                        className="h-7 rounded-lg px-2 text-xs text-[var(--lume-text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--lume-text-primary)]"
                                      >
                                        打开桌面助手设置
                                      </Button>
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <fieldset disabled={Boolean(editingQueuedMessage)} className="contents">
                  <ModelPicker threadId={threadId} />
                  <PermissionModePicker value={permissionMode} onChange={handlePermissionModeChange} />
                  <ThinkingLevelPicker value={thinkingLevel} onChange={handleThinkingLevelChange} />
                </fieldset>
              </>
            }
            trailingTools={<ContextWindowIndicator progress={contextWindowProgress} />}
            actionSlot={
              submitState.action === 'stop' ? (
                <Button
                variant="ghost"
                  type="button"
                  onClick={handleStop}
                  className="inline-flex h-8 items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--lume-danger)_28%,var(--lume-border-subtle))] bg-[color:color-mix(in_oklab,var(--lume-danger)_10%,var(--lume-bg-elevated))] px-3 text-[11.5px] font-medium text-[var(--lume-text-primary)] transition-colors hover:border-[color:color-mix(in_oklab,var(--lume-danger)_40%,var(--lume-border-strong))]"
                  title="停止"
                >
                  <Square size={12} />
                  停止
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={debouncedSend}
                  disabled={!submitState.canSubmit}
                  className={getLumeComposerPrimaryActionClassName({
                    enabled: submitState.canSubmit,
                  })}
                  title={editingQueuedMessage ? '保存排队消息' : submitState.action === 'queue' ? '加入消息队列' : '发送'}
                >
                  {editingQueuedMessage ? '保存' : submitState.label}
                  <Send size={12} />
                </Button>
              )
            }
          />
        </div>
      </div>
      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => setConfirmState((prev) => ({ ...prev, open }))}
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel={confirmState.confirmLabel}
        destructive={confirmState.destructive}
        onConfirm={confirmState.onConfirm}
      />
    </div>
  )
}

function setEditorMessageParts(
  editor: NonNullable<ReturnType<typeof useEditor>>,
  parts: AgentQueuedMessage['messageParts'],
  fallbackText: string,
): void {
  const paragraphs: Array<{ type: 'paragraph'; content?: Array<Record<string, unknown>> }> = [
    { type: 'paragraph', content: [] },
  ]
  const activeContent = () => (paragraphs.at(-1)!.content ??= [])
  for (const part of parts ?? [{ type: 'text' as const, text: fallbackText }]) {
    if (part.type === 'capability_ref') {
      activeContent().push({
        type: 'capabilityMention',
        attrs: {
          id: part.uri,
          label: part.uri,
          uri: part.uri,
          occurrenceId: part.occurrenceId,
          kind: part.uri.startsWith('lume-plugin://')
            ? 'plugin'
            : part.uri.slice('lume-skill://'.length).includes(':') ? 'plugin-skill' : 'skill',
        },
      })
      continue
    }
    part.text.split('\n').forEach((text, index) => {
      if (index > 0) paragraphs.push({ type: 'paragraph', content: [] })
      if (text) activeContent().push({ type: 'text', text })
    })
  }
  editor.commands.setContent({ type: 'doc', content: paragraphs }, { emitUpdate: false })
}

function createPendingAttachmentId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

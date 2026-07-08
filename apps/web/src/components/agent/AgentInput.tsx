import { useEditor, EditorContent, ReactRenderer, ReactNodeViewRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { cn } from '@/lib/utils'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { Bot, Send, Square, FileText, Image, Plus, Puzzle, LoaderCircle, MonitorOff } from 'lucide-react'
import { toast } from 'sonner'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  agentSend,
  getThreadMessages,
  listAgentMessageQueue,
  onSidecarEvent,
  openFileDialog,
  promoteQueuedAgentMessageToGuidance,
  removeQueuedAgentMessage,
  reorderAgentMessageQueue,
  sidecarCall,
} from '@/lib/desktop-api'
import { invoke } from '@/lib/desktop-runtime/core'
import { listChannels } from '@/lib/desktop-api/channel'
import { activeTabIdAtom, agentInputDraftAtom, agentInputDraftFamily, agentInputHistoryAtom, agentInputHistoryFamily, agentMessageQueueAtom, agentPlanModePhaseFamily, agentRuntimeEventsAtom, agentRuntimeEventsFamily, agentStreamingStatesAtom, agentThreadPermissionModesAtom, agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, settingsInitialTabAtom, tabsAtom } from '@/atoms'
import { isEmptyDraft, prependHistory, removeDraft, upsertDraft, type AgentInputDraftJSON } from '@/lib/agent-input-draft-state'
import { debounce } from 'throttle-debounce'
import {
  AGENT_IPC_CHANNELS,
  LUME_CONFIG_IPC_CHANNELS,
  type AgentListPluginsResult,
  type AgentMessage,
  type AgentMessageAttachmentInput,
  type AgentPluginListItem,
  type AgentSavedFile,
  type Channel,
  type DesktopContextTarget,
  type LumeConfigAgentDefaultStrategy,
  type LumeEffectiveConfig,
  type LumeConfigThinkingLevel,
  type LumeRuntimeEvent,
} from '@lume/shared'
import { appendRuntimeEvent } from '@/hooks/runtime-event-state'
import { MentionList } from './MentionList'
import { PluginMentionNodeView } from './PluginMentionNodeView'
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
import { createSuggestionRenderer } from './editor-mention-suggestions'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { buildContextWindowProgress } from './runtime-state-projections'
import { ContextWindowIndicator } from './ContextWindowIndicator'
import { getThreadSelectionSummary } from '@/components/model-selection/model-selection-state'
import {
  applyAgentRoleMentions,
  applyAgentRoleRecommendation,
  buildAgentRoleMentionItems,
  buildAgentInputRoleRecommendations,
  type AgentInputRoleRecommendation,
} from './agent-input-role-recommendations'
import { AgentAttachmentGrid, attachmentDataUrl, isImageAttachment } from './AgentAttachmentGrid'
import { DesktopContextPlusItem } from './DesktopContextPlusItem'
import { DesktopContextSelectionChip } from './DesktopContextSelectionChip'
import {
  captureAgentInputDesktopContextState,
  resolveAgentInputDesktopContextView,
  resolveAgentInputDesktopMessageMetadata,
} from './agent-input-desktop-context'
import { resolveOpenDesktopAssistantSettingsState } from './agent-input-desktop-settings'

import { Button } from '@/components/ui/button'
type InstalledPluginSummary = Pick<AgentPluginListItem, 'name' | 'version' | 'description' | 'displayName'>

function normalizeListPluginsResult(result: unknown): InstalledPluginSummary[] {
  if (Array.isArray(result)) return result as InstalledPluginSummary[]
  return (result as Partial<AgentListPluginsResult>).plugins ?? []
}

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
}

export interface PendingMessageAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath?: string
  data?: string
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
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    destructive: boolean
    onConfirm: () => void
  }>({ open: false, title: '', description: '', confirmLabel: '确认', destructive: false, onConfirm: () => {} })
  const [localSending, setLocalSending] = useState(false)
  const [historyMessages, setHistoryMessages] = useState<AgentMessage[]>([])
  const mentionSuggestionOpenRef = useRef(false)
  const [plusPanelOpen, setPlusPanelOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginSummary[]>([])
  const [capturedDesktopContextTarget, setCapturedDesktopContextTarget] = useState<DesktopContextTarget | undefined>()
  const [desktopContextCaptureMessage, setDesktopContextCaptureMessage] = useState<string | undefined>()
  const [desktopContextCaptureLoading, setDesktopContextCaptureLoading] = useState(false)
  const [localDesktopContextTarget, setLocalDesktopContextTarget] = useState<DesktopContextTarget | undefined>()
  const sendNowRef = useRef<() => void>(() => undefined)
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
      const next = syncPermissionModeWithPlanModePhase({
        permissionMode: current,
        defaultPermissionMode: defaultPermissionModeRef.current,
        planPhase: planModePhase?.phase,
        autoSelectedPlan: autoSelectedPlanModeRef.current,
      })
      autoSelectedPlanModeRef.current = next.autoSelectedPlan
      return next.permissionMode
    })
  }, [planModePhase?.phase, threadId])

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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false, bold: false, italic: false, strike: false }),
      Placeholder.configure({ placeholder: '输入任务... 支持 @Agent/@文件 /命令 $技能 %插件' }),
      Mention.configure({
        HTMLAttributes: {
          class: 'mention bg-blue-500/10 text-blue-600 dark:text-blue-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createAgentSuggestionRenderer(threadId, getWorkspaceSlug, setMentionSuggestionOpen),
      }),
      Mention.extend({ name: 'slashMention' }).configure({
        HTMLAttributes: {
          class: 'mention bg-orange-500/10 text-orange-600 dark:text-orange-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('/', threadId, '/', getWorkspaceSlug, setMentionSuggestionOpen, handleSlashCommandExecuteStable),
      }),
      Mention.extend({ name: 'skillMention' }).configure({
        HTMLAttributes: {
          class: 'mention bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('$', threadId, '$', getWorkspaceSlug, setMentionSuggestionOpen),
      }),
      Mention.extend({
        name: 'pluginMention',
        addNodeView() {
          return ReactNodeViewRenderer(PluginMentionNodeView)
        },
      }).configure({
        HTMLAttributes: { class: 'plugin-mention' },
        suggestion: createSuggestionRenderer('%', threadId, '%', getWorkspaceSlug, setMentionSuggestionOpen),
      }),
    ],
    editorProps: {
      attributes: {
        class:
          'outline-none min-h-[72px] max-h-[220px] overflow-y-auto text-[14px] leading-7 text-[var(--text-1)]',
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
      debouncedSaveDraft(editor.getJSON())
    },
  })

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

  const hasComposerPayload = editorText.trim().length > 0 || pendingAttachments.length > 0
  const submitState = deriveAgentInputSubmitState({
    hasText: hasComposerPayload,
    streaming,
    localSending,
  })
  const composerState = deriveLumeComposerState({
    hasText: hasComposerPayload,
    mode: localSending ? 'busy' : streaming && !hasComposerPayload ? 'streaming' : 'idle',
  })
  const selectedModelSummary = useMemo(() => getThreadSelectionSummary({
    channels,
    channelsLoaded,
    thread,
    defaultStrategy,
  }), [channels, channelsLoaded, thread, defaultStrategy])
  const contextWindowProgress = buildContextWindowProgress(runtimeEvents, {
    contextWindow: selectedModelSummary.meta?.contextWindow,
    messages: historyMessages,
  })
  const roleRecommendations = useMemo(
    () => streaming || localSending ? [] : buildAgentInputRoleRecommendations(editorText),
    [editorText, localSending, streaming],
  )

  const applyRoleRecommendation = useCallback((recommendation: AgentInputRoleRecommendation) => {
    if (!editor) return
    const nextText = applyAgentRoleRecommendation(editor.getText(), recommendation.role.id)
    editor.commands.setContent(
      nextText.split('\n').map((line) => ({
        type: 'paragraph',
        content: line.length > 0 ? [{ type: 'text', text: line }] : undefined,
      })),
    )
    editor.commands.focus('end')
    setEditorText(nextText)
  }, [editor])

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
      toast.success('已清空对话')
    } catch (error) {
      console.error('[AgentInput] 清空对话失败:', error)
      toast.error('清空失败')
    }
  }, [threadId, setRuntimeEvents, setStreamingStates, setMessageQueues])

  const handleSlashCommandExecute = useCallback((id: string) => {
    if (!editor) return
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
          const result = await sidecarCall(AGENT_IPC_CHANNELS.RELOAD_PLUGINS, {})
          setInstalledPlugins(normalizeListPluginsResult(result))
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
  }, [editor, threadId, threads, doClear])

  slashCommandExecuteRef.current = handleSlashCommandExecute

  const handleSend = useCallback(async () => {
    if (!editor || localSending) return
    const rawText = applyAgentRoleMentions(editor.getText()).trim()
    if (!rawText && pendingAttachments.length === 0) return

    // 兜底：手打 /clear /compact /reload-plugins 文本回车，走与「选中」相同的流程
    if (rawText === '/reload-plugins' || rawText === '/clear' || rawText === '/compact') {
      handleSlashCommandExecute(rawText.replace(/^\//, ''))
      return
    }

    setLocalSending(true)
    const text = rawText || '请解读这些附件。'
    let messageAttachments: AgentMessageAttachmentInput[] = []
    try {
      if (pendingAttachments.length > 0) {
        const savedFiles = await sidecarCall<AgentSavedFile[]>(AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD, {
          threadId,
          files: pendingAttachments.map((attachment) => ({
            filename: attachment.filename,
            ...(attachment.sourcePath ? { sourcePath: attachment.sourcePath } : {}),
            ...(attachment.data ? { data: attachment.data } : {}),
          })),
        })
        messageAttachments = pendingAttachments.map((attachment, index) => {
          const saved = savedFiles.find((file) => file.filename === attachment.filename) ?? savedFiles[index]
          return {
            id: attachment.id,
            filename: attachment.filename,
            mediaType: attachment.mediaType,
            size: attachment.size,
            threadPath: saved?.threadPath ?? attachment.filename,
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
    editor.commands.clearContent()
    setEditorText('')
    pushHistoryEntry(sentJson)
    clearDraftState()
    ;(debouncedSaveDraft as unknown as { cancel?: () => void }).cancel?.()
    try {
      const result = await agentSend({
        threadId,
        userMessage: text,
        thinkingLevel,
        permissionMode,
        ...(messageAttachments.length > 0 ? { messageAttachments } : {}),
        ...(effectiveMessageMetadata ? { messageMetadata: effectiveMessageMetadata } : {}),
        ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}),
      })
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
    }
  }, [
    editor,
    handleSlashCommandExecute,
    localSending,
    onClearPendingAttachments,
    onMessageMetadataConsumed,
    pendingAttachments,
    effectiveMessageMetadata,
    permissionMode,
    setRuntimeEvents,
    setStreamingStates,
    setMessageQueues,
    streaming,
    thinkingLevel,
    threadId,
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
      if (editor && !isNavigatingHistoryRef.current) {
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
    })
      .then((result) => {
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
      })
      .catch((error) => {
        console.error('[AgentInput] 消息队列排序失败:', error)
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, previousSnapshot))
        toast.error('队列排序失败')
      })
  }, [messageQueueSnapshot, setMessageQueues, threadId])

  const handleRemoveQueuedMessage = useCallback((queuedMessageId: string) => {
    removeQueuedAgentMessage({ threadId, queuedMessageId })
      .then((result) => {
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
      })
      .catch((error) => {
        console.error('[AgentInput] 删除排队消息失败:', error)
        toast.error('删除排队消息失败')
      })
  }, [setMessageQueues, threadId])

  const handleEditQueuedMessage = useCallback((queuedMessageId: string) => {
    if (!editor) return
    const editing = startEditingQueuedMessage(messageQueueSnapshot, queuedMessageId)
    if (!editing) return
    removeQueuedAgentMessage({ threadId, queuedMessageId })
      .then((result) => {
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
        setEditorPlainText(editor, result.removedMessage?.text ?? editing.draftText)
        setEditorText(result.removedMessage?.text ?? editing.draftText)
      })
      .catch((error) => {
        console.error('[AgentInput] 编辑排队消息失败:', error)
        toast.error('编辑排队消息失败')
      })
  }, [editor, messageQueueSnapshot, setMessageQueues, threadId])

  const handlePromoteQueuedMessageToGuidance = useCallback((queuedMessageId: string) => {
    promoteQueuedAgentMessageToGuidance({ threadId, queuedMessageId })
      .then((result) => {
        setMessageQueues((prev) => upsertAgentMessageQueueSnapshot(prev, result.snapshot))
      })
      .catch((error) => {
        console.error('[AgentInput] 设置引导失败:', error)
        toast.error('设置引导失败')
      })
  }, [setMessageQueues, threadId])

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
          id: createPendingAttachmentId(),
          filename: file.filename,
          mediaType,
          size: file.size,
          sourcePath: file.sourcePath,
          ...(file.data ? { data: file.data } : {}),
          ...(isImageAttachment({ filename: file.filename, mediaType })
            ? { previewUrl: attachmentDataUrl(mediaType, file.data) }
            : {}),
        }
      }))
      toast.success(`已添加 ${result.files.length} 个文件`)
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

  const handleOpenPlusPanel = async () => {
    if (plusPanelOpen) {
      setPlusPanelOpen(false)
      return
    }
    setPlusPanelOpen(true)
    setActiveIndex(0)
    setDesktopContextCaptureLoading(true)
    setDesktopContextCaptureMessage(undefined)
    setCapturedDesktopContextTarget(undefined)
    captureAgentInputDesktopContextState(sidecarCall, () => invoke('quick_input_get_context'))
      .then((state) => {
        if (state.status === 'ready') {
          setCapturedDesktopContextTarget(state.target)
          setDesktopContextCaptureMessage(undefined)
        } else {
          setCapturedDesktopContextTarget(undefined)
          setDesktopContextCaptureMessage(state.message)
        }
      })
      .finally(() => setDesktopContextCaptureLoading(false))
    // 打开即刷新插件列表；失败仅 toast，不阻塞面板（沿用原 handleOpenPlugins 行为）
    try {
      const result = await sidecarCall(AGENT_IPC_CHANNELS.LIST_PLUGINS, {})
      setInstalledPlugins(normalizeListPluginsResult(result))
    } catch {
      toast.error('获取插件列表失败')
    }
  }

  // 面板根抢焦点：把焦点从 tiptap 编辑器收到面板根，
  // 使 ↑/↓/Enter/Esc 由面板捕获，不会冒泡成编辑器光标移动
  const plusPanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!plusPanelOpen) return
    setActiveIndex(0)
    queueMicrotask(() => plusPanelRef.current?.focus())
  }, [plusPanelOpen])

  // 插件按名称排序后平铺（不分组）
  const pluginItems = useMemo(
    () => [...installedPlugins].sort((a, b) => a.name.localeCompare(b.name)),
    [installedPlugins],
  )
  const hasDesktopContextTarget = Boolean(availableDesktopContextTarget)
  const showDesktopContextSection = desktopContextView.showPlusPanelSection
  const desktopContextIndex = 2
  const pluginStartIndex = hasDesktopContextTarget ? 3 : 2
  // 整个面板可选项序列：[文件, 图片, 当前应用?, ...插件]，totalPlusItems 驱动 ↑/↓ 导航边界
  const totalPlusItems = pluginStartIndex + pluginItems.length

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
    // 索引 0/1 = 文件 / 图片（沿用原 attachMenu：二者都打开文件选择）
    if (index === 0 || index === 1) {
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
    const plugin = pluginItems[index - pluginStartIndex]
    if (!plugin) return
    setPlusPanelOpen(false)
    // 插件引用：插入 pluginMention node（label 带 % 前缀，作为输入/发送/气泡三段统一 token）
    if (editor) {
      editor.commands.focus('end')
      editor.commands.insertContent({
        type: 'pluginMention',
        attrs: { id: plugin.name, label: `%${plugin.displayName || plugin.name}` },
      })
      editor.commands.insertContent(' ')
    }
  }, [
    availableDesktopContextTarget,
    editor,
    handleAttach,
    hasDesktopContextTarget,
    onSelectDesktopContextTarget,
    pluginItems,
    pluginStartIndex,
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
            scale="compact"
            className="rounded-[1.6rem]"
            editorSlot={
              <>
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
              pendingAttachments.length > 0 ? (
                <div className="px-3 pb-2 pt-3">
                  <AgentAttachmentGrid
                    attachments={pendingAttachments}
                    removable
                    onRemove={onRemovePendingAttachment}
                  />
                </div>
              ) : undefined
            }
            supportingContent={
              selectedDesktopContextTarget || roleRecommendations.length > 0 ? (
                <div className="space-y-2 px-3 pb-2">
                  {selectedDesktopContextTarget ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <DesktopContextSelectionChip
                        target={selectedDesktopContextTarget}
                        onClear={desktopContextTarget ? undefined : () => setLocalDesktopContextTarget(undefined)}
                      />
                    </div>
                  ) : null}
                  {roleRecommendations.length > 0 ? (
                    <AgentRoleRecommendationChips
                      recommendations={roleRecommendations}
                      onSelect={applyRoleRecommendation}
                    />
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
                          { index: 0, icon: <FileText size={15} />, label: '文件' },
                          { index: 1, icon: <Image size={15} />, label: '图片' },
                        ].map((row) => (
                          <div
                            key={row.index}
                            data-plus-item={row.index}
                            onMouseEnter={() => setActiveIndex(row.index)}
                            onClick={() => activatePlusItem(row.index)}
                            className={cn(plusItemClass(activeIndex === row.index), 'text-sm text-[var(--text-1)]')}
                          >
                            <span className="text-[var(--text-3)]">{row.icon}</span>
                            {row.label}
                          </div>
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
                                    <Button
                                      variant="ghost"
                                      type="button"
                                      onClick={handleOpenDesktopAssistantSettings}
                                      className="mt-2 h-7 rounded-lg px-2 text-xs text-[var(--lume-text-secondary)] hover:bg-[var(--surface-3)] hover:text-[var(--lume-text-primary)]"
                                    >
                                      打开桌面助手设置
                                    </Button>
                                  ) : null}
                                </div>
                              </div>
                            )}
                          </>
                        )}
                        <div className="border-t border-[var(--lume-border-subtle)]" />
                        <div className="px-3 py-2 text-xs font-medium text-[var(--text-3)]">
                          已安装插件 · {pluginItems.length}
                        </div>
                        {pluginItems.length === 0 ? (
                          <div className="px-3 py-3 text-sm text-[var(--text-3)]">
                            暂无已安装的插件
                          </div>
                        ) : (
                          <div className="max-h-[200px] overflow-y-auto pb-1">
                            {pluginItems.map((plugin, i) => {
                              const index = i + pluginStartIndex
                              return (
                                <div
                                  key={plugin.name}
                                  data-plus-item={index}
                                  onMouseEnter={() => setActiveIndex(index)}
                                  onClick={() => activatePlusItem(index)}
                                  className={plusItemClass(activeIndex === index)}
                                >
                                  <Puzzle size={14} className="shrink-0 text-[var(--text-3)]" />
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm text-[var(--text-1)]">
                                      {plugin.displayName || plugin.name}
                                    </div>
                                    <div className="truncate text-xs text-[var(--text-3)]">
                                      {plugin.description ? plugin.description : `v${plugin.version}`}
                                    </div>
                                  </div>
                                  <div className="shrink-0 text-xs text-[var(--text-3)]">
                                    v{plugin.version}
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <ModelPicker threadId={threadId} />
                <PermissionModePicker value={permissionMode} onChange={handlePermissionModeChange} />
                <ThinkingLevelPicker value={thinkingLevel} onChange={handleThinkingLevelChange} />
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
                    size: 'compact',
                  })}
                  title={submitState.action === 'queue' ? '加入消息队列' : '发送'}
                >
                  {submitState.label}
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

function AgentRoleRecommendationChips({
  recommendations,
  onSelect,
}: {
  recommendations: AgentInputRoleRecommendation[]
  onSelect: (recommendation: AgentInputRoleRecommendation) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="inline-flex h-6 items-center gap-1 rounded-full border border-[color:color-mix(in_oklab,var(--brand)_22%,transparent)] bg-[color:color-mix(in_oklab,var(--brand)_8%,transparent)] px-2 text-[11px] font-medium text-[var(--text-2)]">
        <Bot size={11} />
        推荐角色
      </span>
      {recommendations.map((recommendation) => (
        <Button
                variant="ghost"
          key={recommendation.role.id}
          type="button"
          onClick={() => onSelect(recommendation)}
          className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_86%,transparent)] px-2 text-[11px] text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_38%,var(--border-strong))] hover:text-[var(--text-1)]"
          title={`使用 ${recommendation.role.id} agent`}
        >
          <span className="truncate font-medium">{recommendation.label}</span>
          <span className="shrink-0 text-[var(--text-3)]">命中 {recommendation.score}</span>
        </Button>
      ))}
    </div>
  )
}

function setEditorPlainText(editor: NonNullable<ReturnType<typeof useEditor>>, text: string): void {
  editor.commands.setContent(
    text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line.length > 0 ? [{ type: 'text', text: line }] : undefined,
    })),
  )
  editor.commands.focus('end')
}

function createPendingAttachmentId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

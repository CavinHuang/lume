import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { Bot, Send, Square, FileText, Image, Paperclip, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { agentSend, getThreadMessages, onSidecarEvent, openFileDialog, sidecarCall } from '@/lib/desktop-api'
import { listChannels } from '@/lib/desktop-api/channel'
import { agentPlanModePhaseAtom, agentRuntimeEventsAtom, agentStreamingStatesAtom, agentThreadPermissionModesAtom, agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  AGENT_IPC_CHANNELS,
  LUME_CONFIG_IPC_CHANNELS,
  type AgentMessage,
  type AgentMessageAttachmentInput,
  type AgentSavedFile,
  type Channel,
  type LumeConfigAgentDefaultStrategy,
  type LumeEffectiveConfig,
  type LumeConfigThinkingLevel,
} from '@lume/shared'
import { appendRuntimeEvent } from '@/hooks/runtime-event-state'
import { MentionList } from './MentionList'
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
  resolveAgentInputConfigWorkspaceSlug,
  shouldSendAgentInputOnEnter,
  syncPermissionModeWithDefaultConfig,
  syncPermissionModeWithPlanModePhase,
} from './agent-input-state'
import { type MentionItem } from './slash-command-state'
import { createSuggestionRenderer } from './editor-mention-suggestions'
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

interface AgentInputProps {
  threadId: string
  streaming?: boolean
  pendingAttachments?: PendingMessageAttachment[]
  onAddPendingAttachments?: (attachments: PendingMessageAttachment[]) => void
  onRemovePendingAttachment?: (id: string) => void
  onClearPendingAttachments?: () => void
}

export interface PendingMessageAttachment {
  id: string
  filename: string
  mediaType: string
  size: number
  sourcePath?: string
  data?: string
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
}: AgentInputProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const thread = threads.find((item) => item.id === threadId)
  const planModePhase = useAtomValue(agentPlanModePhaseAtom)[threadId]
  const runtimeEvents = useAtomValue(agentRuntimeEventsAtom)[threadId]?.events ?? []
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const [threadPermissionModes, setThreadPermissionModes] = useAtom(agentThreadPermissionModesAtom)
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
  const [localSending, setLocalSending] = useState(false)
  const [historyMessages, setHistoryMessages] = useState<AgentMessage[]>([])
  const mentionSuggestionOpenRef = useRef(false)
  const [attachMenuOpen, setAttachMenuOpen] = useState(false)
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

  const getWorkspaceSlug = () => workspaceSlugRef.current
  const setMentionSuggestionOpen = useCallback((open: boolean) => {
    mentionSuggestionOpenRef.current = open
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false, bold: false, italic: false, strike: false }),
      Placeholder.configure({ placeholder: '输入任务... 支持 @Agent/@文件 /命令 $技能' }),
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
        suggestion: createSuggestionRenderer('/', threadId, '/', getWorkspaceSlug, setMentionSuggestionOpen),
      }),
      Mention.extend({ name: 'skillMention' }).configure({
        HTMLAttributes: {
          class: 'mention bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('$', threadId, '$', getWorkspaceSlug, setMentionSuggestionOpen),
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

  const composerState = deriveLumeComposerState({
    hasText: editorText.trim().length > 0 || pendingAttachments.length > 0,
    mode: streaming ? 'streaming' : localSending ? 'busy' : 'idle',
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

  const handleSend = useCallback(async () => {
    if (!editor || streaming || localSending) return
    const rawText = applyAgentRoleMentions(editor.getText()).trim()
    if (!rawText && pendingAttachments.length === 0) return

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
    editor.commands.clearContent()
    setEditorText('')
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
    try {
      await agentSend({
        threadId,
        userMessage: text,
        thinkingLevel,
        permissionMode,
        ...(messageAttachments.length > 0 ? { messageAttachments } : {}),
        ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}),
      })
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
    localSending,
    onClearPendingAttachments,
    pendingAttachments,
    permissionMode,
    setRuntimeEvents,
    setStreamingStates,
    streaming,
    thinkingLevel,
    threadId,
  ])
  sendNowRef.current = () => { void handleSend() }

  useEffect(() => () => cancelPendingDebouncedAgentInputSend(debouncedSend), [debouncedSend])

  const handleStop = async () => {
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.STOP_THREAD, { threadId })
    } catch (error) {
      console.error('[AgentInput] 停止失败:', error)
    }
  }

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

      onAddPendingAttachments(result.files.map((file) => ({
        id: createPendingAttachmentId(),
        filename: file.filename,
        mediaType: file.mediaType || 'application/octet-stream',
        size: file.size,
        sourcePath: file.sourcePath,
      })))
      toast.success(`已添加 ${result.files.length} 个文件`)
    } catch (error) {
      console.error('[AgentInput] 文件选择失败:', error)
      toast.error('文件选择失败')
    }
  }

  return (
    <div className="px-3 pb-4 pt-2">
      <div className="w-full px-14">
        <div data-agent-composer-anchor>
          <LumeComposer
            tone={composerState.tone}
            scale="compact"
            className="rounded-[1.6rem]"
            editorSlot={
              <EditorContent
                editor={editor}
                className="[&_.ProseMirror]:min-h-[72px] [&_.ProseMirror]:text-[14px] [&_.ProseMirror]:leading-7 [&_.ProseMirror]:text-[var(--text-1)] [&_.ProseMirror]:outline-none"
              />
            }
            supportingContent={
              pendingAttachments.length > 0 || roleRecommendations.length > 0 ? (
                <div className="space-y-2 px-3 pb-2">
                  {pendingAttachments.length > 0 && (
                    <PendingAttachmentChips
                      attachments={pendingAttachments}
                      onRemove={onRemovePendingAttachment}
                    />
                  )}
                  {roleRecommendations.length > 0 && (
                    <AgentRoleRecommendationChips
                      recommendations={roleRecommendations}
                      onSelect={applyRoleRecommendation}
                    />
                  )}
                </div>
              ) : undefined
            }
            leadingTools={
              <>
                <div className="relative">
                  <button
                    onClick={() => setAttachMenuOpen((v) => !v)}
                    className="inline-flex size-8 items-center justify-center rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_88%,transparent)] text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]"
                    title="添加"
                    type="button"
                  >
                    <Plus size={13} />
                  </button>
                  {attachMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setAttachMenuOpen(false)} />
                      <div className="absolute bottom-full left-0 z-50 mb-2 w-[140px] overflow-hidden rounded-[10px] border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-1)_96%,transparent)] shadow-[0_8px_30px_rgba(28,32,58,0.16)]">
                        <button
                          type="button"
                          onClick={() => { setAttachMenuOpen(false); handleAttach() }}
                          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_60%,transparent)]"
                        >
                          <FileText size={15} className="text-[var(--text-3)]" />
                          文件
                        </button>
                        <button
                          type="button"
                          onClick={() => { setAttachMenuOpen(false); handleAttach() }}
                          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-[var(--text-1)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_60%,transparent)]"
                        >
                          <Image size={15} className="text-[var(--text-3)]" />
                          图片
                        </button>
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
              composerState.showStop ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className="inline-flex h-8 items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--brand-2)_26%,transparent)] bg-[color:color-mix(in_oklab,var(--brand-2)_14%,var(--surface-2))] px-3 text-[11.5px] font-medium text-[var(--text-1)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand-2)_34%,transparent)]"
                  title="停止"
                >
                  <Square size={12} />
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  onClick={debouncedSend}
                  disabled={!composerState.canSend}
                  className={getLumeComposerPrimaryActionClassName({
                    enabled: composerState.canSend,
                    size: 'compact',
                  })}
                  title="发送"
                >
                  发送
                  <Send size={12} />
                </button>
              )
            }
          />
        </div>
      </div>
    </div>
  )
}

function PendingAttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PendingMessageAttachment[]
  onRemove: (id: string) => void
}) {
  return (
    <div className="relative flex flex-wrap gap-1.5">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_44%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_82%,transparent)] px-2 py-1 text-[11px] text-[var(--text-2)]"
          title={attachment.filename}
        >
          <Paperclip size={11} className="shrink-0 text-[var(--text-3)]" />
          <span className="min-w-0 truncate">{attachment.filename}</span>
          <span className="shrink-0 text-[var(--text-3)]">{formatAttachmentSize(attachment.size)}</span>
          <button
            type="button"
            onClick={() => onRemove(attachment.id)}
            className="ml-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[color:color-mix(in_oklab,var(--surface-3)_90%,transparent)] hover:text-[var(--text-1)]"
            title="移除附件"
          >
            <X size={10} />
          </button>
        </div>
      ))}
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
        <button
          key={recommendation.role.id}
          type="button"
          onClick={() => onSelect(recommendation)}
          className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_86%,transparent)] px-2 text-[11px] text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_38%,var(--border-strong))] hover:text-[var(--text-1)]"
          title={`使用 ${recommendation.role.id} agent`}
        >
          <span className="truncate font-medium">{recommendation.label}</span>
          <span className="shrink-0 text-[var(--text-3)]">命中 {recommendation.score}</span>
        </button>
      ))}
    </div>
  )
}

function createPendingAttachmentId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `attachment:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  const kb = size / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  return `${Math.round(kb / 1024)} MB`
}

import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { Bot, Send, Square, Paperclip, X } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom } from 'jotai'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { agentSend } from '@/lib/desktop-api'
import { openFileDialog, sidecarCall } from '@/lib/desktop-api'
import { listChannels } from '@/lib/desktop-api/channel'
import { agentPlanModePhaseAtom, agentRuntimeEventsAtom, agentStreamingStatesAtom, agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  AGENT_IPC_CHANNELS,
  type AgentMessageAttachmentInput,
  type AgentSavedFile,
  type Channel,
  type LumeConfigAgentDefaultStrategy,
  type LumeConfigThinkingLevel,
  type SkillMeta,
  type WorkspaceMcpConfig,
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
import { composerControlTriggerClassName } from './composer-control-styles'
import { cancelPendingDebouncedAgentInputSend, createDebouncedAgentInputSend } from './agent-input-send-debounce'
import { shouldSendAgentInputOnEnter, syncPermissionModeWithPlanModePhase } from './agent-input-state'
import { buildSlashSuggestionItems, type MentionItem } from './slash-command-state'
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

/** 获取各类 mention 的建议列表 */
async function fetchSuggestions(
  trigger: string,
  query: string,
  threadId: string,
  workspaceSlug: string | null
): Promise<MentionItem[]> {
  try {
    if (trigger === '@') {
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

    if (trigger === '/') {
      if (!workspaceSlug) return []
      const skills = await sidecarCall<SkillMeta[]>(AGENT_IPC_CHANNELS.GET_SKILLS, { workspaceSlug })
      const list = Array.isArray(skills) ? skills : []
      return buildSlashSuggestionItems(list, query)
    }

    if (trigger === '#') {
      if (!workspaceSlug) return []
      const result = await sidecarCall<WorkspaceMcpConfig>(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, { workspaceSlug })
      const entries = Object.entries(result?.servers ?? {})
      return entries
        .filter(([name, entry]) => entry.enabled && name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 10)
        .map(([name]) => ({ id: name, label: name, type: 'mcp' as const }))
    }
  } catch {
    // 静默
  }
  return []
}

/** 用 DOM 定位的浮动面板渲染 mention 建议 */
function createSuggestionRenderer(
  trigger: string,
  threadId: string,
  char: string,
  getWorkspaceSlug: () => string | null,
  setSuggestionOpen: (open: boolean) => void
) {
  return {
    char,
    items: ({ query }: { query: string }) => fetchSuggestions(trigger, query, threadId, getWorkspaceSlug()),
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
            props: { ...props, trigger: char as '@' | '/' | '#' },
            editor: props.editor,
          })
          wrapper.appendChild(component.element)

          updatePosition(wrapper, props, char)
        },

        onUpdate: (props: SuggestionProps) => {
          component?.updateProps(props)
          if (wrapper) updatePosition(wrapper, props, char)
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

function updatePosition(wrapper: HTMLDivElement, props: SuggestionProps, char: string) {
  const rect = props.clientRect?.()
  if (!rect) return

  if (char === '/') {
    const editorEl = props.editor.view.dom
    const anchor = editorEl.closest('[data-agent-composer-anchor]') as HTMLElement | null
    const anchorRect = anchor?.getBoundingClientRect()
    if (anchorRect) {
      wrapper.style.left = `${Math.max(12, anchorRect.left)}px`
      wrapper.style.width = `${Math.min(anchorRect.width, window.innerWidth - 24)}px`
      wrapper.style.bottom = `${window.innerHeight - anchorRect.top + 8}px`
      wrapper.style.top = 'auto'
      return
    }
  }

  // 面板显示在光标上方
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
  const workspaceIdRef = useRef<string | null>(null)
  const workspaceSlugRef = useRef<string | null>(null)
  const defaultPermissionModeRef = useRef<PermissionModeValue>('default')
  const autoSelectedPlanModeRef = useRef(false)
  const [thinkingLevel, setThinkingLevel] = useState<LumeConfigThinkingLevel>('off')
  const [permissionMode, setPermissionMode] = useState<PermissionModeValue>('default')
  const [channels, setChannels] = useState<Channel[]>([])
  const [channelsLoaded, setChannelsLoaded] = useState(false)
  const [defaultStrategy, setDefaultStrategy] = useState<LumeConfigAgentDefaultStrategy>({})
  const [editorText, setEditorText] = useState('')
  const [localSending, setLocalSending] = useState(false)
  const mentionSuggestionOpenRef = useRef(false)
  const sendNowRef = useRef<() => void>(() => undefined)
  const debouncedSend = useMemo(
    () => createDebouncedAgentInputSend(() => { sendNowRef.current() }),
    [threadId],
  )

  useEffect(() => {
    listChannels()
      .then((items) => setChannels(items))
      .catch(console.error)
      .finally(() => setChannelsLoaded(true))

    getEffectiveLumeConfig()
      .then((config) => {
        if (config.agent?.thinkingLevel) {
          setThinkingLevel(config.agent.thinkingLevel)
        }
        if (config.agent?.permissionMode) {
          defaultPermissionModeRef.current = config.agent.permissionMode
          setPermissionMode(config.agent.permissionMode)
        }
        setDefaultStrategy(config.models?.agent ?? {})
      })
      .catch(() => {})
  }, [])

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

  const getWorkspaceSlug = () => workspaceSlugRef.current
  const setMentionSuggestionOpen = useCallback((open: boolean) => {
    mentionSuggestionOpenRef.current = open
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Placeholder.configure({ placeholder: '输入任务... 支持 @Agent/@文件 /Skill #MCP' }),
      Mention.configure({
        HTMLAttributes: {
          class: 'mention bg-blue-500/10 text-blue-600 dark:text-blue-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('@', threadId, '@', getWorkspaceSlug, setMentionSuggestionOpen),
      }),
      Mention.extend({ name: 'skillMention' }).configure({
        HTMLAttributes: {
          class: 'mention bg-orange-500/10 text-orange-600 dark:text-orange-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('/', threadId, '/', getWorkspaceSlug, setMentionSuggestionOpen),
      }),
      Mention.extend({ name: 'mcpMention' }).configure({
        HTMLAttributes: {
          class: 'mention bg-purple-500/10 text-purple-600 dark:text-purple-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('#', threadId, '#', getWorkspaceSlug, setMentionSuggestionOpen),
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
                <button
                  onClick={handleAttach}
                  className={composerControlTriggerClassName}
                  title="附加文件"
                  type="button"
                >
                  <Paperclip size={13} />
                  文件
                </button>
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

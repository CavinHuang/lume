import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { Send, Square, Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { agentSend } from '@/lib/desktop-api'
import { openFileDialog, sidecarCall } from '@/lib/desktop-api'
import { agentPlanModePhaseAtom, agentRuntimeEventsAtom, agentStreamingStatesAtom, agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  AGENT_IPC_CHANNELS,
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
import { syncPermissionModeWithPlanModePhase } from './agent-input-state'
import { buildSlashSuggestionItems, type MentionItem } from './slash-command-state'

interface AgentInputProps {
  threadId: string
  streaming?: boolean
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
      const result = await sidecarCall(AGENT_IPC_CHANNELS.LIST_DIRECTORY, { threadId, path: '.' }) as {
        entries: Array<{ name: string; type: string }>
      }
      const entries = result?.entries ?? []
      return entries
        .filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 10)
        .map((e) => ({ id: e.name, label: e.name, type: 'file' as const }))
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
  getWorkspaceSlug: () => string | null
) {
  return {
    char,
    items: ({ query }: { query: string }) => fetchSuggestions(trigger, query, threadId, getWorkspaceSlug()),
    render: () => {
      let component: ReactRenderer<MentionListRef> | null = null
      let wrapper: HTMLDivElement | null = null

      return {
        onStart: (props: SuggestionProps) => {
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
            wrapper?.remove()
            return true
          }
          return component?.ref?.onKeyDown(props) ?? false
        },

        onExit: () => {
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

export function AgentInput({ threadId, streaming = false }: AgentInputProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const planModePhase = useAtomValue(agentPlanModePhaseAtom)[threadId]
  const setRuntimeEvents = useSetAtom(agentRuntimeEventsAtom)
  const setStreamingStates = useSetAtom(agentStreamingStatesAtom)
  const workspaceIdRef = useRef<string | null>(null)
  const workspaceSlugRef = useRef<string | null>(null)
  const defaultPermissionModeRef = useRef<PermissionModeValue>('default')
  const autoSelectedPlanModeRef = useRef(false)
  const [thinkingLevel, setThinkingLevel] = useState<LumeConfigThinkingLevel>('off')
  const [permissionMode, setPermissionMode] = useState<PermissionModeValue>('default')
  const [editorText, setEditorText] = useState('')

  useEffect(() => {
    getEffectiveLumeConfig()
      .then((config) => {
        if (config.agent?.thinkingLevel) {
          setThinkingLevel(config.agent.thinkingLevel)
        }
        if (config.agent?.permissionMode) {
          defaultPermissionModeRef.current = config.agent.permissionMode
          setPermissionMode(config.agent.permissionMode)
        }
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
    const thread = threads.find((t) => t.id === threadId)
    const targetId = thread?.workspaceId ?? currentWorkspaceId
    const ws = workspaces.find((w) => w.id === targetId)
    workspaceIdRef.current = ws?.id ?? null
    workspaceSlugRef.current = ws?.slug ?? null
  }, [threads, workspaces, currentWorkspaceId, threadId])

  const getWorkspaceSlug = () => workspaceSlugRef.current

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Placeholder.configure({ placeholder: '输入任务... 支持 @文件 /Skill #MCP' }),
      Mention.configure({
        HTMLAttributes: {
          class: 'mention bg-blue-500/10 text-blue-600 dark:text-blue-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('@', threadId, '@', getWorkspaceSlug),
      }),
      Mention.extend({ name: 'skillMention' }).configure({
        HTMLAttributes: {
          class: 'mention bg-orange-500/10 text-orange-600 dark:text-orange-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('/', threadId, '/', getWorkspaceSlug),
      }),
      Mention.extend({ name: 'mcpMention' }).configure({
        HTMLAttributes: {
          class: 'mention bg-purple-500/10 text-purple-600 dark:text-purple-400 px-0.5 rounded font-medium text-[13px]',
        },
        suggestion: createSuggestionRenderer('#', threadId, '#', getWorkspaceSlug),
      }),
    ],
    editorProps: {
      attributes: {
        class:
          'outline-none min-h-[72px] max-h-[220px] overflow-y-auto text-[14px] leading-7 text-[var(--text-1)]',
      },
      handleKeyDown(_, event) {
        if (event.key === 'Enter' && !event.shiftKey) {
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

  const composerState = deriveLumeComposerState({
    hasText: editorText.trim().length > 0,
    mode: streaming ? 'streaming' : 'idle',
  })

  const handleSend = async () => {
    if (!editor || streaming) return
    const text = editor.getText().trim()
    if (!text) return
    editor.commands.clearContent()
    setEditorText('')
    const createdAt = new Date().toISOString()
    setRuntimeEvents((prev) => appendRuntimeEvent(prev, {
      id: `optimistic:${threadId}:${createdAt}`,
      type: 'message.user.submitted',
      threadId,
      runId: `optimistic:${threadId}:${createdAt}`,
      createdAt,
      text,
    }))
    setStreamingStates((prev) => ({ ...prev, [threadId]: 'streaming' }))
    await agentSend({
      threadId,
      userMessage: text,
      thinkingLevel,
      permissionMode,
      ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}),
    })
  }

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

      await sidecarCall(AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD, {
        threadId,
        files: result.files.map((f) => ({
          filename: f.filename,
          sourcePath: f.sourcePath,
        })),
      })
      toast.success(`已添加 ${result.files.length} 个文件`)
    } catch (error) {
      console.error('[AgentInput] 文件上传失败:', error)
      toast.error('文件上传失败')
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
                  onClick={handleSend}
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

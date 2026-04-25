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
import { agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, agentSDKMessagesAtom } from '@/atoms'
import type { SDKMessage, LumeConfigThinkingLevel } from '@lume/shared'
import { MentionList } from './MentionList'
import { ModelPicker } from './ModelPicker'
import { ThinkingLevelPicker } from './ThinkingLevelPicker'
import type { MentionItem, MentionListRef } from './MentionList'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import type { SkillMeta, WorkspaceMcpConfig } from '@lume/shared'
import { getEffectiveLumeConfig } from '@/lib/desktop-api/lume-config'
import { getLumeComposerPrimaryActionClassName, LumeComposer } from '@/components/composer/LumeComposer'
import { deriveLumeComposerState } from '@/components/composer/lume-composer-state'

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
      const result = await sidecarCall('agent:list-directory', { threadId, path: '.' }) as {
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
      const skills = await sidecarCall<SkillMeta[]>('agent:get-skills', { workspaceSlug })
      const list = Array.isArray(skills) ? skills : []
      return list
        .filter((s) => {
          const q = query.toLowerCase()
          return s.name.toLowerCase().includes(q) || s.slug.toLowerCase().includes(q)
        })
        .slice(0, 10)
        .map((s) => ({ id: s.slug, label: s.name ?? s.slug, type: 'skill' as const }))
    }

    if (trigger === '#') {
      if (!workspaceSlug) return []
      const result = await sidecarCall<WorkspaceMcpConfig>('agent:get-mcp-config', { workspaceSlug })
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
            props,
            editor: props.editor,
          })
          wrapper.appendChild(component.element)

          updatePosition(wrapper, props)
        },

        onUpdate: (props: SuggestionProps) => {
          component?.updateProps(props)
          if (wrapper) updatePosition(wrapper, props)
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

function updatePosition(wrapper: HTMLDivElement, props: SuggestionProps) {
  const rect = props.clientRect?.()
  if (!rect) return
  // 面板显示在光标上方
  wrapper.style.left = `${rect.left}px`
  wrapper.style.bottom = `${window.innerHeight - rect.top + 4}px`
  wrapper.style.top = 'auto'
}

export function AgentInput({ threadId, streaming = false }: AgentInputProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const workspaceIdRef = useRef<string | null>(null)
  const workspaceSlugRef = useRef<string | null>(null)
  const [thinkingLevel, setThinkingLevel] = useState<LumeConfigThinkingLevel>('off')
  const [editorText, setEditorText] = useState('')

  useEffect(() => {
    getEffectiveLumeConfig()
      .then((config) => {
        if (config.agent?.thinkingLevel) {
          setThinkingLevel(config.agent.thinkingLevel)
        }
      })
      .catch(() => {})
  }, [])

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
    const now = Date.now()
    const userMsg = {
      type: 'user' as const,
      uuid: `user:${threadId}:${now}`,
      session_id: threadId,
      timestamp: new Date(now).toISOString(),
      parent_tool_use_id: null,
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text }]
      }
    } as unknown as SDKMessage
    setSDKMessages((prev) => ({
      ...prev,
      [threadId]: [...(prev[threadId] ?? []), userMsg],
    }))
    await agentSend({
      threadId,
      userMessage: text,
      thinkingLevel,
      ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}),
    })
  }

  const handleStop = async () => {
    try {
      await sidecarCall('agent:stop-thread', { threadId })
    } catch (error) {
      console.error('[AgentInput] 停止失败:', error)
    }
  }

  const handleAttach = async () => {
    try {
      const result = await openFileDialog()
      if (result.files.length === 0) return

      await sidecarCall('agent:save-files-to-thread', {
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
    <div className="px-4 pb-4 pt-2">
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
              className="inline-flex h-10 items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--border-strong)_56%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_72%,transparent)] px-3.5 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand)_18%,transparent)] hover:text-[var(--text-1)]"
              title="附加文件"
              type="button"
            >
              <Paperclip size={14} />
              文件
            </button>
            <ModelPicker threadId={threadId} />
            <ThinkingLevelPicker value={thinkingLevel} onChange={setThinkingLevel} />
          </>
        }
        actionSlot={
          composerState.showStop ? (
            <button
              type="button"
              onClick={handleStop}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--brand-2)_26%,transparent)] bg-[color:color-mix(in_oklab,var(--brand-2)_14%,var(--surface-2))] px-4 text-[12px] font-medium text-[var(--text-1)] transition-colors hover:border-[color:color-mix(in_oklab,var(--brand-2)_34%,transparent)]"
              title="停止"
            >
              <Square size={13} />
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
              <Send size={13} />
            </button>
          )
        }
      />
    </div>
  )
}

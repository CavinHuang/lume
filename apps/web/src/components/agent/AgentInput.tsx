import { useEditor, EditorContent, ReactRenderer } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { Send, Square, Paperclip } from 'lucide-react'
import { toast } from 'sonner'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { agentSend } from '@/lib/desktop-api'
import { openFileDialog, sidecarCall } from '@/lib/desktop-api'
import { agentThreadsAtom, agentWorkspacesAtom, currentWorkspaceIdAtom, agentSDKMessagesAtom } from '@/atoms'
import type { SDKMessage } from '@lume/shared'
import { MentionList } from './MentionList'
import { ModelPicker } from './ModelPicker'
import type { MentionItem, MentionListRef } from './MentionList'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import type { SkillMeta, WorkspaceMcpConfig } from '@lume/shared'

interface AgentInputProps {
  threadId: string
  disabled?: boolean
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

export function AgentInput({ threadId, disabled }: AgentInputProps) {
  const threads = useAtomValue(agentThreadsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const setSDKMessages = useSetAtom(agentSDKMessagesAtom)
  const workspaceSlugRef = useRef<string | null>(null)

  useEffect(() => {
    const thread = threads.find((t) => t.id === threadId)
    const targetId = thread?.workspaceId ?? currentWorkspaceId
    const ws = workspaces.find((w) => w.id === targetId)
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
      attributes: { class: 'outline-none min-h-[24px] max-h-[200px] overflow-y-auto text-[14px] leading-relaxed' },
      handleKeyDown(_, event) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          handleSend()
          return true
        }
        return false
      },
    },
  })

  const handleSend = async () => {
    if (!editor || disabled) return
    const text = editor.getText().trim()
    if (!text) return
    editor.commands.clearContent()
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
    await agentSend({ threadId, userMessage: text })
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
      <div className={cn(
        'rounded-2xl border border-border/60 bg-background shadow-sm transition-colors',
        disabled && 'opacity-60'
      )}>
        <div className="px-4 py-3">
          <EditorContent editor={editor} />
        </div>
        <div className="flex items-center justify-between px-3 pb-2 gap-2">
          <div className="flex items-center gap-1 min-w-0 flex-wrap">
            <button
              onClick={handleAttach}
              className="p-1.5 rounded-lg text-foreground/40 hover:text-foreground/70 hover:bg-muted/50 transition-colors"
              title="附加文件"
            >
              <Paperclip size={15} />
            </button>
            <ModelPicker threadId={threadId} />
          </div>
          {disabled ? (
            <button
              onClick={handleStop}
              className="p-1.5 rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
              title="停止"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              className="p-1.5 rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity"
              title="发送"
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

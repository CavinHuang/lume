import { listPlanningTodos } from '@/lib/desktop-api/planning-todo'
import { ReactRenderer } from '@tiptap/react'
import { sidecarCall } from '@/lib/desktop-api'
import { MentionList } from './MentionList'
import { buildSlashSuggestionItems } from './slash-command-state'
import type { MentionListRef } from './MentionList'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import type { MentionItem } from './slash-command-state'
import type { ListInvocableCapabilitiesResult } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { toast } from 'sonner'
import type { EditorOptions } from '@tiptap/core'
import { fetchFileMentionItems } from './agent-file-mentions'

type PasteEditorView = Parameters<NonNullable<EditorOptions['editorProps']['handlePaste']>>[0]

export { type MentionItem } from './slash-command-state'

async function fetchThreadCwd(threadId: string, workspaceSlug: string): Promise<string | null> {
  try {
    const threadPath = await sidecarCall<string>(AGENT_IPC_CHANNELS.GET_THREAD_PATH, {
      threadId,
      workspaceSlug,
    })
    const cwd = threadPath?.trim()
    return cwd ? cwd : null
  } catch {
    return null
  }
}

/** 获取各类 mention 的建议列表 */
export async function fetchSuggestions(
  trigger: string,
  query: string,
  threadId: string,
  workspaceSlug: string | null,
  workspaceId?: string | null,
): Promise<MentionItem[]> {
  try {
    if (trigger === '@') {
      const fileItems = await fetchFileMentionItems(query, workspaceSlug, threadId)
      return fileItems
    }
    if (trigger === '&') {
      const normalizedQuery = query.trim().toLocaleLowerCase()
      const all = normalizedQuery.startsWith('all ') || normalizedQuery.startsWith('全部 ')
      const search = all ? query.trim().replace(/^(?:all|全部)\s+/iu, '') : query.trim()
      const result = await listPlanningTodos({
        ...(all ? {} : workspaceId ? { workspaceId } : {}),
        scope: all ? 'all' : workspaceId ? 'current' : 'unassigned',
        view: 'open',
        ...(search ? { search } : {}),
        limit: 20,
      })
      return result.items.map((todo) => ({
        id: `planning:${todo.id}`,
        label: todo.title,
        title: `&${todo.title}`,
        subtitle: `${todo.workspaceId ? '当前项目' : '未分配'} · ${todo.priority}`,
        type: 'todo' as const,
        section: 'todo' as const,
        todoId: todo.id,
        relation: 'mentioned' as const,
        uri: todo.id,
      }))
    }
    if (trigger === '/') {
      const cwd = workspaceSlug && threadId ? await fetchThreadCwd(threadId, workspaceSlug) : null
      const result = await sidecarCall<ListInvocableCapabilitiesResult>(
        AGENT_IPC_CHANNELS.LIST_INVOCABLE_CAPABILITIES,
        {
          ...(workspaceSlug ? { workspaceSlug } : {}),
          ...(cwd ? { cwd } : {}),
        },
      )
      const items = buildSlashSuggestionItems(result.capabilities ?? [], query)
      return threadId === '__welcome__'
        ? items.filter((item) => item.id !== 'clear' && item.id !== 'compact')
        : items
    }
  } catch (error) {
    if (trigger === '&') {
      console.error('[AgentInput] Planning Todo 搜索失败:', error)
      toast.error('Planning Todo 搜索失败，请检查连接后重试')
      return []
    }
    if (trigger === '/') {
      const items = buildSlashSuggestionItems([], query)
      return threadId === '__welcome__'
        ? items.filter((item) => item.id !== 'clear' && item.id !== 'compact')
        : items
    }
  }
  return []
}

export function createCapabilityReferencePasteHandler(
  threadId: string,
  getWorkspaceSlug: () => string | null,
) {
  return (view: PasteEditorView, event: ClipboardEvent): boolean => {
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (
      text !== text.trim()
      || (!text.startsWith('lume-skill://') && !text.startsWith('lume-plugin://'))
    ) return false

    event.preventDefault()
    void fetchSuggestions('/', text, threadId, getWorkspaceSlug())
      .then((items) => {
        if (view.isDestroyed) return
        const item = items.find((candidate) => candidate.uri === text && !candidate.disabled)
        const nodeType = view.state.schema.nodes.capabilityMention
        if (!item || !nodeType) {
          view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.text(text)))
          return
        }
        const node = nodeType.create({
          id: item.id,
          label: item.label,
          uri: item.uri,
          kind: item.kind,
          occurrenceId: crypto.randomUUID(),
          iconUrl: item.iconUrl ?? null,
        })
        view.dispatch(view.state.tr.replaceSelectionWith(node))
      })
      .catch(() => {
        if (!view.isDestroyed) view.dispatch(view.state.tr.replaceSelectionWith(view.state.schema.text(text)))
      })
    return true
  }
}

/** 用 DOM 定位的浮动面板渲染 mention 建议 */
export function createSuggestionRenderer(
  trigger: string,
  threadId: string,
  char: string,
  getWorkspaceSlug: () => string | null,
  setSuggestionOpen: (open: boolean) => void,
  onCommandExecute?: (id: string) => void,
  onEscape?: () => void,
  getWorkspaceId?: () => string | null,
) {
  let itemsRequestSequence = 0
  let latestItems: MentionItem[] = []
  return {
    char,
    allow: ({ state, range }: { state: { doc: { textBetween: (from: number, to: number) => string } }; range: { from: number } }) => {
      if (char !== '/') return true
      const previous = state.doc.textBetween(Math.max(0, range.from - 1), range.from)
      return previous.length === 0 || /\s/.test(previous)
    },
    items: async ({ query }: { query: string }) => {
      const requestSequence = ++itemsRequestSequence
      const items = await fetchSuggestions(trigger, query, threadId, getWorkspaceSlug(), getWorkspaceId?.())
      if (requestSequence !== itemsRequestSequence) return latestItems
      latestItems = items
      return items
    },
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
            props: { ...props, trigger: char as '@' | '/' | '#' | '&', getWorkspaceSlug, onCommandExecute },
            editor: props.editor,
          })
          wrapper.appendChild(component.element)

          updatePosition(wrapper, props, char)
        },

        onUpdate: (props: SuggestionProps) => {
          component?.updateProps({ ...props, trigger: char as '@' | '/' | '#' | '&', getWorkspaceSlug, onCommandExecute })
          if (wrapper) updatePosition(wrapper, props, char)
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

function updatePosition(wrapper: HTMLDivElement, props: SuggestionProps, char: string) {
  const rect = props.clientRect?.()
  if (!rect) return

  if (char === '/' || char === '@') {
    const editorEl = props.editor.view.dom
    const composer = editorEl.closest('[data-tone]') as HTMLElement | null
    const composerRect = composer?.getBoundingClientRect()
    if (composer && composerRect) {
      const safeLeft = Math.max(12, composerRect.left)
      const safeWidth = Math.min(
        composerRect.width - Math.max(0, safeLeft - composerRect.left),
        window.innerWidth - safeLeft - 12,
      )
      wrapper.style.left = `${safeLeft}px`
      wrapper.style.width = `${safeWidth}px`
      wrapper.style.maxWidth = `${safeWidth}px`
      wrapper.style.boxSizing = 'border-box'
      wrapper.style.bottom = `${window.innerHeight - composerRect.top + 8}px`
      wrapper.style.top = 'auto'
      return
    }
  }

  const estimatedWidth = 360
  const safeLeft = Math.min(rect.left, window.innerWidth - estimatedWidth - 16)
  wrapper.style.left = `${Math.max(12, safeLeft)}px`
  wrapper.style.width = ''
  wrapper.style.bottom = `${window.innerHeight - rect.top + 4}px`
  wrapper.style.top = 'auto'
}

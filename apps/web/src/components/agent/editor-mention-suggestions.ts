import { ReactRenderer } from '@tiptap/react'
import { sidecarCall } from '@/lib/desktop-api'
import { MentionList } from './MentionList'
import { buildSlashSuggestionItems, formatSkillSuggestionMeta } from './slash-command-state'
import type { MentionListRef } from './MentionList'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import type { MentionItem } from './slash-command-state'
import type { EditableSkillMeta, WorkspaceMcpConfig } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'

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

function buildListEditableSkillsPayload(workspaceSlug: string, cwd: string | null) {
  return {
    workspaceSlug,
    ...(cwd ? { cwd } : {}),
  }
}

/** 获取各类 mention 的建议列表 */
export async function fetchSuggestions(
  trigger: string,
  query: string,
  threadId: string,
  workspaceSlug: string | null,
): Promise<MentionItem[]> {
  try {
    if (trigger === '/') {
      if (!workspaceSlug) return []
      const cwd = await fetchThreadCwd(threadId, workspaceSlug)
      const [skillsResult, mcpResult] = await Promise.all([
        sidecarCall<EditableSkillMeta[]>(
          AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS,
          buildListEditableSkillsPayload(workspaceSlug, cwd),
        ),
        sidecarCall<WorkspaceMcpConfig>(AGENT_IPC_CHANNELS.GET_MCP_CONFIG, { workspaceSlug }),
      ])
      const skills = Array.isArray(skillsResult) ? skillsResult : []
      const slashItems = buildSlashSuggestionItems(skills, query)
      const normalizedQuery = query.trim().toLowerCase()
      const mcpItems = Object.entries(mcpResult?.servers ?? {})
        .filter(([name, entry]) => entry.enabled && (!normalizedQuery || name.toLowerCase().includes(normalizedQuery)))
        .slice(0, 5)
        .map(([name]) => ({ id: name, label: name, type: 'mcp' as const }))
      return [...slashItems, ...mcpItems]
    }

    if (trigger === '$') {
      if (!workspaceSlug) return []
      const cwd = await fetchThreadCwd(threadId, workspaceSlug)
      const skillsResult = await sidecarCall<EditableSkillMeta[]>(
        AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS,
        buildListEditableSkillsPayload(workspaceSlug, cwd),
      )
      const skills = Array.isArray(skillsResult) ? skillsResult : []
      const normalizedQuery = query.trim().toLowerCase()
      return skills
        .filter((skill) => {
          if (!normalizedQuery) return true
          return [skill.slug, skill.name, skill.description, skill.whenToUse, skill.version].some(
            (v) => v?.toLowerCase().includes(normalizedQuery),
          )
        })
        .slice(0, 10)
        .map((skill) => ({
          id: skill.slug,
          label: skill.slug,
          type: 'skill' as const,
          title: `$${skill.slug}`,
          subtitle: skill.description ?? skill.whenToUse ?? skill.name,
          section: 'skill' as const,
          meta: formatSkillSuggestionMeta(skill),
        }))
    }
  } catch {
    // 静默
  }
  return []
}

/** 用 DOM 定位的浮动面板渲染 mention 建议 */
export function createSuggestionRenderer(
  trigger: string,
  threadId: string,
  char: string,
  getWorkspaceSlug: () => string | null,
  setSuggestionOpen: (open: boolean) => void,
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
            props: { ...props, trigger: char as '@' | '/' | '#' | '$', getWorkspaceSlug },
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

  if (char === '/' || char === '$') {
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

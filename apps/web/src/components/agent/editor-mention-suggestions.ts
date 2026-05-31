import { ReactRenderer } from '@tiptap/react'
import { sidecarCall } from '@/lib/desktop-api'
import { MentionList } from './MentionList'
import { buildSlashSuggestionItems } from './slash-command-state'
import type { MentionListRef } from './MentionList'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import type { MentionItem } from './slash-command-state'
import type { SkillMeta, WorkspaceMcpConfig } from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'

export { type MentionItem } from './slash-command-state'

/** 获取各类 mention 的建议列表 */
export async function fetchSuggestions(
  trigger: string,
  query: string,
  _threadId: string,
  workspaceSlug: string | null,
): Promise<MentionItem[]> {
  try {
    if (trigger === '/') {
      if (!workspaceSlug) return []
      const [skillsResult, mcpResult] = await Promise.all([
        sidecarCall<SkillMeta[]>(AGENT_IPC_CHANNELS.GET_SKILLS, { workspaceSlug }),
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
      const skillsResult = await sidecarCall<SkillMeta[]>(AGENT_IPC_CHANNELS.GET_SKILLS, { workspaceSlug })
      const skills = Array.isArray(skillsResult) ? skillsResult : []
      const normalizedQuery = query.trim().toLowerCase()
      return skills
        .filter((skill) => {
          if (!normalizedQuery) return true
          return [skill.slug, skill.name, skill.description].some(
            (v) => v?.toLowerCase().includes(normalizedQuery),
          )
        })
        .slice(0, 10)
        .map((skill) => ({
          id: skill.slug,
          label: skill.slug,
          type: 'skill' as const,
          title: `/${skill.slug}`,
          subtitle: skill.description ?? '工作区技能',
          section: 'skill' as const,
          meta: skill.version ?? '个人',
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

  const estimatedWidth = 360
  const safeLeft = Math.min(rect.left, window.innerWidth - estimatedWidth - 16)
  wrapper.style.left = `${Math.max(12, safeLeft)}px`
  wrapper.style.width = ''
  wrapper.style.bottom = `${window.innerHeight - rect.top + 4}px`
  wrapper.style.top = 'auto'
}

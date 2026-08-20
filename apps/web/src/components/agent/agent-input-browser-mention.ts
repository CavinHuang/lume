import { ReactRenderer } from '@tiptap/react'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import type { AgentBrowserAttachment, AgentBrowserTabAttachment, BrowserReferenceCandidate } from '@lume/shared'
import { listBrowserReferenceCandidates } from '@/lib/desktop-api'
import { MentionList, type MentionListRef } from './MentionList'
import { type MentionItem } from './slash-command-state'
import { buildAgentRoleMentionItems } from './agent-input-role-recommendations'
import { fetchLinkConnectionMentionItems, insertLinkConnectionMention } from './link-connection-mentions'
import { fetchFileMentionItems } from './agent-file-mentions'

const browserSuggestionCache = new Map<string, { expiresAt: number; value: Promise<BrowserReferenceCandidate[]> }>()

export function invalidateBrowserSuggestionCache(threadId?: string): void {
  if (threadId) browserSuggestionCache.delete(threadId)
  else browserSuggestionCache.clear()
}

function getBrowserSuggestionCandidates(threadId: string): Promise<BrowserReferenceCandidate[]> {
  for (const [key, entry] of browserSuggestionCache) if (entry.expiresAt <= Date.now()) browserSuggestionCache.delete(key)
  const cached = browserSuggestionCache.get(threadId)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  const value = listBrowserReferenceCandidates(threadId).catch(() => [])
  browserSuggestionCache.set(threadId, { expiresAt: Date.now() + 3_000, value })
  return value
}

/** 获取 @ 面板中的 Agent、项目文件和当前会话文件。 */
async function fetchAgentAndFileSuggestions(
  query: string,
  threadId: string,
  workspaceSlug: string | null,
): Promise<MentionItem[]> {
  const agentItems = buildAgentRoleMentionItems(query)
  const normalizedQuery = query.trim().toLowerCase()
  try {
    const [connectorItems, browserCandidates, fileItems] = await Promise.all([
      fetchLinkConnectionMentionItems(query),
      getBrowserSuggestionCandidates(threadId),
      fetchFileMentionItems(query, workspaceSlug, threadId),
    ])
    const browserItems = buildBrowserMentionItems(browserCandidates, normalizedQuery)
    return [...agentItems, ...connectorItems, ...browserItems, ...fileItems]
  } catch {
    return agentItems
  }
}

function buildBrowserMentionItems(candidates: BrowserReferenceCandidate[], query: string): MentionItem[] {
  return candidates
    .filter((candidate) => !query || `${candidate.title}\n${candidate.url}`.toLowerCase().includes(query))
    .map((candidate) => ({
      id: `${candidate.backend}:${candidate.tabId}`,
      label: candidate.title,
      title: candidate.title,
      subtitle: formatBrowserCandidateUrl(candidate.url),
      type: 'browser' as const,
      section: candidate.backend === 'iab' ? 'browser-tab' as const : 'chrome-page' as const,
      meta: candidate.backend === 'iab' ? '内置' : 'Chrome',
      browserCandidate: candidate,
    }))
}

function formatBrowserCandidateUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}` || value
  } catch { return value }
}

export function browserTabFromAttachment(attachment: AgentBrowserAttachment): AgentBrowserTabAttachment {
  return attachment.origin === 'browser-tab' ? attachment : attachment.tab
}

export type BrowserAnnotationAttachment = Extract<AgentBrowserAttachment, { origin: 'browser-annotation' }>

export function browserAnnotationTargetLabel(attachment: BrowserAnnotationAttachment): string {
  if (attachment.anchor.kind === 'text') return 'text'
  if (attachment.anchor.kind === 'region') return 'region'
  const segment = attachment.anchor.domPath?.split('>').at(-1)?.trim()
  return segment?.replace(/:.*/, '').toLowerCase() || 'element'
}

export function browserAnnotationPreview(attachment: BrowserAnnotationAttachment): string {
  return attachment.anchor.textQuote?.exact
    || attachment.anchor.selectedContent
    || attachment.body
}

export function sameBrowserTab(attachment: AgentBrowserAttachment, backend: 'iab' | 'extension', tabId: string): boolean {
  const tab = browserTabFromAttachment(attachment)
  return (tab.backend ?? 'iab') === backend && tab.tabId === tabId
}

/** AgentInput 专用的 @ suggestion renderer（包含 Agent、浏览器和文件）。 */
export function createAgentSuggestionRenderer(
  threadId: string,
  getWorkspaceSlug: () => string | null,
  setSuggestionOpen: (open: boolean) => void,
  onBrowserReferenceSelect: (item: MentionItem) => Promise<boolean>,
  onEscape?: () => void,
) {
  let itemsRequestSequence = 0
  let latestItems: MentionItem[] = []
  return {
    char: '@',
    items: async ({ query }: { query: string }) => {
      const requestSequence = ++itemsRequestSequence
      const items = await fetchAgentAndFileSuggestions(query, threadId, getWorkspaceSlug())
      if (requestSequence !== itemsRequestSequence) return latestItems
      latestItems = items
      return items
    },
    render: () => {
      let component: ReactRenderer<MentionListRef> | null = null
      let wrapper: HTMLDivElement | null = null
      let currentProps: SuggestionProps | null = null

      const selectBrowserReference = (item: MentionItem) => {
        const props = currentProps
        if (!props) return
        void onBrowserReferenceSelect(item).then((selected) => {
          if (!selected) return
          props.editor.chain().focus().deleteRange(props.range).run()
        })
      }

      const selectLinkConnectionReference = (item: MentionItem) => {
        const props = currentProps
        if (!props) return
        insertLinkConnectionMention(props.editor, props.range, item)
      }

      return {
        onStart: (props: SuggestionProps) => {
          currentProps = props
          setSuggestionOpen(true)
          wrapper = document.createElement('div')
          wrapper.style.position = 'fixed'
          wrapper.style.zIndex = '9999'
          document.body.appendChild(wrapper)

          component = new ReactRenderer(MentionList, {
            props: { ...props, trigger: '@' as const, onBrowserReferenceSelect: selectBrowserReference, onLinkConnectionReferenceSelect: selectLinkConnectionReference },
            editor: props.editor,
          })
          wrapper.appendChild(component.element)

          updateMentionPosition(wrapper, props)
        },

        onUpdate: (props: SuggestionProps) => {
          currentProps = props
          component?.updateProps({ ...props, trigger: '@' as const, onBrowserReferenceSelect: selectBrowserReference, onLinkConnectionReferenceSelect: selectLinkConnectionReference })
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
          currentProps = null
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

  const estimatedWidth = 360
  const safeLeft = Math.min(rect.left, window.innerWidth - estimatedWidth - 16)
  wrapper.style.left = `${Math.max(12, safeLeft)}px`
  wrapper.style.width = ''
  wrapper.style.maxWidth = ''
  wrapper.style.bottom = `${window.innerHeight - rect.top + 4}px`
  wrapper.style.top = 'auto'
}

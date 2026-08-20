import type { RuntimeAssistantBlock } from '../runtime-message-view'

export type MemoryCitationItem = Extract<RuntimeAssistantBlock, { type: 'memory_context_used' }>['event']['items'][number]
type MemoryCitationGroupKey = 'claims' | 'workspace_core' | 'global_preferences' | 'conversation_history' | 'maybe_stale' | 'relevant'

export function normalizeMemoryCitationPath(citation: string): string | null {
  const withoutLines = citation.replace(/#L\d+(?:-L?\d+)?$/i, '')
  const schemeMatch = withoutLines.match(/^[a-z]+:[a-z-]+:(\/.+)$/i)
  const path = schemeMatch?.[1] ?? (withoutLines.startsWith('/') ? withoutLines : '')
  return path.trim() || null
}

export function groupMemoryCitationItems(items: MemoryCitationItem[]): Array<{
  key: MemoryCitationGroupKey
  label: string
  items: MemoryCitationItem[]
}> {
  const groups: Record<MemoryCitationGroupKey, MemoryCitationItem[]> = {
    claims: [],
    workspace_core: [],
    global_preferences: [],
    conversation_history: [],
    maybe_stale: [],
    relevant: [],
  }

  for (const item of items) {
    groups[getMemoryCitationGroupKey(item)].push(item)
  }

  return [
    { key: 'claims' as const, label: '结构化事实', items: groups.claims },
    { key: 'workspace_core' as const, label: '工作区核心', items: groups.workspace_core },
    { key: 'global_preferences' as const, label: '全局偏好', items: groups.global_preferences },
    { key: 'conversation_history' as const, label: '历史连续性', items: groups.conversation_history },
    { key: 'maybe_stale' as const, label: '可能过期', items: groups.maybe_stale },
    { key: 'relevant' as const, label: '相关记忆', items: groups.relevant },
  ].filter((group) => group.items.length > 0)
}

function getMemoryCitationGroupKey(item: MemoryCitationItem): MemoryCitationGroupKey {
  if (item.status === 'suspected_stale') return 'maybe_stale'
  if (item.claim) return 'claims'
  if (isConversationHistoryCitation(item)) return 'conversation_history'
  if (item.scope === 'global' && item.kind === 'preference') return 'global_preferences'
  if (item.scope === 'workspace' && isWorkspaceCoreCitation(item)) return 'workspace_core'
  return 'relevant'
}

function isConversationHistoryCitation(item: MemoryCitationItem): boolean {
  return item.reason === 'recent daily memory'
    || item.reason === 'recent run memory'
    || /:(?:daily|run):/i.test(item.citation)
}

function isWorkspaceCoreCitation(item: MemoryCitationItem): boolean {
  return item.reason.includes('memory brief')
    || /workspace:memory:/i.test(item.citation)
    || /\/memory\/MEMORY\.md(?:#|$)/i.test(item.citation)
}

export function compactMemoryCitationLabel(citation: string): string {
  const withoutLines = citation.replace(/#L\d+(?:-L?\d+)?$/i, '')
  const withoutScheme = withoutLines.replace(/^[a-z]+:[a-z-]+:/i, '')
  return withoutScheme.split('/').filter(Boolean).at(-1) ?? withoutScheme
}

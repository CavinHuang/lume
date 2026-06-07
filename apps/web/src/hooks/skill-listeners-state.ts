import {
  AGENT_IPC_CHANNELS,
  type SkillImprovementSuggestedEvent,
  type SkillStorageScope,
  type ThreadSkillImprovementSuggestion,
} from '@lume/shared'

export interface SkillImprovementSuggestionToast {
  message: string
}

export interface PendingSkillImprovementSuggestion extends ThreadSkillImprovementSuggestion {
  key: string
}

export function skillImprovementSuggestionKey(
  suggestion: Pick<ThreadSkillImprovementSuggestion, 'workspaceSlug' | 'storageScope' | 'skillSlug' | 'cwd'>,
): string {
  const projectCwd = suggestion.storageScope === 'project'
    ? `${suggestion.cwd?.trim() ?? ''}:`
    : ''
  return `${suggestion.workspaceSlug}:${suggestion.storageScope}:${projectCwd}${suggestion.skillSlug}`
}

export function extractSkillImprovementSuggestions(
  method: string,
  params: unknown,
): PendingSkillImprovementSuggestion[] {
  if (method !== AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED) return []

  const notification = params as Partial<SkillImprovementSuggestedEvent>
  const suggestions = Array.isArray(notification.suggestions) ? notification.suggestions : []
  return suggestions.flatMap((suggestion) => {
    const workspaceSlug = suggestion.workspaceSlug?.trim()
    const skillSlug = suggestion.skillSlug?.trim()
    const storageScope = suggestion.storageScope
    const cwd = suggestion.cwd?.trim()
    if (!workspaceSlug || !skillSlug || (storageScope !== 'user' && storageScope !== 'project' && storageScope !== 'workspace')) {
      return []
    }
    return [{
      ...suggestion,
      workspaceSlug,
      skillSlug,
      storageScope,
      ...(storageScope === 'project' && cwd ? { cwd } : {}),
      key: skillImprovementSuggestionKey({ workspaceSlug, storageScope, skillSlug, cwd }),
    }]
  })
}

export function mergeSkillImprovementSuggestions(
  current: PendingSkillImprovementSuggestion[],
  next: PendingSkillImprovementSuggestion[],
): PendingSkillImprovementSuggestion[] {
  const merged = new Map(current.map((suggestion) => [suggestion.key, suggestion]))
  for (const suggestion of next) {
    merged.set(suggestion.key, suggestion)
  }
  return Array.from(merged.values())
}

export function buildSkillImprovementSuggestionToast(
  method: string,
  params: unknown
): SkillImprovementSuggestionToast | null {
  if (method !== AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED) return null

  const notification = params as Partial<SkillImprovementSuggestedEvent>
  const suggestions = Array.isArray(notification.suggestions) ? notification.suggestions : []
  if (suggestions.length === 0) return null

  const skillLabelByKey = new Map<string, string>()
  for (const suggestion of suggestions) {
    const slug = suggestion.skillSlug?.trim()
    if (!slug) continue
    const scope = suggestion.storageScope === 'user' || suggestion.storageScope === 'project' || suggestion.storageScope === 'workspace'
      ? suggestion.storageScope
      : undefined
    skillLabelByKey.set(
      scope
        ? skillImprovementSuggestionKey({
          workspaceSlug: suggestion.workspaceSlug ?? '',
          storageScope: scope,
          skillSlug: slug,
          cwd: suggestion.cwd,
        })
        : `unknown:${slug}`,
      scope ? `${slug}（${formatSkillSuggestionScopeLabel(scope)}）` : slug,
    )
  }
  const skillLabels = Array.from(skillLabelByKey.values())
  if (skillLabels.length === 0) return null

  const visibleSkillLabels = skillLabels.slice(0, 3)
  const skillLabel = skillLabels.length > 3
    ? `${visibleSkillLabels.join('、')} 等`
    : visibleSkillLabels.join('、')
  const updateCount = suggestions.reduce((sum, suggestion) => {
    return sum + (Array.isArray(suggestion.updates) ? suggestion.updates.length : 0)
  }, 0)
  const updateLabel = updateCount > 0 ? `，共 ${updateCount} 条建议` : ''

  return {
    message: `发现 ${skillLabels.length} 个技能可进化：${skillLabel}${updateLabel}`,
  }
}

function formatSkillSuggestionScopeLabel(scope: SkillStorageScope): string {
  if (scope === 'user') return '用户全局'
  if (scope === 'project') return '当前项目'
  return '工作区级'
}

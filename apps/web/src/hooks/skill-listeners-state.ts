import { AGENT_IPC_CHANNELS, type SkillImprovementSuggestedEvent } from '@lume/shared'

export interface SkillImprovementSuggestionToast {
  message: string
}

export function buildSkillImprovementSuggestionToast(
  method: string,
  params: unknown
): SkillImprovementSuggestionToast | null {
  if (method !== AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED) return null

  const notification = params as Partial<SkillImprovementSuggestedEvent>
  const suggestions = Array.isArray(notification.suggestions) ? notification.suggestions : []
  if (suggestions.length === 0) return null

  const skillSlugs = Array.from(
    new Set(
      suggestions
        .map((suggestion) => suggestion.skillSlug?.trim())
        .filter((slug): slug is string => Boolean(slug))
    )
  )
  if (skillSlugs.length === 0) return null

  const visibleSkillSlugs = skillSlugs.slice(0, 3)
  const skillLabel = skillSlugs.length > 3
    ? `${visibleSkillSlugs.join('、')} 等`
    : visibleSkillSlugs.join('、')
  const updateCount = suggestions.reduce((sum, suggestion) => {
    return sum + (Array.isArray(suggestion.updates) ? suggestion.updates.length : 0)
  }, 0)
  const updateLabel = updateCount > 0 ? `，共 ${updateCount} 条建议` : ''

  return {
    message: `发现 ${skillSlugs.length} 个技能可进化：${skillLabel}${updateLabel}`,
  }
}

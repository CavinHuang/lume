import type { EditableSkillMeta, SkillMeta, SkillStorageScope } from '@lume/shared'
import { getSkillAllowedToolOptions, type SkillSystemToolGroupId, type SkillToolDefinition } from './skill-tool-definitions'

export interface SkillSettingsDraft {
  mode: 'create' | 'edit'
  storageScope: SkillStorageScope
  skillSlug: string
  name: string
  description: string
  whenToUse: string
  allowedToolsText: string
  argumentHint: string
  disableModelInvocation: boolean
  version: string
  prompt: string
}

export interface SkillAllowedToolOptionRow extends SkillToolDefinition {
  selected: boolean
  disabled: boolean
  disabledReason?: string
}

export function filterSkillSettingsItems<T extends SkillMeta>(skills: T[], query: string): T[] {
  const queryText = query.trim().toLowerCase()
  const sorted = [...skills].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  if (!queryText) return sorted

  return sorted.filter((skill) => {
    const haystack = [
      skill.slug,
      skill.name,
      skill.description,
      skill.whenToUse,
      skill.argumentHint,
      ...(skill.allowedTools ?? []),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()

    return haystack.includes(queryText)
  })
}

export function isSelfOwnedSkill<T extends Pick<EditableSkillMeta, 'managementSurface'>>(skill: T): boolean {
  return skill.managementSurface !== 'market'
}

export function extractSkillPrompt(content: string): string {
  const match = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/)
  if (!match) return content
  return content.slice(match[0].length)
}

export function normalizeAllowedToolDraft(value: string): string[] {
  const seen = new Set<string>()
  const tools: string[] = []
  for (const item of value.split(/[\s,]+/)) {
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    tools.push(trimmed)
  }
  return tools
}

export function formatAllowedToolDraft(tools: string[] | undefined): string {
  return normalizeAllowedToolDraft((tools ?? []).join(', ')).join(', ')
}

export function buildAllowedToolOptionRows(
  value: string,
  disabledSystemGroupIds: SkillSystemToolGroupId[] = [],
): SkillAllowedToolOptionRow[] {
  const selected = new Set(normalizeAllowedToolDraft(value))
  const disabledGroups = new Set(disabledSystemGroupIds)
  return getSkillAllowedToolOptions().map((option) => ({
    ...option,
    selected: selected.has(option.value),
    disabled: option.disabled === true || disabledGroups.has(option.systemGroupId),
    ...(option.disabled === true
      ? { disabledReason: '暂未开放' }
      : disabledGroups.has(option.systemGroupId)
        ? { disabledReason: '系统工具已禁用' }
        : {}),
  }))
}

export function toggleAllowedToolDraft(value: string, tool: string): string {
  const normalized = normalizeAllowedToolDraft(value)
  if (normalized.includes(tool)) {
    return normalized.filter((item) => item !== tool).join(', ')
  }
  return [...normalized, tool].join(', ')
}

export function buildSkillDraftFromMeta(
  skill: SkillMeta | EditableSkillMeta,
  prompt: string,
): SkillSettingsDraft {
  return {
    mode: 'edit',
    storageScope: 'storageScope' in skill ? skill.storageScope : 'workspace',
    skillSlug: skill.slug,
    name: skill.name,
    description: skill.description ?? '',
    whenToUse: skill.whenToUse ?? '',
    allowedToolsText: formatAllowedToolDraft(skill.allowedTools),
    argumentHint: skill.argumentHint ?? '',
    disableModelInvocation: skill.disableModelInvocation ?? false,
    version: skill.version ?? '',
    prompt,
  }
}

export function createEmptySkillDraft(storageScope: SkillStorageScope = 'workspace'): SkillSettingsDraft {
  return {
    mode: 'create',
    storageScope,
    skillSlug: '',
    name: '',
    description: '',
    whenToUse: '',
    allowedToolsText: '',
    argumentHint: '',
    disableModelInvocation: false,
    version: '',
    prompt: '',
  }
}

export function getSkillDraftValidationError(draft: SkillSettingsDraft): string | null {
  if (!draft.skillSlug.trim() || !draft.name.trim()) {
    return '技能 ID 和展示名称不能为空'
  }
  if (!draft.description.trim() || !draft.whenToUse.trim() || !draft.prompt.trim()) {
    return '描述、触发条件和提示词内容不能为空'
  }
  return null
}

export const SKILL_STORAGE_SCOPE_LABELS: Record<SkillStorageScope, string> = {
  workspace: 'Lume 工作区',
  project: '当前项目 (.alice/skills/)',
  user: '用户全局',
}

export const SKILL_STORAGE_SCOPE_EMPTY_LABELS: Record<SkillStorageScope, string> = {
  workspace: '当前 Lume 工作区没有匹配的自有技能。',
  project: '当前项目没有匹配的自有技能。',
  user: '当前用户全局没有匹配的自有技能。',
}

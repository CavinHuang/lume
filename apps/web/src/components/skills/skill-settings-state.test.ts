import { describe, expect, test } from 'bun:test'
import {
  buildAllowedToolOptionRows,
  buildSkillDraftFromMeta,
  createEmptySkillDraft,
  extractSkillPrompt,
  filterSkillSettingsItems,
  getSkillDraftValidationError,
  isSelfOwnedSkill,
  normalizeAllowedToolDraft,
  toggleAllowedToolDraft,
} from './skill-settings-state'

describe('skill-settings-state', () => {
  test('filters workspace skills by name, slug, description, trigger, and tools', () => {
    const skills = [
      { slug: 'code-review', name: '代码审查', description: '检查代码质量', allowedTools: ['read_file'] },
      { slug: 'writer', name: '写作工作流', whenToUse: '当用户要写文章', allowedTools: ['web_search'] },
    ]

    expect(filterSkillSettingsItems(skills, 'review').map((item) => item.slug)).toEqual(['code-review'])
    expect(filterSkillSettingsItems(skills, '文章').map((item) => item.slug)).toEqual(['writer'])
    expect(filterSkillSettingsItems(skills, 'web_search').map((item) => item.slug)).toEqual(['writer'])
    expect(filterSkillSettingsItems(skills, '').map((item) => item.slug)).toEqual(['code-review', 'writer'])
  })

  test('keeps market-managed skills out of skill settings ownership lists', () => {
    const skills = [
      { slug: 'private-helper', name: 'Private Helper', storageScope: 'workspace' as const, managementSurface: 'settings' as const },
      { slug: 'market-review', name: 'Market Review', storageScope: 'workspace' as const, managementSurface: 'market' as const },
      { slug: 'legacy-helper', name: 'Legacy Helper', storageScope: 'workspace' as const },
    ]

    expect(skills.filter(isSelfOwnedSkill).map((skill) => skill.slug)).toEqual([
      'private-helper',
      'legacy-helper',
    ])
  })

  test('extracts prompt content after YAML frontmatter', () => {
    expect(extractSkillPrompt('---\nname: Demo\n---\n\nPrompt body.\n')).toBe('Prompt body.\n')
    expect(extractSkillPrompt('# Demo\n\nNo frontmatter.')).toBe('# Demo\n\nNo frontmatter.')
  })

  test('builds editable drafts with normalized allowed tools', () => {
    expect(normalizeAllowedToolDraft(' bash, read_file\nbash  grep ')).toEqual(['bash', 'read_file', 'grep'])
    expect(buildSkillDraftFromMeta({
      slug: 'planner',
      name: 'Planner',
      storageScope: 'user',
      description: 'Plans work',
      allowedTools: ['bash', 'bash', 'read_file'],
      disableModelInvocation: true,
    }, 'Prompt.')).toEqual({
      mode: 'edit',
      storageScope: 'user',
      skillSlug: 'planner',
      name: 'Planner',
      description: 'Plans work',
      whenToUse: '',
      allowedToolsText: 'bash, read_file',
      argumentHint: '',
      disableModelInvocation: true,
      version: '',
      prompt: 'Prompt.',
    })
  })

  test('creates an empty draft for new workspace skills', () => {
    expect(createEmptySkillDraft()).toMatchObject({
      mode: 'create',
      storageScope: 'workspace',
      skillSlug: '',
      name: '',
      disableModelInvocation: false,
      prompt: '',
    })
    expect(createEmptySkillDraft('user')).toMatchObject({
      mode: 'create',
      storageScope: 'user',
    })
  })

  test('requires Alice core fields before saving a skill draft', () => {
    expect(getSkillDraftValidationError({
      ...createEmptySkillDraft(),
      skillSlug: 'planner',
      name: 'Planner',
      description: '',
      whenToUse: 'When planning is needed.',
      prompt: 'Plan carefully.',
    })).toBe('描述、触发条件和提示词内容不能为空')
    expect(getSkillDraftValidationError({
      ...createEmptySkillDraft(),
      skillSlug: 'planner',
      name: 'Planner',
      description: 'Plans work.',
      whenToUse: 'When planning is needed.',
      prompt: 'Plan carefully.',
    })).toBeNull()
  })

  test('builds selectable allowed tool option rows from the draft text', () => {
    const rows = buildAllowedToolOptionRows('bash, read_file, custom_tool')

    expect(rows.find((row) => row.value === 'bash')).toMatchObject({
      selected: true,
      disabled: false,
    })
    expect(rows.find((row) => row.value === 'write_file')).toMatchObject({
      selected: false,
      disabled: false,
    })
    expect(rows.find((row) => row.value === 'agent_spawn')).toMatchObject({
      selected: false,
      disabled: true,
    })
  })

  test('disables tool chips whose system tool group is disabled', () => {
    const rows = buildAllowedToolOptionRows('web_search, bash', ['web'])

    expect(rows.find((row) => row.value === 'web_search')).toMatchObject({
      selected: true,
      disabled: true,
      disabledReason: '系统工具已禁用',
    })
    expect(rows.find((row) => row.value === 'web_fetch')).toMatchObject({
      selected: false,
      disabled: true,
      disabledReason: '系统工具已禁用',
    })
    expect(rows.find((row) => row.value === 'bash')).toMatchObject({
      selected: true,
      disabled: false,
    })
  })

  test('toggles common allowed tool chips while preserving custom tools', () => {
    expect(toggleAllowedToolDraft('bash, custom_tool', 'read_file')).toBe('bash, custom_tool, read_file')
    expect(toggleAllowedToolDraft('bash, custom_tool, read_file', 'bash')).toBe('custom_tool, read_file')
    expect(toggleAllowedToolDraft('bash, bash', 'bash')).toBe('')
  })
})

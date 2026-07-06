import type { SkillMeta, SkillStorageScope } from '@lume/shared'

export type MentionItemType = 'file' | 'skill' | 'mcp' | 'command' | 'agent' | 'plugin'
export type MentionSection = 'capability' | 'skill' | 'agent' | 'file' | 'plugin'

export interface MentionItem {
  id: string
  label: string
  type: MentionItemType
  title?: string
  subtitle?: string
  section?: MentionSection
  meta?: string
  /** 选中即执行：不插入编辑器文本，直接触发 onCommandExecute(id) */
  executeOnSelect?: boolean
}

type CommonSlashCommand = Pick<MentionItem, 'id' | 'label' | 'type' | 'title' | 'subtitle' | 'section' | 'executeOnSelect'> & {
  keywords: string[]
}

type SuggestionSkill = SkillMeta & {
  storageScope?: SkillStorageScope
}

const COMMON_SLASH_COMMANDS: CommonSlashCommand[] = [
  {
    id: 'clear',
    label: 'clear',
    type: 'command',
    title: '/clear',
    subtitle: '清空当前对话上下文',
    section: 'capability',
    keywords: ['clear', 'context', 'history', '清空', '上下文'],
    executeOnSelect: true,
  },
  {
    id: 'compact',
    label: 'compact',
    type: 'command',
    title: '/compact',
    subtitle: '压缩当前对话历史，减少上下文占用',
    section: 'capability',
    keywords: ['compact', 'compress', 'history', '压缩', '历史'],
    executeOnSelect: true,
  },
{
    id: 'mcp',
    label: 'mcp',
    type: 'command',
    title: '/mcp',
    subtitle: '查看 MCP 服务状态与可用连接',
    section: 'capability',
    keywords: ['mcp', 'server', 'tools', '状态', '工具'],
  },
  {
    id: 'reload-plugins',
    label: 'reload-plugins',
    type: 'command',
    title: '/reload-plugins',
    subtitle: '重新加载插件与扩展能力',
    section: 'capability',
    keywords: ['reload', 'plugins', 'extensions', '重载', '插件'],
    executeOnSelect: true,
  },
]

export function getCommonSlashSuggestionItems(): MentionItem[] {
  return COMMON_SLASH_COMMANDS.map(({ keywords: _keywords, ...item }) => item)
}

function includesQuery(values: Array<string | undefined>, normalizedQuery: string) {
  if (!normalizedQuery) return true
  return values.some((value) => value?.toLowerCase().includes(normalizedQuery))
}

export function formatSkillSuggestionMeta(skill: SuggestionSkill) {
  if (!skill.storageScope) return skill.version ?? '个人'
  const scopeLabel = skill.storageScope === 'user'
    ? '用户全局'
    : skill.storageScope === 'project'
      ? '当前项目'
      : skill.storageScope === 'plugin'
        ? '插件'
        : 'Lume 工作区'
  return skill.version ? `${scopeLabel} · ${skill.version}` : scopeLabel
}

export function buildSlashSuggestionItems(skills: SuggestionSkill[], query: string): MentionItem[] {
  const normalizedQuery = query.trim().toLowerCase()

  const commonCommands = COMMON_SLASH_COMMANDS
    .filter((item) => includesQuery([item.id, item.title, item.subtitle, ...item.keywords], normalizedQuery))
    .map(({ keywords: _keywords, ...item }) => item)

  const skillItems = skills
    .filter((skill) => {
      return includesQuery(
        [skill.slug, skill.name, skill.description, skill.whenToUse, skill.version, skill.icon],
        normalizedQuery,
      )
    })
    .slice(0, normalizedQuery ? 8 : 6)
    .map((skill) => ({
      id: skill.slug,
      label: skill.slug,
      type: 'skill' as const,
      title: `/${skill.slug}`,
      subtitle: skill.description ?? (skill.name && skill.name !== skill.slug ? skill.name : '工作区技能'),
      section: 'skill' as const,
      meta: formatSkillSuggestionMeta(skill),
    }))

  return [...commonCommands, ...skillItems]
}

export function normalizeSlashSuggestionItems(items: MentionItem[]): MentionItem[] {
  const normalizedItems = items.map((item) => {
    if (item.type !== 'skill') return item
    return {
      ...item,
      label: item.label || item.id,
      title: item.title ?? `/${item.label || item.id}`,
      subtitle: item.subtitle ?? '工作区技能',
      section: item.section ?? 'skill',
      meta: item.meta ?? '个人',
    }
  })

  if (normalizedItems.some((item) => item.type === 'command')) {
    return normalizedItems
  }

  return [...getCommonSlashSuggestionItems(), ...normalizedItems]
}

export interface PluginMentionSource {
  name: string
  displayName?: string
  description?: string
}

/**
 * 构造插件 mention 建议项（% 触发）。
 * label 带 % 前缀，作为输入框/发送/气泡三段统一的 token（%插件名）。
 */
export function buildPluginSuggestionItems(plugins: PluginMentionSource[], query: string): MentionItem[] {
  const normalizedQuery = query.trim().toLowerCase()
  return plugins
    .filter((plugin) => !normalizedQuery
      || [plugin.name, plugin.displayName, plugin.description].some((value) => value?.toLowerCase().includes(normalizedQuery)))
    .slice(0, 10)
    .map((plugin) => ({
      id: plugin.name,
      label: `%${plugin.displayName || plugin.name}`,
      type: 'plugin' as const,
      title: plugin.displayName || plugin.name,
      subtitle: plugin.description ?? '插件',
      section: 'plugin' as const,
    }))
}

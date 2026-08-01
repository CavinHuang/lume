import type { AgentInvocableCapabilityItem } from '@lume/shared'

export type MentionItemType = 'file' | 'skill' | 'mcp' | 'command' | 'agent' | 'plugin' | 'todo'
export type MentionSection = 'capability' | 'skill' | 'agent' | 'file' | 'plugin' | 'todo'

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
  uri?: string
  kind?: AgentInvocableCapabilityItem['kind']
  iconUrl?: string
  disabled?: boolean
  disabledReason?: string
  todoId?: string
  relation?: 'mentioned' | 'primary'
}

type CommonSlashCommand = Pick<MentionItem, 'id' | 'label' | 'type' | 'title' | 'subtitle' | 'section' | 'executeOnSelect'> & {
  keywords: string[]
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

function formatCapabilityMeta(capability: AgentInvocableCapabilityItem) {
  const scopeLabel = capability.scope === 'user'
    ? '用户全局'
    : capability.scope === 'project'
      ? '当前项目'
      : capability.scope === 'workspace'
        ? 'Lume 工作区'
        : capability.scope === 'workspace-plugin'
          ? '工作区插件'
          : '全局插件'
  return capability.version ? `${scopeLabel} · ${capability.version}` : scopeLabel
}

function formatCapabilityUnavailableReason(reason: AgentInvocableCapabilityItem['unavailableReason']): string | undefined {
  if (reason === 'disabled') return '未启用'
  if (reason === 'needs-review') return '需要权限审核'
  if (reason === 'no-invocable-skills') return '没有可调用技能'
  if (reason === 'legacy-definition') return '暂不支持从输入框调用'
  if (reason === 'ambiguous') return '存在同名冲突'
  if (reason === 'not-in-workspace') return '当前工作区不可用'
  return undefined
}

export function buildSlashSuggestionItems(capabilities: AgentInvocableCapabilityItem[], query: string): MentionItem[] {
  const normalizedQuery = query.trim().toLowerCase()

  const commonCommands = COMMON_SLASH_COMMANDS
    .filter((item) => includesQuery([item.id, item.title, item.subtitle, ...item.keywords], normalizedQuery))
    .map(({ keywords: _keywords, ...item }) => item)

  const capabilityItems = capabilities
    .filter((capability) => {
      return includesQuery(
        [capability.uri, capability.displayName, capability.description, capability.version, capability.pluginId, capability.skillSlug],
        normalizedQuery,
      )
    })
    .map((capability) => {
      const unavailableReason = formatCapabilityUnavailableReason(capability.unavailableReason)
      return {
        id: capability.uri,
        label: capability.displayName,
        type: capability.kind === 'plugin' ? 'plugin' as const : 'skill' as const,
        title: capability.displayName,
        subtitle: capability.description ?? capability.uri,
        section: capability.kind === 'skill' ? 'skill' as const : 'plugin' as const,
        meta: unavailableReason ?? formatCapabilityMeta(capability),
        uri: capability.uri,
        kind: capability.kind,
        iconUrl: capability.icon?.url,
        disabled: !capability.callable,
        disabledReason: unavailableReason,
      }
    })

  const sectionLimit = normalizedQuery ? 12 : 10
  const skillItems = capabilityItems.filter((item) => item.section === 'skill').slice(0, sectionLimit)
  const pluginItems = capabilityItems
    .filter((item) => item.section === 'plugin')
    .sort((left, right) => Number(right.kind === 'plugin') - Number(left.kind === 'plugin'))
    .slice(0, sectionLimit)

  return [...commonCommands, ...skillItems, ...pluginItems]
}

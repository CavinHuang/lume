import type { LumeConfigPermissionsSection } from '@lume/shared'
import { TOOL_METADATA } from '@/components/settings/tool-metadata'
import type { SkillSystemToolGroupId } from './skill-tool-definitions'

export interface SystemToolGroup {
  id: SkillSystemToolGroupId
  label: string
  description: string
  count: number
  locked: boolean
  policyEntry?: string
}

export interface SystemToolRow extends SystemToolGroup {
  enabled: boolean
}

/** 判断工具是否属于指定的工具组 */
export function isToolInGroup(toolName: string, groupId: string): boolean {
  switch (groupId) {
    case 'shell':
      return toolName === 'bash'
    case 'file-read':
      return ['read', 'find', 'ls'].includes(toolName)
    case 'file-write':
      return ['write', 'edit', 'multi-edit', 'notebook_edit'].includes(toolName)
    case 'search':
      return ['find', 'grep', 'ls'].includes(toolName)
    case 'web':
      return ['web_search', 'web_fetch'].includes(toolName)
    case 'data':
      return ['guanlan_search', 'guanlan_read', 'guanlan_hotnews', 'guanlan_research'].includes(toolName)
    case 'memory':
      return ['memory.search', 'memory.read', 'memory.remember', 'memory.forget'].includes(toolName)
    case 'agent':
      return ['agent_spawn', 'skill'].includes(toolName)
    case 'task':
      return ['task_create', 'task_list', 'task_update', 'task_get', 'task_stop', 'task_output'].includes(toolName)
    case 'automation':
      return toolName === 'automation_set'
    case 'user-interaction':
      return ['ask_user_question', 'todo_write'].includes(toolName)
    case 'channel':
      return toolName === 'send_im_message'
    case 'evolution':
      return toolName === 'personalize_ui'
    case 'reading':
      return [
        'lume_reading_snapshot',
        'lume_add_book',
        'lume_write_reading_note',
        'lume_hide_reading_note',
        'lume_revise_reading_note',
        'lume_generate_share_card',
        'weread_generate_note',
        'weread_export_all_notes',
        'weread_shelf',
        'weread_notebooks',
        'weread_reading_profile',
        'weread_bookmarks',
        'weread_best_bookmarks',
        'weread_reviews',
        'weread_public_reviews',
        'weread_readdata',
        'weread_search',
        'weread_book_info',
        'weread_chapters',
        'weread_book_context',
        'weread_recommend',
        'weread_similar',
      ].includes(toolName)
    default:
      return false
  }
}

/** 根据 TOOL_METADATA 动态统计每个工具组的工具数量 */
function countToolsByGroup(groupId: SkillSystemToolGroupId): number {
  return Object.keys(TOOL_METADATA).filter((name) => isToolInGroup(name, groupId)).length
}

export const SYSTEM_TOOL_GROUPS: SystemToolGroup[] = [
  {
    id: 'shell',
    label: 'Shell',
    description: '执行 Shell 命令',
    count: countToolsByGroup('shell'),
    locked: false,
    policyEntry: 'group:runtime',
  },
  {
    id: 'file-read',
    label: '文件读取',
    description: '读取文件与目录结构',
    count: countToolsByGroup('file-read'),
    locked: true,
  },
  {
    id: 'file-write',
    label: '文件写入',
    description: '创建与编辑文件',
    count: countToolsByGroup('file-write'),
    locked: true,
  },
  {
    id: 'search',
    label: '搜索',
    description: '文件内容与路径搜索',
    count: countToolsByGroup('search'),
    locked: true,
  },
  {
    id: 'web',
    label: 'Web',
    description: '网页抓取与网络搜索',
    count: countToolsByGroup('web'),
    locked: false,
    policyEntry: 'group:web',
  },
  {
    id: 'data',
    label: '数据查询',
    description: '股份行情、天气预报、IP 归属地等专业数据',
    count: countToolsByGroup('data'),
    locked: false,
    policyEntry: 'group:data',
  },
  {
    id: 'memory',
    label: '记忆',
    description: '用户记忆读写与检索',
    count: countToolsByGroup('memory'),
    locked: true,
  },
  {
    id: 'agent',
    label: 'Agent',
    description: '子 Agent 调度与技能调用',
    count: countToolsByGroup('agent'),
    locked: true,
  },
  {
    id: 'task',
    label: '任务',
    description: '会话任务列表管理',
    count: countToolsByGroup('task'),
    locked: true,
  },
  {
    id: 'automation',
    label: '定时任务',
    description: 'AI 创建和管理定时执行的任务',
    count: countToolsByGroup('automation'),
    locked: false,
    policyEntry: 'group:automation',
  },
  {
    id: 'user-interaction',
    label: '用户交互',
    description: 'Plan 模式切换与用户提问',
    count: countToolsByGroup('user-interaction'),
    locked: true,
  },
  {
    id: 'channel',
    label: '渠道',
    description: '向已绑定外部会话发送消息',
    count: countToolsByGroup('channel'),
    locked: false,
    policyEntry: 'group:im',
  },
  {
    id: 'evolution',
    label: '自进化',
    description: 'AI 自主定制页面、Widget、UI 外观',
    count: countToolsByGroup('evolution'),
    locked: false,
    policyEntry: 'group:evolution',
  },
  {
    id: 'reading',
    label: '阅读',
    description: 'Lume Reading 与微信读书工具',
    count: countToolsByGroup('reading'),
    locked: false,
    policyEntry: 'group:reading',
  },
]

export function buildSystemToolRows(denyEntries: string[] = []): SystemToolRow[] {
  const denied = new Set(normalizePolicyEntries(denyEntries))
  return SYSTEM_TOOL_GROUPS.map((group) => ({
    ...group,
    enabled: group.locked || !group.policyEntry || !denied.has(group.policyEntry),
  }))
}

export function findSystemToolGroup(id: SkillSystemToolGroupId): SystemToolGroup {
  const group = SYSTEM_TOOL_GROUPS.find((item) => item.id === id)
  if (!group) {
    throw new Error(`Unknown system tool group: ${id}`)
  }
  return group
}

export function toggleSystemToolGroupDeny(
  denyEntries: string[] = [],
  policyEntry: string,
  enabled: boolean,
): string[] {
  const withoutEntry = normalizePolicyEntries(denyEntries).filter((entry) => entry !== policyEntry)
  if (enabled) return withoutEntry
  return [...withoutEntry, policyEntry]
}

export function buildSystemToolPermissionsSection(
  current: LumeConfigPermissionsSection = {},
  group: SystemToolGroup,
  enabled: boolean,
): LumeConfigPermissionsSection {
  if (group.locked || !group.policyEntry) return current
  const toolPolicy = current.toolPolicy ?? {}
  return {
    ...current,
    toolPolicy: {
      ...toolPolicy,
      deny: toggleSystemToolGroupDeny(toolPolicy.deny, group.policyEntry, enabled),
    },
  }
}

function normalizePolicyEntries(entries: string[] = []): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const entry of entries) {
    const value = entry.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}

import type { LumeConfigPermissionsSection } from '@lume/shared'
import { getSystemToolDefinitionValues, type SkillSystemToolGroupId } from './skill-tool-definitions'

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

function toolCount(groupId: SkillSystemToolGroupId, fallback: number): number {
  return getSystemToolDefinitionValues(groupId).length || fallback
}

export const SYSTEM_TOOL_GROUPS: SystemToolGroup[] = [
  {
    id: 'shell',
    label: 'Shell',
    description: '执行 Shell 命令',
    count: toolCount('shell', 1),
    locked: false,
    policyEntry: 'group:runtime',
  },
  {
    id: 'file-read',
    label: '文件读取',
    description: '读取文件与目录结构',
    count: toolCount('file-read', 3),
    locked: true,
  },
  {
    id: 'file-write',
    label: '文件写入',
    description: '创建与编辑文件',
    count: toolCount('file-write', 2),
    locked: true,
  },
  {
    id: 'search',
    label: '搜索',
    description: '文件内容与路径搜索',
    count: toolCount('search', 3),
    locked: true,
  },
  {
    id: 'code-intelligence',
    label: '代码智能',
    description: 'LSP 代码理解与符号查询',
    count: 1,
    locked: true,
  },
  {
    id: 'web',
    label: 'Web',
    description: '网页抓取与网络搜索',
    count: toolCount('web', 2),
    locked: false,
    policyEntry: 'group:web',
  },
  {
    id: 'data',
    label: '数据查询',
    description: '股份行情、天气预报、IP 归属地等专业数据',
    count: 4,
    locked: false,
    policyEntry: 'group:data',
  },
  {
    id: 'memory',
    label: '记忆',
    description: '用户记忆读写与检索',
    count: 3,
    locked: true,
  },
  {
    id: 'agent',
    label: 'Agent',
    description: '子 Agent 调度与技能调用',
    count: 2,
    locked: true,
  },
  {
    id: 'task',
    label: '任务',
    description: '会话任务列表管理',
    count: 1,
    locked: true,
  },
  {
    id: 'automation',
    label: '定时任务',
    description: 'AI 创建和管理定时执行的任务',
    count: 1,
    locked: false,
    policyEntry: 'group:automation',
  },
  {
    id: 'user-interaction',
    label: '用户交互',
    description: 'Plan 模式切换与用户提问',
    count: 2,
    locked: true,
  },
  {
    id: 'channel',
    label: '渠道',
    description: '向已绑定外部会话发送消息',
    count: 1,
    locked: false,
    policyEntry: 'group:im',
  },
  {
    id: 'evolution',
    label: '自进化',
    description: 'AI 自主定制页面、Widget、UI 外观',
    count: toolCount('evolution', 1),
    locked: false,
    policyEntry: 'group:evolution',
  },
  {
    id: 'office',
    label: 'Office 文档',
    description: 'Office/PDF 文档结构校验与解包',
    count: toolCount('office', 1),
    locked: false,
    policyEntry: 'group:office',
  },
  {
    id: 'reading',
    label: '阅读',
    description: 'Lume Reading 与微信读书工具',
    count: 16,
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

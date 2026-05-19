import type {
  MemoryKind,
  MemoryRuntimeConfig,
  MemorySearchResult,
  MemoryToolPolicy,
} from '@lume/shared'

export type MemorySettingsView = 'workspace' | 'items'

export const MEMORY_SETTINGS_VIEWS: Array<{
  id: MemorySettingsView
  label: string
}> = [
  { id: 'workspace', label: '记忆文件' },
  { id: 'items', label: '语义记忆' },
]

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  raw: '原始',
  summary: '摘要',
  fact: '事实',
  preference: '偏好',
  decision: '决策',
  episode: '过程',
  lesson: '经验',
  milestone: '里程碑',
  artifact: '产物',
}

export const MEMORY_TOOL_POLICY_GROUPS = [
  {
    id: 'group:memory',
    label: '召回',
    desc: '允许 Agent 搜索和读取 Memory V2',
  },
  {
    id: 'group:memory-write',
    label: '写入',
    desc: '允许 Agent 写入一条 Memory V2 语义记忆',
  },
] as const

export type MemoryToolPolicyGroupId = typeof MEMORY_TOOL_POLICY_GROUPS[number]['id']

export function isMemoryToolGroupEnabled(policy: MemoryToolPolicy | undefined, groupId: MemoryToolPolicyGroupId): boolean {
  return Boolean(policy?.allow?.includes(groupId))
}

export function setMemoryToolGroupEnabled(
  config: MemoryRuntimeConfig,
  groupId: MemoryToolPolicyGroupId,
  enabled: boolean,
): MemoryToolPolicy {
  const allow = new Set(config.tools.allow ?? [])
  if (enabled) {
    allow.add(groupId)
  } else {
    allow.delete(groupId)
  }
  return {
    ...config.tools,
    allow: Array.from(allow),
  }
}

export function summarizeMemoryResult(result: MemorySearchResult): string {
  const kind = result.kind ? MEMORY_KIND_LABELS[result.kind] : '记忆'
  const scope = result.scope === 'global' ? '全局' : result.scope === 'session' ? '会话' : '工作区'
  return `${scope} · ${kind} · ${(result.score * 100).toFixed(0)}%`
}

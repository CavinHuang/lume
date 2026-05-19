import type {
  GlobalMemoryCandidate,
  GlobalMemoryStatus,
  MemoryKind,
  MemoryProviderStatus,
  MemoryRuntimeConfig,
  MemorySearchResult,
  MemoryStats,
  MemoryToolPolicy,
} from '@lume/shared'

export type MemorySettingsView = 'workspace' | 'items' | 'global'

export interface MemoryOverviewMetric {
  label: string
  value: string
  tone: 'neutral' | 'good' | 'warn'
}

export const MEMORY_SETTINGS_VIEWS: Array<{
  id: MemorySettingsView
  label: string
}> = [
  { id: 'workspace', label: '工作区记忆' },
  { id: 'items', label: '结构化记忆' },
  { id: 'global', label: '全局候选' },
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
    label: '基础召回',
    desc: '允许 Agent 搜索和读取工作区记忆',
  },
  {
    id: 'group:memory-write',
    label: '自动写入',
    desc: '允许 Agent 写入一条语义记忆',
  },
  {
    id: 'group:memory-maintenance',
    label: '维护操作',
    desc: '允许重建索引、蒸馏工作区和查看状态',
  },
  {
    id: 'group:memory-global',
    label: '全局只读',
    desc: '允许搜索全局记忆和查看全局候选',
  },
  {
    id: 'group:memory-global-write',
    label: '全局确认',
    desc: '允许提升或拒绝全局候选，建议只在手动操作时开启',
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

export function formatMemoryBackend(status?: MemoryProviderStatus | null): string {
  if (!status) return '未连接'
  const backend = status.backend === 'qmd' ? 'QMD' : '内置'
  return `${backend} · ${status.provider || 'local'}`
}

export function buildMemoryOverviewMetrics(input: {
  status?: MemoryProviderStatus | null
  stats?: MemoryStats | null
  globalStatus?: GlobalMemoryStatus | null
}): MemoryOverviewMetric[] {
  const { status, stats, globalStatus } = input
  return [
    {
      label: '索引文件',
      value: String(stats?.fileCount ?? status?.files ?? 0),
      tone: 'neutral',
    },
    {
      label: '记忆块',
      value: String(stats?.chunkCount ?? status?.chunks ?? 0),
      tone: (stats?.chunkCount ?? status?.chunks ?? 0) > 0 ? 'good' : 'neutral',
    },
    {
      label: 'FTS',
      value: status?.ftsEnabled || stats?.ftsEnabled ? '已启用' : '未启用',
      tone: status?.ftsEnabled || stats?.ftsEnabled ? 'good' : 'warn',
    },
    {
      label: 'Vector',
      value: status?.vecEnabled || stats?.vecEnabled ? '已启用' : '未启用',
      tone: status?.vecEnabled || stats?.vecEnabled ? 'good' : 'neutral',
    },
    {
      label: '全局候选',
      value: String(globalStatus?.pendingCandidateCount ?? 0),
      tone: (globalStatus?.pendingCandidateCount ?? 0) > 0 ? 'warn' : 'neutral',
    },
  ]
}

export function summarizeMemoryResult(result: MemorySearchResult): string {
  const kind = result.kind ? MEMORY_KIND_LABELS[result.kind] : '记忆'
  const scope = result.scope === 'global' ? '全局' : result.scope === 'session' ? '会话' : '工作区'
  return `${scope} · ${kind} · ${(result.score * 100).toFixed(0)}%`
}

export function candidateStatusLabel(status: GlobalMemoryCandidate['status']): string {
  switch (status) {
    case 'pending':
      return '待确认'
    case 'approved':
      return '已提升'
    case 'rejected':
      return '已拒绝'
    case 'ignored':
      return '已忽略'
  }
}

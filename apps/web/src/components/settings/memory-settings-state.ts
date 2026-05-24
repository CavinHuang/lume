import {
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_LABEL,
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
} from '@lume/shared'
import type {
  Channel,
  MemoryIngestSourcesJob,
  MemoryIngestSourcesResult,
  MemoryKind,
  MemoryOrganizeEntriesResult,
  MemoryPendingCounts,
  MemoryOrganizeHistoryResult,
  MemoryReadToolResult,
  MemoryRuntimeConfig,
  MemorySettingsEntrySummary,
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
  MemoryToolPolicy,
} from '@lume/shared'

export type MemorySettingsView = 'overview' | 'workspace' | 'global' | 'pending'

export interface MemoryOverviewMetric {
  label: string
  value: string
  tone: 'neutral' | 'good' | 'warn'
}

export interface MemoryDetailRow {
  label: string
  value: string
}

export const MEMORY_SETTINGS_VIEWS: Array<{
  id: MemorySettingsView
  label: string
}> = [
  { id: 'overview', label: '概览' },
  { id: 'workspace', label: '工作区' },
  { id: 'global', label: '全局' },
  { id: 'pending', label: '待处理' },
]

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  raw: '原始',
  summary: '状态',
  fact: '事实',
  preference: '偏好',
  decision: '决策',
  episode: '过程',
  lesson: '经验',
  milestone: '里程碑',
  artifact: '产物',
}

export const MEMORY_STATUS_LABELS: Record<MemorySettingsEntrySummary['status'], string> = {
  active: '可用',
  suspected_stale: '可能过期',
  archived: '已归档',
  superseded: '已替代',
  pending_conflict: '冲突待处理',
  pending_low_confidence: '低置信待处理',
}

export const MEMORY_PENDING_LABELS: Record<MemorySettingsPendingSummary['type'], string> = {
  conflict: '冲突',
  stale: '可能过期',
  'low-confidence': '低置信',
}

export const MEMORY_FILE_KIND_LABELS: Record<'memory' | 'daily' | 'run', string> = {
  memory: '文件',
  daily: '每日',
  run: '运行',
}

export const MEMORY_CONFIDENCE_LABELS: Record<MemorySettingsEntrySummary['confidence'], string> = {
  low: '低置信',
  medium: '中置信',
  high: '高置信',
}

export const MEMORY_CITATION_MODE_LABELS: Record<'auto' | 'on' | 'off', string> = {
  auto: '自动',
  on: '开启',
  off: '关闭',
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

export interface MemoryEmbeddingModelOption {
  modelRef: string
  label: string
}

type LocalOnnxStatus = NonNullable<MemorySettingsSnapshot['retrieval']['semantic']['localOnnx']>['status']

function buildChannelModelRef(channel: Channel, modelId: string): string {
  return modelId.startsWith(`${channel.provider}/`) ? modelId : `${channel.provider}/${modelId}`
}

export function buildEmbeddingModelOptions(channels: Channel[]): MemoryEmbeddingModelOption[] {
  return [{
    modelRef: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
    label: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_LABEL,
  }, ...channels
    .filter((channel) => channel.enabled)
    .flatMap((channel) => channel.models
      .filter((model) => model.enabled && model.capabilities?.embedding === true)
      .map((model) => ({
        modelRef: buildChannelModelRef(channel, model.id),
        label: `${model.name} · ${channel.name}`,
      })))]
}

export function buildRerankModelOptions(channels: Channel[]): MemoryEmbeddingModelOption[] {
  return channels
    .filter((channel) => channel.enabled)
    .flatMap((channel) => channel.models
      .filter((model) => model.enabled && model.capabilities?.chat !== false)
      .filter((model) => model.capabilities?.embedding !== true || model.capabilities?.chat === true)
      .map((model) => ({
        modelRef: buildChannelModelRef(channel, model.id),
        label: `${model.name} · ${channel.name}`,
      })))
}

export function localOnnxStatusTone(status: LocalOnnxStatus): 'neutral' | 'good' | 'warn' {
  if (status === 'ready' || status === 'cached') return 'good'
  if (status === 'downloading' || status === 'initializing' || status === 'failed') return 'warn'
  return 'neutral'
}

export function localOnnxStatusLabel(status: LocalOnnxStatus): string {
  if (status === 'ready') return '已就绪'
  if (status === 'cached') return '已缓存'
  if (status === 'downloading') return '下载中'
  if (status === 'initializing') return '初始化中'
  if (status === 'failed') return '失败'
  return '未下载'
}

export function summarizeLocalOnnxStatus(
  status: MemorySettingsSnapshot['retrieval']['semantic']['localOnnx'],
): string {
  if (!status) return '本地 ONNX 未启用'
  return status.message
}

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

export function buildMemoryOverviewMetrics(snapshot: MemorySettingsSnapshot | null): MemoryOverviewMetric[] {
  const pending = snapshot?.counts.pending.total ?? 0
  return [
    {
      label: '可用记忆',
      value: String(snapshot?.counts.active ?? 0),
      tone: (snapshot?.counts.active ?? 0) > 0 ? 'good' : 'neutral',
    },
    {
      label: '工作区',
      value: String(snapshot?.counts.workspace ?? 0),
      tone: 'neutral',
    },
    {
      label: '全局',
      value: String(snapshot?.counts.global ?? 0),
      tone: 'neutral',
    },
    {
      label: '可能过期',
      value: String(snapshot?.counts.suspectedStale ?? 0),
      tone: (snapshot?.counts.suspectedStale ?? 0) > 0 ? 'warn' : 'neutral',
    },
    {
      label: '待处理',
      value: String(pending),
      tone: pending > 0 ? 'warn' : 'neutral',
    },
  ]
}

export function pendingNotice(counts?: MemoryPendingCounts): string {
  if (!counts || counts.total === 0) return '无待处理记忆'
  const parts = [
    counts.conflicts > 0 ? `${counts.conflicts} 个冲突` : '',
    counts.stale > 0 ? `${counts.stale} 个可能过期` : '',
    counts.lowConfidence > 0 ? `${counts.lowConfidence} 个低置信` : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

export function summarizeMemoryOrganizeResult(result: MemoryOrganizeHistoryResult): string {
  const written = result.actions.new + result.actions.related
  const pending = result.actions.conflict + result.actions.suspected_stale + result.actions.low_confidence
  return [
    `扫描 ${result.scannedMessages} 条用户消息`,
    `抽取 ${result.candidateCount} 条候选`,
    `写入 ${written} 条`,
    `重复 ${result.actions.duplicate} 条`,
    `待处理 ${pending} 条`,
  ].join(' · ')
}

export function summarizeMemoryOrganizeEntriesResult(result: MemoryOrganizeEntriesResult): string {
  return [
    `扫描 ${result.scannedEntries} 条历史记忆`,
    `保留 ${result.keptEntries} 条`,
    `归并重复 ${result.supersededDuplicates} 条`,
  ].join(' · ')
}

export function summarizeMemoryIngestSourcesResult(result: MemoryIngestSourcesResult): string {
  const written = result.actions.new + result.actions.related
  const pending = result.actions.conflict + result.actions.suspected_stale + result.actions.low_confidence
  return [
    `扫描 ${result.scannedSources} 个来源`,
    `分析 ${result.scannedBatches} 批`,
    `处理 ${result.scannedChunks} 段`,
    `抽取 ${result.candidateCount} 条候选`,
    `写入 ${written} 条`,
    `重复 ${result.actions.duplicate} 条`,
    `待处理 ${pending} 条`,
  ].join(' · ')
}

export function summarizeMemoryIngestSourcesJob(job: MemoryIngestSourcesJob): string {
  if (job.status === 'running') return '后台整理中'
  if (job.status === 'failed') return `整理失败：${job.error ?? '未知错误'}`
  return job.result ? summarizeMemoryIngestSourcesResult(job.result) : '整理完成'
}

export function summarizeMemoryEntry(entry: MemorySettingsEntrySummary): string {
  const scope = entry.scope === 'global' ? '全局' : '工作区'
  return `${scope} · ${MEMORY_KIND_LABELS[entry.kind]} · ${MEMORY_STATUS_LABELS[entry.status]}`
}

export function buildMemoryDetailRows(detail: MemoryReadToolResult | null): MemoryDetailRow[] {
  if (!detail) return []
  const scope = detail.metadata?.scope === 'global'
    ? '全局'
    : detail.metadata?.scope === 'workspace'
    ? '工作区'
    : undefined
  const kind = detail.metadata?.kind ? MEMORY_KIND_LABELS[detail.metadata.kind] : undefined
  const claim = detail.metadata?.claim
    ? `${detail.metadata.claim.subject}.${detail.metadata.claim.predicate} = ${detail.metadata.claim.object}`
    : undefined
  const tags = detail.metadata?.tags?.length ? detail.metadata.tags.join(', ') : undefined
  const path = detail.path ?? detail.citation
  return [
    scope ? { label: '范围', value: scope } : undefined,
    kind ? { label: '类型', value: kind } : undefined,
    claim ? { label: 'Claim', value: claim } : undefined,
    tags ? { label: '标签', value: tags } : undefined,
    path ? { label: '路径', value: path } : undefined,
  ].filter((row): row is MemoryDetailRow => Boolean(row))
}

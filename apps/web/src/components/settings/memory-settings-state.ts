import {
  buildConnectionModelRef,
  isChannelViewReady,
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_LABEL,
  MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
} from '@lume/shared'
import type {
  Channel,
  MemoryIngestSourceInput,
  MemoryIngestSourcesJob,
  MemoryIngestSourcesItem,
  MemoryIngestSourcesResult,
  MemoryKind,
  MemoryOrganizeJob,
  MemoryOrganizeEntriesResult,
  MemoryPendingCounts,
  MemoryOrganizeHistoryResult,
  MemoryReadToolResult,
  MemoryRuntimeConfig,
  MemorySettingsEntrySummary,
  MemorySettingsPendingCandidateSummary,
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
  MemoryToolPolicy,
} from '@lume/shared'

export type MemorySettingsView = 'recent' | 'about' | 'workspace' | 'all' | 'pending'
export type MemoryUserCategory = Exclude<MemorySettingsView, 'pending'>

export interface MemoryOverviewMetric {
  label: string
  value: string
  tone: 'neutral' | 'good' | 'warn'
}

export interface MemoryLayerMetric {
  label: string
  value: string
  desc: string
}

export interface MemoryIngestItemRow {
  id: string
  title: string
  desc: string
  tone: 'neutral' | 'good' | 'warn'
}

export type MemoryIngestTargetScopeMode = 'auto' | 'workspace' | 'global'

export interface MemoryDetailRow {
  label: string
  value: string
}

export const MEMORY_SETTINGS_VIEWS: Array<{
  id: MemorySettingsView
  label: string
}> = [
  { id: 'recent', label: '最近记住' },
  { id: 'about', label: '关于你' },
  { id: 'workspace', label: '当前工作区' },
  { id: 'all', label: '全部记忆' },
]

export const MEMORY_USER_CATEGORY_META: Record<MemoryUserCategory, {
  label: string
  desc: string
  placeholder: string
  empty: string
}> = {
  recent: {
    label: '最近记住',
    desc: '按更新时间查看最近发生变化的记忆。',
    placeholder: '补充一条长期有用的信息',
    empty: '最近还没有记忆变化。',
  },
  about: {
    label: '关于你',
    desc: '全局身份与稳定偏好，以及由它们生成的用户画像。',
    placeholder: '例如：以后默认使用中文回答',
    empty: '暂无关于你的全局记忆。',
  },
  workspace: {
    label: '当前工作区',
    desc: '当前项目的稳定约束、决策和已验证经验。',
    placeholder: '例如：这个项目提交信息必须使用中文',
    empty: '当前工作区暂无记忆。',
  },
  all: {
    label: '全部记忆',
    desc: '跨作用域查看和管理全部原子记忆。',
    placeholder: '添加一条记忆；作用域会自动推断',
    empty: '暂无记忆。',
  },
}

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

const MEMORY_INGEST_ACTION_LABELS: Record<MemoryIngestSourcesItem['action'], string> = {
  duplicate: '重复',
  related: '已写入并关联',
  mergeable: '可合并',
  conflict: '冲突待处理',
  suspected_stale: '可能过期待处理',
  low_confidence: '低置信待处理',
  new: '已写入',
  suppressed: '已跳过',
}

const MEMORY_INGEST_KIND_LABELS: Record<NonNullable<MemoryIngestSourcesItem['kind']>, string> = {
  preference: '偏好',
  fact: '事实',
  decision: '决策',
  lesson: '经验',
  state: '状态',
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
  legacyModelRefs?: string[]
  label: string
}

type LocalOnnxStatus = NonNullable<MemorySettingsSnapshot['retrieval']['semantic']['localOnnx']>['status']

export function buildEmbeddingModelOptions(channels: Channel[]): MemoryEmbeddingModelOption[] {
  return [{
    modelRef: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_REF,
    label: MEMORY_LOCAL_ONNX_EMBEDDING_MODEL_LABEL,
  }, ...channels
    .filter(isChannelViewReady)
    .flatMap((channel) => channel.models
      .filter((model) => model.enabled && model.capabilities?.embedding === true)
      .map((model) => ({
        modelRef: buildConnectionModelRef(channel.id, model.id),
        legacyModelRefs: [
          model.id,
          `${channel.providerId || channel.provider}/${model.id}`,
          `${channel.id}/${model.id}`,
        ],
        label: `${model.name} · ${channel.name}`,
      })))]
}

export function buildRerankModelOptions(channels: Channel[]): MemoryEmbeddingModelOption[] {
  return channels
    .filter(isChannelViewReady)
    .flatMap((channel) => channel.models
      .filter((model) => model.enabled && model.capabilities?.chat !== false)
      .filter((model) => model.capabilities?.embedding !== true || model.capabilities?.chat === true)
      .map((model) => ({
        modelRef: buildConnectionModelRef(channel.id, model.id),
        legacyModelRefs: [
          model.id,
          `${channel.providerId || channel.provider}/${model.id}`,
          `${channel.id}/${model.id}`,
        ],
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
  if (status.status === 'failed' && status.error) return `${status.message} 原因：${status.error}`
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

export function buildMemoryLayerMetrics(snapshot: MemorySettingsSnapshot | null): MemoryLayerMetric[] {
  const entries = [
    ...(snapshot?.workspaceEntries ?? []),
    ...(snapshot?.globalEntries ?? []),
  ].filter((entry) => entry.status === 'active' || entry.status === 'suspected_stale')
  return [
    {
      label: '证据记录',
      value: String((snapshot?.counts.daily ?? 0) + (snapshot?.counts.runs ?? 0)),
      desc: '每日摘要与 Run 证据',
    },
    {
      label: '原子记忆',
      value: String(entries.length),
      desc: '可验证、可版本化的长期信息',
    },
    {
      label: '开放标签',
      value: String(new Set(entries.flatMap((entry) => entry.facets ?? entry.tags)).size),
      desc: '用于动态查询，不是固定分类',
    },
    {
      label: '待处理',
      value: String(snapshot?.counts.pending.total ?? 0),
      desc: '冲突、低置信与可能过期',
    },
  ]
}

export function filterMemoryEntriesByUserCategory(
  entries: MemorySettingsEntrySummary[],
  category: MemoryUserCategory,
): MemorySettingsEntrySummary[] {
  if (category === 'workspace') return entries.filter((entry) => entry.scope === 'workspace')
  if (category === 'about') {
    return entries.filter((entry) => entry.scope === 'global'
      && (entry.semanticRole === 'identity' || entry.semanticRole === 'preference'))
  }
  if (category === 'recent') {
    return entries.slice(0, 50)
  }
  return entries
}

export function memoryEntryLayerLabel(entry: MemorySettingsEntrySummary): string {
  if (entry.semanticRole) return semanticRoleLabel(entry.semanticRole)
  if (entry.claim) return '结构化 Claim'
  return entry.scope === 'global' ? '全局' : '工作区'
}

export function memoryPendingCandidateLayerLabel(candidate: MemorySettingsPendingCandidateSummary): string {
  if (candidate.claim) return '结构化 Claim'
  return candidate.scope === 'global' ? '全局' : '工作区'
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
  if (job.status === 'running') {
    if (!job.progress) return '后台整理中'
    return [
      '后台整理中',
      job.progress.scannedBatches > 0
        ? `已分析 ${job.progress.processedBatches}/${job.progress.scannedBatches} 批`
        : '',
      job.progress.scannedChunks > 0 ? `处理 ${job.progress.scannedChunks} 段` : '',
      `抽取 ${job.progress.candidateCount} 条候选`,
    ].filter(Boolean).join(' · ')
  }
  if (job.status === 'failed') return `整理失败：${job.error ?? '未知错误'}`
  if (job.status === 'cancelled') return '整理已停止'
  if (job.status === 'interrupted') return `整理被中断：${job.error ?? '可重试'}`
  if (job.status === 'queued') return '等待后台整理'
  return job.result ? summarizeMemoryIngestSourcesResult(job.result) : '整理完成'
}

export function summarizeMemoryOrganizeJob(job: MemoryOrganizeJob): string {
  if (job.status === 'running') {
    if (!job.progress) return job.kind === 'entries' ? '正在整理记忆' : '正在生成记忆'
    const parts = [
      job.progress.label,
      job.progress.scannedBatches && job.progress.processedBatches !== undefined
        ? `已分析 ${job.progress.processedBatches}/${job.progress.scannedBatches} 批`
        : '',
      job.progress.scannedItems > 0
        ? `处理 ${job.progress.processedItems}/${job.progress.scannedItems} 条`
        : '',
      job.progress.candidateCount !== undefined ? `抽取 ${job.progress.candidateCount} 条候选` : '',
    ].filter(Boolean)
    return parts.join(' · ')
  }
  if (job.status === 'failed') return `整理失败：${job.error ?? '未知错误'}`
  if (job.status === 'cancelled') return '整理已停止'
  if (job.status === 'interrupted') return `整理被中断：${job.error ?? '可重试'}`
  if (job.status === 'queued') return '等待后台整理'
  if (!job.result) return '整理完成'
  return job.kind === 'entries'
    ? summarizeMemoryOrganizeEntriesResult(job.result as MemoryOrganizeEntriesResult)
    : summarizeMemoryOrganizeResult(job.result as MemoryOrganizeHistoryResult)
}

export function summarizeMemoryExtractionStatus(
  extraction: MemorySettingsSnapshot['extraction'] | undefined,
): string {
  return extraction?.message ?? '未配置记忆提取模型；外部资料只会使用显式记忆句式。'
}

export function buildMemoryIngestItemRows(result: MemoryIngestSourcesResult | null): MemoryIngestItemRow[] {
  return (result?.items ?? []).map((item, index) => {
    const title = [
      MEMORY_INGEST_ACTION_LABELS[item.action],
      item.scope === 'global' ? '全局' : item.scope === 'workspace' ? '工作区' : undefined,
      item.kind ? MEMORY_INGEST_KIND_LABELS[item.kind] : undefined,
    ].filter(Boolean).join(' · ')
    return {
      id: `${item.sourcePath}:${index}`,
      title,
      desc: [
        item.statement,
        localizeMemoryIngestReason(item.reason),
        item.sourcePath,
      ].filter(Boolean).join('\n'),
      tone: memoryIngestActionTone(item.action),
    }
  })
}

function localizeMemoryIngestReason(reason?: string): string | undefined {
  if (reason === 'Candidate stored as active memory.') {
    return '已写入为可用记忆'
  }
  if (reason === 'Candidate duplicates an active claim memory.') {
    return '与已有结构化记忆重复'
  }
  if (reason === 'Candidate duplicates an active memory.') {
    return '与已有记忆重复'
  }
  if (reason === 'Source contains no ingestible text.') {
    return '没有可整理的文本内容'
  }
  if (reason === 'No durable memory candidates found.') {
    return '没有发现适合长期记住的内容'
  }
  if (reason === 'Unsupported workspace file type.') {
    return '暂不支持这个工作区文件类型'
  }
  if (reason === 'Unsupported local file type.') {
    return '暂不支持这个本地文件类型'
  }
  if (reason === 'No supported local text files found.') {
    return '没有找到支持的本地文本文件'
  }
  return reason
}

export function applyMemoryIngestTargetScope(
  sources: MemoryIngestSourceInput[],
  mode: MemoryIngestTargetScopeMode,
): MemoryIngestSourceInput[] {
  if (mode === 'auto') return sources
  return sources.map((source) => ({
    ...source,
    targetScope: mode,
  }))
}

function memoryIngestActionTone(action: MemoryIngestSourcesItem['action']): MemoryIngestItemRow['tone'] {
  if (action === 'new' || action === 'related') return 'good'
  if (action === 'conflict' || action === 'suspected_stale' || action === 'low_confidence' || action === 'suppressed') return 'warn'
  return 'neutral'
}

export function summarizeMemoryEntry(entry: MemorySettingsEntrySummary): string {
  const scope = entry.scope === 'global' ? '全局' : '工作区'
  const role = entry.semanticRole
    ? semanticRoleLabel(entry.semanticRole)
    : entry.kind === 'summary' || entry.kind === 'episode' || entry.kind === 'milestone'
    ? '状态'
    : entry.kind === 'artifact' || entry.kind === 'raw'
    ? '记忆'
    : MEMORY_KIND_LABELS[entry.kind]
  return `${scope} · ${role} · ${MEMORY_STATUS_LABELS[entry.status]}`
}

function semanticRoleLabel(role: NonNullable<MemorySettingsEntrySummary['semanticRole']>): string {
  return ({
    identity: '身份',
    fact: '事实',
    preference: '偏好',
    constraint: '约束',
    decision: '决策',
    lesson: '经验',
    state: '状态',
  } as const)[role]
}

export function buildMemoryDetailRows(detail: MemoryReadToolResult | null): MemoryDetailRow[] {
  if (!detail) return []
  const scope = detail.metadata?.scope === 'global'
    ? '全局'
    : detail.metadata?.scope === 'workspace'
    ? '工作区'
    : undefined
  const claim = detail.metadata?.claim
    ? `${detail.metadata.claim.subject}.${detail.metadata.claim.predicate} = ${detail.metadata.claim.object}`
    : undefined
  const tags = detail.metadata?.tags?.length ? detail.metadata.tags.join(', ') : undefined
  const path = detail.path ?? detail.citation
  const layer = detailToMemoryEntryLayerLabel(detail)
  return [
    scope ? { label: '范围', value: scope } : undefined,
    layer ? { label: '分层', value: layer } : undefined,
    claim ? { label: 'Claim', value: claim } : undefined,
    tags ? { label: '标签', value: tags } : undefined,
    path ? { label: '路径', value: path } : undefined,
  ].filter((row): row is MemoryDetailRow => Boolean(row))
}

function detailToMemoryEntryLayerLabel(detail: MemoryReadToolResult): string | undefined {
  const metadata = detail.metadata
  if (!metadata?.scope || !metadata.kind) return undefined
  if (metadata.scope !== 'global' && metadata.scope !== 'workspace') return undefined
  return memoryEntryLayerLabel({
    id: detail.path ?? detail.citation ?? 'memory-detail',
    path: detail.path ?? detail.citation ?? '',
    scope: metadata.scope,
    kind: metadata.kind,
    status: 'active',
    confidence: 'high',
    statement: detail.text,
    updated: '',
    pinned: false,
    tags: metadata.tags ?? [],
    ...(metadata.claim ? { claim: metadata.claim } : {}),
  })
}

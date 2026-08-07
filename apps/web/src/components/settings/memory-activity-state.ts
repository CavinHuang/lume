import type {
  MemoryActivation,
  MemoryMutationAction,
  MemoryMutationActor,
  MemoryMutationEntrySnapshot,
} from '@lume/shared'

export const MEMORY_MUTATION_ACTION_LABELS: Record<MemoryMutationAction, string> = {
  created: '新增记忆',
  updated: '更新记忆',
  superseded: '纠正记忆',
  merged: '合并记忆',
  archived: '归档记忆',
  duplicate: '重复内容',
  pending: '等待处理',
  ignored: '未保存',
}

export const MEMORY_MUTATION_ACTOR_LABELS: Record<MemoryMutationActor, string> = {
  main_agent: '主 Agent',
  background_extract: '后台提取',
  consolidation: '记忆整理',
  user: '你',
  migration: '数据迁移',
}

export interface MemoryMutationFieldDiff {
  key: string
  label: string
  before?: string
  after?: string
}

export function buildMemoryMutationFieldDiffs(
  before?: MemoryMutationEntrySnapshot,
  after?: MemoryMutationEntrySnapshot,
): MemoryMutationFieldDiff[] {
  if (!before || !after) return []
  return [
    fieldDiff('scope', '作用域', scopeLabel(before.scope), scopeLabel(after.scope)),
    fieldDiff('status', '状态', valueLabel(before.status), valueLabel(after.status)),
    fieldDiff('confidence', '置信度', confidenceLabel(before.confidence), confidenceLabel(after.confidence)),
    fieldDiff('facets', '标签', listLabel(before.facets), listLabel(after.facets)),
    fieldDiff('pinned', '置顶', booleanLabel(before.pinned), booleanLabel(after.pinned)),
    fieldDiff('activation', '激活用途', activationLabel(before.activation), activationLabel(after.activation)),
    fieldDiff('validFrom', '生效时间', valueLabel(before.validFrom), valueLabel(after.validFrom)),
    fieldDiff('validTo', '有效期', valueLabel(before.validTo), valueLabel(after.validTo)),
    fieldDiff('supersededBy', '替代版本', valueLabel(before.supersededBy), valueLabel(after.supersededBy)),
  ].filter((item): item is MemoryMutationFieldDiff => item !== null)
}

function fieldDiff(
  key: string,
  label: string,
  before: string | undefined,
  after: string | undefined,
): MemoryMutationFieldDiff | null {
  if (before === after) return null
  return { key, label, ...(before ? { before } : {}), ...(after ? { after } : {}) }
}

function scopeLabel(value: MemoryMutationEntrySnapshot['scope']): string {
  return value === 'global' ? '全局' : '工作区'
}

function valueLabel(value: string | undefined): string | undefined {
  if (!value) return undefined
  const labels: Record<string, string> = {
    active: '可用',
    suspected_stale: '可能过期',
    archived: '已归档',
    superseded: '已替换',
    pending_conflict: '冲突待处理',
    pending_low_confidence: '低置信待处理',
  }
  return labels[value] ?? value
}

function confidenceLabel(value: MemoryMutationEntrySnapshot['confidence']): string | undefined {
  if (!value) return undefined
  return { low: '低', medium: '中', high: '高' }[value]
}

function listLabel(value: string[] | undefined): string | undefined {
  return value?.length ? value.join('、') : undefined
}

function booleanLabel(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined
  return value ? '是' : '否'
}

function activationLabel(value: MemoryActivation | undefined): string | undefined {
  if (!value) return undefined
  const active = [
    value.recall && '召回',
    value.persona && '关于我',
    value.suggestion && '建议',
    value.analyst && '分析',
  ].filter(Boolean)
  return active.length ? active.join('、') : '全部关闭'
}

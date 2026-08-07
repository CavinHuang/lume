import type { MemoryJobKind, MemoryJobStatus, MemorySettingsJobSummary } from '@lume/shared'

export const MEMORY_JOB_KIND_LABELS: Record<MemoryJobKind, string> = {
  turn_extract: '后台提取',
  history: '历史整理',
  entries: '记忆整理',
  external_ingest: '外部资料',
  consolidation: 'AutoDream 整理',
}

export const MEMORY_JOB_STATUS_LABELS: Record<MemoryJobStatus, string> = {
  queued: '等待中',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已中断',
}

export function summarizeMemorySettingsJob(job: MemorySettingsJobSummary): string {
  if (job.error) return job.error
  if (job.status !== 'completed') return MEMORY_JOB_STATUS_LABELS[job.status]
  if (!job.result) return '任务已完成，但没有可展示的结果。'

  switch (job.result.kind) {
    case 'history': {
      const result = job.result.data
      return `扫描 ${result.scannedMessages} 条消息，产生 ${result.candidateCount} 条候选，写入 ${result.actions.new + result.actions.related} 条`
    }
    case 'entries': {
      const result = job.result.data
      return `扫描 ${result.scannedEntries} 条记忆，保留 ${result.keptEntries} 条，合并 ${result.supersededDuplicates} 条`
    }
    case 'external_ingest': {
      const result = job.result.data
      return `扫描 ${result.scannedSources} 个来源，产生 ${result.candidateCount} 条候选，写入 ${result.actions.new + result.actions.related} 条`
    }
    case 'turn_extract':
      return `扫描 ${job.result.data.scannedItems} 项，变更 ${job.result.data.changedItems} 项`
    case 'consolidation': {
      const result = job.result.data
      return `扫描 ${result.scannedEntries} 条，更新 ${result.updated} 条，合并 ${result.merged} 条，标记过期 ${result.stale} 条`
    }
  }
}

export function formatMemoryJobTime(value?: number): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

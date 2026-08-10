import { describe, expect, test } from 'bun:test'
import type { MemorySettingsJobSummary } from '@lume/shared'
import {
  MEMORY_JOB_KIND_LABELS,
  MEMORY_JOB_STATUS_LABELS,
  summarizeMemorySettingsJob,
} from './memory-job-activity-state'

describe('memory job activity presentation', () => {
  test('labels background jobs and statuses in Chinese', () => {
    expect(MEMORY_JOB_KIND_LABELS.consolidation).toBe('记忆整理')
    expect(MEMORY_JOB_STATUS_LABELS.completed).toBe('已完成')
  })

  test('summarizes completed consolidation results', () => {
    const job: MemorySettingsJobSummary = {
      jobId: 'job-1',
      kind: 'consolidation',
      status: 'completed',
      createdAt: 1,
      retryable: false,
      result: {
        kind: 'consolidation',
        data: {
          sessionsReviewed: 5,
          evidenceItemsReviewed: 18,
          scannedEntries: 10,
          actions: {
            created: 0,
            versioned: 1,
            updated: 1,
            merged: 1,
            stale: 3,
            pending: 0,
            ignored: 0,
          },
          items: [],
          rebuilt: ['workspace-brief.md'],
          warnings: [],
        },
      },
    }

    expect(summarizeMemorySettingsJob(job)).toBe('检查 5 个会话、18 条证据，整理 6 条，待处理 0 条')
  })

  test('surfaces failed job errors instead of hiding the result', () => {
    const job: MemorySettingsJobSummary = {
      jobId: 'job-2',
      kind: 'external_ingest',
      status: 'failed',
      createdAt: 1,
      retryable: true,
      error: '文件读取失败',
    }

    expect(summarizeMemorySettingsJob(job)).toBe('文件读取失败')
  })
})

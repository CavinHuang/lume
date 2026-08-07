import { describe, expect, test } from 'bun:test'
import type { MemorySettingsJobSummary } from '@lume/shared'
import {
  MEMORY_JOB_KIND_LABELS,
  MEMORY_JOB_STATUS_LABELS,
  summarizeMemorySettingsJob,
} from './memory-job-activity-state'

describe('memory job activity presentation', () => {
  test('labels background jobs and statuses in Chinese', () => {
    expect(MEMORY_JOB_KIND_LABELS.consolidation).toBe('AutoDream 整理')
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
          scannedEntries: 10,
          updated: 2,
          merged: 1,
          stale: 3,
          rebuilt: ['workspace-brief.md'],
        },
      },
    }

    expect(summarizeMemorySettingsJob(job)).toBe('扫描 10 条，更新 2 条，合并 1 条，标记过期 3 条')
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

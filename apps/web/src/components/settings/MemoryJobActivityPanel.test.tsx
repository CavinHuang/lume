import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MemorySettingsJobSummary } from '@lume/shared'

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))
mock.module('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const { MemoryJobActivityPanel } = await import('./MemoryJobActivityPanel')

describe('MemoryJobActivityPanel', () => {
  test('renders task result metrics and concrete processed items', () => {
    const job: MemorySettingsJobSummary = {
      jobId: 'job-1',
      kind: 'history',
      status: 'completed',
      createdAt: Date.parse('2026-08-07T10:00:00.000Z'),
      completedAt: Date.parse('2026-08-07T10:01:00.000Z'),
      retryable: false,
      result: {
        kind: 'history',
        data: {
          workspaceSlug: 'demo',
          scannedSources: 1,
          scannedMessages: 4,
          candidateCount: 1,
          actions: {
            duplicate: 0,
            related: 0,
            conflict: 0,
            suspected_stale: 0,
            low_confidence: 0,
            new: 1,
            suppressed: 0,
          },
          items: [{
            sourcePath: 'runs/run-1.jsonl',
            statement: '默认使用中文回答',
            scope: 'global',
            kind: 'preference',
            confidence: 'high',
            action: 'new',
            reason: '用户明确要求',
            entryId: 'memory-1',
          }],
        },
      },
    }

    const html = renderToStaticMarkup(
      <MemoryJobActivityPanel items={[job]} busyAction={null} onRetry={() => undefined} onCancel={() => undefined} />,
    )

    expect(html).toContain('历史整理')
    expect(html).toContain('扫描 4 条消息')
    expect(html).toContain('默认使用中文回答')
    expect(html).toContain('runs/run-1.jsonl')
  })

  test('renders live progress and a stop action for active jobs', () => {
    const job: MemorySettingsJobSummary = {
      jobId: 'job-running',
      kind: 'consolidation',
      status: 'running',
      createdAt: Date.parse('2026-08-07T10:00:00.000Z'),
      retryable: false,
      progress: {
        phase: '重建主题摘要',
        scannedItems: 12,
        processedItems: 7,
        changedFiles: ['workspace-brief.md'],
      },
    }

    const html = renderToStaticMarkup(
      <MemoryJobActivityPanel items={[job]} busyAction={null} onRetry={() => undefined} onCancel={() => undefined} />,
    )

    expect(html).toContain('重建主题摘要')
    expect(html).toContain('workspace-brief.md')
    expect(html).toContain('停止')
  })

  test('renders Dream evidence metrics and concrete before/after results', () => {
    const job: MemorySettingsJobSummary = {
      jobId: 'job-dream',
      kind: 'consolidation',
      status: 'completed',
      createdAt: Date.parse('2026-08-07T10:00:00.000Z'),
      retryable: false,
      result: {
        kind: 'consolidation',
        data: {
          sessionsReviewed: 5,
          evidenceItemsReviewed: 24,
          scannedEntries: 12,
          actions: { created: 0, versioned: 1, updated: 0, merged: 0, stale: 0, pending: 0, ignored: 0 },
          items: [{
            action: 'versioned',
            memoryIds: ['memory-new'],
            mutationId: 'mutation-1',
            before: { id: 'memory-old', scope: 'global', revision: 1, statement: '默认英文回答' },
            after: { id: 'memory-new', scope: 'global', revision: 1, statement: '默认中文回答' },
            reason: '用户明确纠正',
            evidenceRefs: [{ type: 'user_message', id: 'message-1' }],
            undoable: true,
          }],
          rebuilt: ['global:persona.md'],
          warnings: [],
        },
      },
    }

    const html = renderToStaticMarkup(
      <MemoryJobActivityPanel items={[job]} busyAction={null} onRetry={() => undefined} onCancel={() => undefined} />,
    )

    expect(html).toContain('5 个会话')
    expect(html).toContain('24 条证据')
    expect(html).toContain('默认英文回答')
    expect(html).toContain('默认中文回答')
    expect(html).toContain('用户明确纠正')
    expect(html).toContain('用户消息')
    expect(html).toContain('message-1')
  })
})

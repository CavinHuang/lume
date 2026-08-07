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
      <MemoryJobActivityPanel items={[job]} busyAction={null} onRetry={() => undefined} />,
    )

    expect(html).toContain('历史整理')
    expect(html).toContain('扫描 4 条消息')
    expect(html).toContain('默认使用中文回答')
    expect(html).toContain('runs/run-1.jsonl')
  })
})

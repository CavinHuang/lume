import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MemorySettingsActivityItem } from '@lume/shared'

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))
mock.module('@/components/ui/collapsible', () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const { MemoryActivityPanel } = await import('./MemoryActivityPanel')

describe('MemoryActivityPanel', () => {
  test('renders mutation content and before/after values in an activity card', () => {
    const item: MemorySettingsActivityItem = {
      mutationId: 'mutation-1',
      actor: 'main_agent',
      action: 'updated',
      memoryIds: ['memory-1'],
      scope: 'workspace',
      summary: '更新了 1 条记忆',
      undoable: true,
      createdAt: '2026-08-07T10:00:00.000Z',
      changes: [{
        memoryId: 'memory-1',
        accuracy: 'exact',
        before: {
          id: 'memory-1',
          scope: 'workspace',
          revision: 1,
          statement: '默认使用 Bun',
          status: 'active',
          confidence: 'medium',
        },
        after: {
          id: 'memory-1',
          scope: 'workspace',
          revision: 2,
          statement: '默认使用 Bun 和 TypeScript',
          status: 'active',
          confidence: 'high',
        },
      }],
    }

    const html = renderToStaticMarkup(
      <MemoryActivityPanel
        items={[item]}
        busyAction={null}
        onOpenMemory={() => undefined}
        onUndo={() => undefined}
      />,
    )

    expect(html).toContain('默认使用 Bun')
    expect(html).toContain('默认使用 Bun 和 TypeScript')
    expect(html).toContain('主 Agent')
    expect(html).toContain('变更前')
    expect(html).toContain('变更后')
  })
})

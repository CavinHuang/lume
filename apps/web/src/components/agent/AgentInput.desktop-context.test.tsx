import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DesktopContextPlusItem } from './DesktopContextPlusItem'

await mock.module('@/components/ui/badge', () => ({
  Badge: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement('span', props, children),
}))

await mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement('button', props, children),
}))

const { DesktopContextSelectionChip } = await import('./DesktopContextSelectionChip')

describe('DesktopContextPlusItem', () => {
  test('renders the active app as a selectable conversation context without leaking text', () => {
    const html = renderToStaticMarkup(
      <DesktopContextPlusItem
        active={false}
        target={{
          snapshotId: 'snap-1',
          app: { id: 'wechat.exe', name: '微信' },
          window: { id: 'win:1', title: '项目群' },
          capturedAt: 100,
        }}
        onActivate={() => undefined}
      />,
    )

    expect(html).toContain('微信')
    expect(html).toContain('项目群')
    expect(html).toContain('作为上下文')
    expect(html).not.toContain('visibleText')
    expect(html).not.toContain('password')
  })

  test('renders a removable selected app context chip without leaking text', () => {
    const html = renderToStaticMarkup(
      <DesktopContextSelectionChip
        target={{
          snapshotId: 'snap-1',
          app: { id: 'wechat.exe', name: '微信' },
          window: { id: 'win:1', title: '项目群' },
          capturedAt: 100,
        }}
        onClear={() => undefined}
      />,
    )

    expect(html).toContain('上下文')
    expect(html).toContain('微信')
    expect(html).toContain('项目群')
    expect(html).toContain('移除当前应用上下文')
    expect(html).not.toContain('visibleText')
    expect(html).not.toContain('password')
  })
})

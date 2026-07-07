import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DesktopContextPlusItem } from './DesktopContextPlusItem'

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
})

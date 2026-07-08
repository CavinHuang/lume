import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DesktopActionBanner } from './DesktopActionBanner'

describe('DesktopActionBanner', () => {
  test('renders target point and verification context without leaking typed text', () => {
    const html = renderToStaticMarkup(
      <DesktopActionBanner
        threadId="thread-1"
        request={{
          threadId: 'thread-1',
          requestId: 'desktop_action:req-1',
          toolUseId: 'tool-1',
          app: { id: 'wechat.exe', name: '微信' },
          action: 'set_value',
          targetLabel: '输入框',
          targetPoint: { x: 280, y: 620 },
          risk: 'critical',
          expiresAt: '2026-07-08T12:00:00.000Z',
          expectedWindowId: 'win:wechat',
          expectedRevision: 'rev-safe',
          summary: '微信：set_value「输入框」',
        }}
      />,
    )

    expect(html).toContain('目标点')
    expect(html).toContain('280,620')
    expect(html).toContain('执行前复核窗口版本')
    expect(html).not.toContain('password=secret')
  })
})

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DesktopActionVisualOverlayFrame } from './DesktopActionVisualOverlay'

describe('DesktopActionVisualOverlayFrame', () => {
  test('renders a distinct agent-operation HUD and virtual cursor without action payloads', () => {
    const html = renderToStaticMarkup(
      <DesktopActionVisualOverlayFrame
        state={{
          id: 'visual-1',
          threadId: 'thread-1',
          phase: 'started',
          action: 'type_text',
          appName: '微信',
          targetLabel: '输入框',
          point: { x: 420, y: 360 },
          path: [
            { x: 120, y: 160 },
            { x: 420, y: 360 },
          ],
          updatedAt: 1,
        }}
      />,
    )

    expect(html).toContain('Lume 正在操作')
    expect(html).toContain('微信')
    expect(html).toContain('输入框')
    expect(html).toContain('代理鼠标')
    expect(html).toContain('data-desktop-action-trail="true"')
    expect(html).toContain('data-desktop-action-cursor="true"')
    expect(html).toContain('data-desktop-action-cursor-artwork="open-codex-computer-use"')
    expect(html).toContain('official-software-cursor-window-252.png')
    expect(html).toContain('data-phase="started"')
    expect(html).not.toContain('password=secret')
  })

  test('shows failed action status without leaking typed text', () => {
    const html = renderToStaticMarkup(
      <DesktopActionVisualOverlayFrame
        state={{
          id: 'visual-failed',
          threadId: 'thread-1',
          phase: 'failed',
          action: 'click',
          appName: '微信',
          targetLabel: '发送',
          point: { x: 320, y: 240 },
          status: 'stale_target',
          updatedAt: 100,
        }}
      />,
    )

    expect(html).toContain('操作未完成')
    expect(html).toContain('微信')
    expect(html).toContain('发送')
    expect(html).toContain('stale_target')
    expect(html).not.toContain('password')
  })
})

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
          updatedAt: 1,
        }}
      />,
    )

    expect(html).toContain('Lume 正在操作')
    expect(html).toContain('微信')
    expect(html).toContain('输入框')
    expect(html).toContain('代理鼠标')
    expect(html).toContain('data-phase="started"')
    expect(html).not.toContain('password=secret')
  })
})

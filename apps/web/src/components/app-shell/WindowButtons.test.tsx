import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WindowButtonGroup } from './WindowButtons'

describe('WindowButtonGroup', () => {
  test('非最大化态渲染最小化/最大化/关闭三个按钮', () => {
    const markup = renderToStaticMarkup(
      <WindowButtonGroup maximized={false} focused={true} />,
    )
    expect(markup).toContain('最小化')
    expect(markup).toContain('最大化')
    expect(markup).toContain('关闭')
    expect(markup).toContain('-webkit-app-region:no-drag')
  })

  test('最大化态把"最大化"切换为"还原"', () => {
    const markup = renderToStaticMarkup(
      <WindowButtonGroup maximized={true} focused={true} />,
    )
    expect(markup).toContain('还原')
    expect(markup).not.toContain('最大化')
  })

  test('失焦态应用降低对比度的样式', () => {
    const markup = renderToStaticMarkup(
      <WindowButtonGroup maximized={false} focused={false} />,
    )
    expect(markup).toContain('var(--lume-text-muted)_56%')
  })
})

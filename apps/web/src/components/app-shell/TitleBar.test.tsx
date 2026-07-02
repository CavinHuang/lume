import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import { TitleBar } from './TitleBar'

function render(variant: 'macos' | 'custom-controls' | 'browser'): string {
  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <TitleBar variant={variant} />
    </Provider>,
  )
}

describe('TitleBar', () => {
  test('渲染侧栏开关、Logo 与搜索入口', () => {
    const markup = render('browser')
    expect(markup).toContain('收起侧栏')
    expect(markup).toContain('Lume')
    expect(markup).toContain('搜索 / 跳转')
  })

  test('macOS 变体为交通灯预留左侧 80px', () => {
    const markup = render('macos')
    expect(markup).toContain('pl-[80px]')
  })

  test('custom-controls 变体渲染自绘窗口按钮', () => {
    const markup = render('custom-controls')
    expect(markup).toContain('最小化')
    expect(markup).toContain('关闭')
  })

  test('browser 变体不渲染自绘窗口按钮', () => {
    const markup = render('browser')
    expect(markup).not.toContain('最小化')
  })

  test('整条标题栏标记为拖拽区', () => {
    const markup = render('browser')
    expect(markup).toContain('-webkit-app-region:drag')
  })
})

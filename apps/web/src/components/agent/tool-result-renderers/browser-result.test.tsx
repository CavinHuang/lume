import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrowserResult } from './browser-result'

describe('#601 BrowserResult 真实形制渲染', () => {
  test('截图占位数组渲染为干净占位条，不倾倒 JSON', () => {
    // engine 事件出口把 image block 替换为该形制
    const placeholderArray = JSON.stringify([
      { type: 'text', text: '[Image: image/png]', _meta: { screenshotId: 'shot-abcdef123456' } },
    ])
    const markup = renderToStaticMarkup(<BrowserResult input={{}} result={placeholderArray} />)
    expect(markup).toContain('已生成')
    expect(markup).toContain('shot-abcdef1')
    expect(markup).toContain('image/png')
    expect(markup).not.toContain('[Image:')
    expect(markup).not.toContain('<pre')
  })

  test('snapshot 的 observation.tree 折叠展示并带页面标识', () => {
    const tree = Array.from({ length: 120 }, (_, i) => `- link "item ${i}" @e${i + 1}`).join('\n')
    const result = JSON.stringify({
      active_tab_id: 'tab-1',
      observation: { snapshot_id: 'snap-1', url: 'https://example.com/list', title: '列表页', tree, refs: {} },
    })
    const markup = renderToStaticMarkup(<BrowserResult input={{}} result={result} />)
    expect(markup).toContain('列表页 · https://example.com/list')
    expect(markup).toContain('页面快照（120 行')
    expect(markup).toContain('点击展开')
    expect(markup).toContain('item 0')
  })

  test('小体积 tree 直接平铺不折叠', () => {
    const result = JSON.stringify({ observation: { url: 'https://a.dev', title: 'A', tree: '- heading "hi" @e1' } })
    const markup = renderToStaticMarkup(<BrowserResult input={{}} result={result} />)
    expect(markup).not.toContain('点击展开')
    // JSX 转义后引号变为 &quot;
    expect(markup).toContain('- heading &quot;hi&quot; @e1')
  })

  test('结构化错误 ok:false 渲染 code/message 横幅', () => {
    const result = JSON.stringify({ ok: false, code: 'stale_target', message: '页面已跳转，请重新 snapshot' })
    const markup = renderToStaticMarkup(<BrowserResult input={{}} result={result} />)
    expect(markup).toContain('页面已跳转，请重新 snapshot')
    expect(markup).toContain('stale_target')
  })

  test('普通小对象维持默认渲染', () => {
    const result = JSON.stringify({ ok: true, tab_id: 'tab-9' })
    const markup = renderToStaticMarkup(<BrowserResult input={{}} result={result} />)
    expect(markup).toContain('tab-9')
  })

  test('超大无 tree 对象折叠防倾倒（resultPolicy 截断防御）', () => {
    const result = JSON.stringify({ ok: true, blob: 'x'.repeat(80_000) }).slice(0, 50_000)
    const markup = renderToStaticMarkup(<BrowserResult input={{}} result={result} />)
    expect(markup).toContain('结果较大')
  })
})

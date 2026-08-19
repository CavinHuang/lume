// sanitizeMermaidSvg 的 DOMPurify 防御测试。
// dompurify 的 ESM default 导出在模块加载时按全局 window 求值（无 window 时为 null），
// 必须先注入 happy-dom 再动态 import 被测模块——故独立成文件，不改既有纯函数测试的静态 import。
import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

const happyWindow = new Window()
;(globalThis as Record<string, unknown>).window = happyWindow
;(globalThis as Record<string, unknown>).document = happyWindow.document

const { sanitizeMermaidSvg } = await import('./MermaidBlock')

describe('sanitizeMermaidSvg (DOMPurify 二层防御)', () => {
  // happy-dom 下 DOMPurify 的 isSupported 部分降级（URI 协议校验/svg 片段解析不可靠），
  // 这里只测 happy-dom 环境下稳定成立的行为；javascript: href 剥离与 <style> 保留
  // 属生产浏览器全功能行为，靠 DOMPurify 上游保证 + 构建后人工冒烟。
  test('剥离 <script> 与事件处理属性', () => {
    const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onmouseover="alert(2)" width="10" height="10"/></svg>'
    const clean = sanitizeMermaidSvg(dirty)
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onmouseover')
  })

  test('保留 foreignObject 标签文字（flowchart/gantt 渲染依赖）', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><foreignObject width="40" height="20"><div xmlns="http://www.w3.org/1999/xhtml" class="label">标签文字</div></foreignObject></g></svg>'
    const clean = sanitizeMermaidSvg(svg)
    expect(clean).toContain('foreignObject')
    expect(clean).toContain('标签文字')
  })
})

// sanitizeMermaidSvg 的行为依赖 DOMPurify 的 default 实例（模块加载时按 window 求值），
// bun 环境下该实例不可用（CI bun 与本地版本对动态 import 求值时机不同）且 happy-dom
// 下 DOMPurify 能力降级——行为测试在 bun 不可靠，这里守卫消毒配置本身（#133 的核心
// 回归风险：丢 foreignObject 白名单会让 mermaid 主流图类标签文字整块消失）。
// 真机行为靠 DOMPurify 上游保证 + 构建后人工冒烟。
import { describe, expect, test } from 'bun:test'
import { MERMAID_SANITIZE_CONFIG } from './MermaidBlock'

describe('MERMAID_SANITIZE_CONFIG（mermaid 消毒配置守卫）', () => {
  test('svg+html 双 profile（foreignObject 内的 div/span 需要 html profile）', () => {
    expect(MERMAID_SANITIZE_CONFIG.USE_PROFILES).toMatchObject({
      svg: true,
      svgFilters: true,
      html: true,
    })
  })

  test('foreignObject 在 ADD_TAGS 白名单（纯 svg profile 双黑名单会剥掉标签文字）', () => {
    expect([...MERMAID_SANITIZE_CONFIG.ADD_TAGS]).toContain('foreignObject')
  })
})

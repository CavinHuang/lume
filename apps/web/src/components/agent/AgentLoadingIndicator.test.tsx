import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentLoadingIndicator } from './AgentLoadingIndicator'

describe('AgentLoadingIndicator', () => {
  test('renders 9 pixel cells with staggered wavefront animation', () => {
    const html = renderToStaticMarkup(<AgentLoadingIndicator label="执行中" startedAt={new Date(Date.now() - 5000).toISOString()} />)
    // 9 格；首格 delay 0、最大 delay 270（drive 波前 (列+|行-1|)*90 的最大值）
    expect(html.match(/lume-pixel-on/g)).toHaveLength(9)
    expect(html).toContain('lume-pixel-on 650ms ease-in-out 0ms infinite')
    expect(html).toContain('lume-pixel-on 650ms ease-in-out 270ms infinite')
    // shimmer 标签复用既有类；计时已过 5s
    expect(html).toContain('lume-shimmer-text')
    expect(html).toMatch(/>5s</)
  })

  test('orbit variant dims the center cell and omits label/elapsed when absent', () => {
    const html = renderToStaticMarkup(<AgentLoadingIndicator variant="orbit" />)
    expect(html).toContain('lume-pixel-on 950ms ease-in-out 0ms infinite')
    // 中心格（index 4）不在周长上：opacity 0.07 且无动画
    expect(html).toContain('opacity:0.07')
    expect(html).toContain('animation:none')
    expect(html).not.toContain('lume-shimmer-text')
    expect(html).not.toMatch(/>[0-9]+m?s</)
  })
})

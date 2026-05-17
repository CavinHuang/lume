import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextWindowIndicator } from './ContextWindowIndicator'
import type { ContextWindowProgress } from './runtime-state-projections'

describe('ContextWindowIndicator contract', () => {
  test('shows Alice-style thresholds and Lume budget sections when expanded', () => {
    const progress: ContextWindowProgress = {
      usedTokens: 420,
      contextWindow: 1000,
      remainingTokens: 580,
      percent: 42,
      tone: 'active',
      label: 'Context window',
      detail: '420 / 1K tokens',
      usage: {
        inputTokens: 300,
        cachedTokens: 60,
        outputTokens: 120,
        costUSD: 0.0187,
        records: [
          {
            callerLabel: 'gpt-test',
            inputTokens: 300,
            cachedTokens: 60,
            cacheHitRate: 20,
            outputTokens: 120,
            costUSD: 0.0187,
          },
        ],
      },
      sections: [
        { id: 'system', label: '系统', tokens: 130, percent: 13 },
        { id: 'memory', label: '记忆', tokens: 70, percent: 7 },
        { id: 'session', label: '会话', tokens: 180, percent: 18 },
        { id: 'toolSchemas', label: '工具 Schema', tokens: 40, percent: 4 },
      ],
    }

    const html = renderToStaticMarkup(
      <ContextWindowIndicator progress={progress} defaultOpen />,
    )

    expect(html).toContain('上下文占用')
    expect(html).toContain('Snip + MicroCompact')
    expect(html).toContain('Auto Compact')
    expect(html).toContain('Collapse')
    expect(html).toContain('占用明细')
    expect(html).toContain('系统')
    expect(html).toContain('130')
    expect(html).toContain('13%')
    expect(html).toContain('工具 Schema')
    expect(html).toContain('Token 明细')
    expect(html).toContain('总输入')
    expect(html).toContain('缓存命中')
    expect(html).toContain('总输出')
    expect(html).toContain('总费用')
    expect(html).toContain('$0.0187')
    expect(html).toContain('调用方')
    expect(html).toContain('↑输入')
    expect(html).toContain('↑缓存')
    expect(html).toContain('命中率')
    expect(html).toContain('↓输出')
    expect(html).toContain('费用')
    expect(html).toContain('gpt-test')
    expect(html).toContain('20%')
  })
})

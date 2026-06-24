import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DefaultResult } from './default-result'

describe('DefaultResult', () => {
  test('renders a multiline string result with real line breaks, not literal \\n', () => {
    const html = renderToStaticMarkup(
      <DefaultResult input={{}} result={'第一行\n第二行\n第三行'} />,
    )
    expect(html).toContain('第一行')
    expect(html).toContain('第二行')
    expect(html).toContain('第三行')
    // 核心断言：不应出现字面量 \n（反斜杠+n 两字符），应为真实换行
    expect(html).not.toContain('\\n')
  })

  test('falls back to pretty JSON for non-string results', () => {
    const html = renderToStaticMarkup(
      <DefaultResult input={{}} result={{ ok: true, count: 3 }} />,
    )
    // renderToStaticMarkup 会把 " 编码为 &quot;
    expect(html).toContain('&quot;ok&quot;')
    expect(html).toContain('&quot;count&quot;')
  })

  test('renders input JSON when result is undefined', () => {
    const html = renderToStaticMarkup(
      <DefaultResult input={{ query: 'hi' }} result={undefined} />,
    )
    expect(html).toContain('&quot;query&quot;')
    expect(html).toContain('hi')
  })
})

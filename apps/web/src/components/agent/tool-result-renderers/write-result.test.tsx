import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { WriteResult } from './write-result'

/** #712/#714：WriteResult 行数与 ± 统计的静态渲染口径 */
describe('WriteResult', () => {
  test('renders file path with total and +/- line stats', () => {
    const html = renderToStaticMarkup(
      <WriteResult input={{ file_path: 'src/app.ts' }} result={{ lines: 12, linesAdded: 3, linesRemoved: 1 }} />,
    )
    expect(html).toContain('src/app.ts')
    expect(html).toContain('共 12 行')
    expect(html).toContain('+3')
    expect(html).toContain('-1')
  })

  test('omits missing stat fields instead of rendering NaN or undefined', () => {
    const html = renderToStaticMarkup(<WriteResult input={{ file_path: 'a.ts' }} result={{} } />)
    expect(html).not.toContain('NaN')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('共')
  })

  test('falls back to empty path when input lacks file_path', () => {
    const html = renderToStaticMarkup(<WriteResult input={{}} result={{ lines: 1 }} />)
    expect(html).toContain('共 1 行')
    expect(html).not.toContain('undefined')
  })
})

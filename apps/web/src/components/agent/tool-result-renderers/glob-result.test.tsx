import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GlobResult } from './glob-result'

describe('GlobResult', () => {
  test('renders the requested glob expression and path context', () => {
    const html = renderToStaticMarkup(
      <GlobResult
        input={{ pattern: '**/*.ts', path: 'apps/web/src' }}
        result={{
          data: {
            matches: ['src/main.ts'],
          },
        }}
      />,
    )

    expect(html).toContain('**/*.ts')
    expect(html).toContain('apps/web/src')
  })

  test('renders matches returned under data.matches', () => {
    const html = renderToStaticMarkup(
      <GlobResult
        input={{ pattern: '**/*.ts' }}
        result={{
          data: {
            matches: ['src/main.ts', 'src/lib/utils.ts'],
          },
        }}
      />,
    )

    expect(html).toContain('src/main.ts')
    expect(html).toContain('src/lib/utils.ts')
  })
})

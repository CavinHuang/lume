import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { clearHighlightCache, highlightCode } from '@lume/ui'
import { inferCodeLanguageFromPath } from './code-language'
import { SourceCodePreview } from './SourceCodePreview'

describe('SourceCodePreview', () => {
  test('renders source content with line numbers', () => {
    const markup = renderToStaticMarkup(
      <SourceCodePreview path="src/example.ts" content={'const value = 1\nconsole.log(value)'} />,
    )

    expect(markup).toContain('const value = 1')
    expect(markup).toContain('console.log(value)')
    expect(markup).toContain('>1</span>')
    expect(markup).toContain('>2</span>')
  })

  test('renders javascript source with Shiki color tokens after highlighter is ready', async () => {
    clearHighlightCache()
    await highlightCode({ code: 'const value = 1', language: 'javascript' })

    const markup = renderToStaticMarkup(
      <SourceCodePreview path="src/index.js" content="const value = 1" />,
    )

    expect(markup).toContain('style="color:')
    expect(markup).toContain('const')
  })

  test('infers Shiki language ids from common file names', () => {
    expect(inferCodeLanguageFromPath('src/App.tsx')).toBe('tsx')
    expect(inferCodeLanguageFromPath('vite.config.mts')).toBe('typescript')
    expect(inferCodeLanguageFromPath('eslint.config.mjs')).toBe('javascript')
    expect(inferCodeLanguageFromPath('tsconfig.jsonc')).toBe('jsonc')
    expect(inferCodeLanguageFromPath('scripts/start.sh')).toBe('shellscript')
    expect(inferCodeLanguageFromPath('Dockerfile')).toBe('dockerfile')
    expect(inferCodeLanguageFromPath('.env.local')).toBe('dotenv')
    expect(inferCodeLanguageFromPath('docker-compose.yml')).toBe('yaml')
    expect(inferCodeLanguageFromPath('CMakeLists.txt')).toBe('cmake')
    expect(inferCodeLanguageFromPath('Makefile')).toBe('makefile')
    expect(inferCodeLanguageFromPath('config/nginx.conf')).toBe('nginx')
    expect(inferCodeLanguageFromPath('changes.patch')).toBe('diff')
    expect(inferCodeLanguageFromPath('schema.proto')).toBe('proto')
    expect(inferCodeLanguageFromPath('diagram.mmd')).toBe('mermaid')
    expect(inferCodeLanguageFromPath('data.csv')).toBe('csv')
    expect(inferCodeLanguageFromPath('build.gradle')).toBe('groovy')
    expect(inferCodeLanguageFromPath('notes.unknown')).toBe('text')
  })
})

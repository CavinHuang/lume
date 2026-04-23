import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

describe('Lume theme contract', () => {
  test('index.css defines the new theme foundation tokens', () => {
    const indexCss = readWebFile('src', 'index.css')
    const requiredTokens = [
      '--brand:',
      '--brand-2:',
      '--surface-1:',
      '--surface-2:',
      '--surface-3:',
      '--text-1:',
      '--text-2:',
      '--text-3:',
      '--border-strong:',
      '--shadow-panel:',
    ]

    for (const token of requiredTokens) {
      expect(indexCss).toContain(token)
    }
  })

  test('AppShell removes the old zinc gradient shell styling', () => {
    const appShell = readWebFile('src', 'components', 'app-shell', 'AppShell.tsx')

    expect(appShell).not.toContain('from-zinc-50')
    expect(appShell).not.toContain('dark:from-zinc-950')
  })

  test('MainArea removes the old glass panel background classes', () => {
    const mainArea = readWebFile('src', 'components', 'tabs', 'MainArea.tsx')

    expect(mainArea).not.toContain('bg-white/95')
    expect(mainArea).not.toContain('dark:bg-zinc-900/95')
  })
})

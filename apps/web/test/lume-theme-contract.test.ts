import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

describe('Lume theme contract', () => {
  test('index.css defines the exact theme foundation tokens in :root and .dark', () => {
    const indexCss = readWebFile('src', 'index.css')
    const rootTokens = [
      '--brand: oklch(0.67 0.2 282);',
      '--brand-2: oklch(0.73 0.18 294);',
      '--brand-foreground: oklch(1 0 0);',
      '--surface-1: oklch(0.985 0.004 275);',
      '--surface-2: oklch(0.968 0.006 275);',
      '--surface-3: oklch(0.945 0.008 275);',
      '--text-1: oklch(0.19 0.01 275);',
      '--text-2: oklch(0.42 0.01 275);',
      '--text-3: oklch(0.58 0.008 275);',
      '--border-strong: oklch(0.85 0.01 275);',
      '--shadow-panel: 220 40% 2%;',
    ]
    const darkTokens = [
      '--brand: oklch(0.72 0.19 283);',
      '--brand-2: oklch(0.78 0.17 295);',
      '--brand-foreground: oklch(1 0 0);',
      '--surface-1: oklch(0.19 0.01 275);',
      '--surface-2: oklch(0.22 0.012 275);',
      '--surface-3: oklch(0.255 0.014 275);',
      '--text-1: oklch(0.96 0.004 275);',
      '--text-2: oklch(0.82 0.006 275);',
      '--text-3: oklch(0.67 0.008 275);',
      '--border-strong: oklch(0.34 0.012 275);',
      '--shadow-panel: 228 60% 2%;',
    ]

    for (const token of rootTokens) {
      expect(indexCss).toContain(token)
    }

    for (const token of darkTokens) {
      expect(indexCss).toContain(token)
    }
  })

  test('AppShell uses the exact baseline wrapper class string', () => {
    const appShell = readWebFile('src', 'components', 'app-shell', 'AppShell.tsx')

    expect(appShell).toContain(
      'h-screen w-screen flex overflow-hidden bg-background text-foreground'
    )
  })

  test('MainArea uses the exact baseline wrapper and content area class strings', () => {
    const mainArea = readWebFile('src', 'components', 'tabs', 'MainArea.tsx')

    expect(mainArea).toContain('h-full flex flex-col bg-background overflow-hidden')
    expect(mainArea).toContain('flex-1 min-h-0 flex bg-background')
  })
})

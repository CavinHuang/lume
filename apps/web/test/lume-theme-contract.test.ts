import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

function extractCssBlock(source: string, selector: string, occurrence: 'first' | 'last' = 'first') {
  const startIndex = occurrence === 'last'
    ? source.lastIndexOf(selector)
    : source.indexOf(selector)
  expect(startIndex).toBeGreaterThanOrEqual(0)

  const openBraceIndex = source.indexOf('{', startIndex)
  expect(openBraceIndex).toBeGreaterThanOrEqual(0)

  let depth = 0
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) {
      return source.slice(openBraceIndex + 1, index)
    }
  }

  throw new Error(`Could not extract CSS block for selector: ${selector}`)
}

describe('Lume theme contract', () => {
  test('index.css defines the exact theme foundation tokens in :root and .dark', () => {
    const indexCss = readWebFile('src', 'index.css')
    const rootBlock = extractCssBlock(indexCss, ':root')
    const darkBlock = extractCssBlock(indexCss, '.dark', 'last')
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
      expect(rootBlock).toContain(token)
    }

    for (const token of darkTokens) {
      expect(darkBlock).toContain(token)
    }
  })

  test('AppShell keeps the required baseline shell classes without legacy zinc styling', () => {
    const appShell = readWebFile('src', 'components', 'app-shell', 'AppShell.tsx')
    const requiredClasses = [
      'h-screen',
      'w-screen',
      'flex',
      'overflow-hidden',
      'bg-background',
      'text-foreground',
    ]

    for (const className of requiredClasses) {
      expect(appShell).toContain(className)
    }

    expect(appShell).not.toContain('from-zinc-50')
    expect(appShell).not.toContain('dark:from-zinc-950')
  })

  test('MainArea keeps the required baseline wrapper and content classes without legacy glass styling', () => {
    const mainArea = readWebFile('src', 'components', 'tabs', 'MainArea.tsx')
    const wrapperClasses = [
      'h-full',
      'flex',
      'flex-col',
      'bg-background',
      'overflow-hidden',
    ]
    const contentClasses = [
      'flex-1',
      'min-h-0',
      'flex',
      'bg-background',
    ]

    for (const className of wrapperClasses) {
      expect(mainArea).toContain(className)
    }

    for (const className of contentClasses) {
      expect(mainArea).toContain(className)
    }

    expect(mainArea).not.toContain('bg-white/95')
    expect(mainArea).not.toContain('dark:bg-zinc-900/95')
  })
})

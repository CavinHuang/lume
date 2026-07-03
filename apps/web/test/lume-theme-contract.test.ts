import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

function extractCssBlockBody(source: string, selector: string, startFrom = 0) {
  const startIndex = source.indexOf(selector, startFrom)
  if (startIndex < 0) return null

  const openBraceIndex = source.indexOf('{', startIndex)
  if (openBraceIndex < 0) return null

  let depth = 0
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) {
      return {
        body: source.slice(openBraceIndex + 1, index),
        nextIndex: index + 1,
      }
    }
  }

  return null
}

function extractCssBlockWithToken(source: string, selector: string, token: string) {
  let startFrom = 0

  while (startFrom < source.length) {
    const block = extractCssBlockBody(source, selector, startFrom)
    if (!block) break
    if (block.body.includes(token)) return block.body
    startFrom = block.nextIndex
  }

  throw new Error(`Could not find ${selector} block containing token: ${token}`)
}

function expectClassListToContain(source: string, pattern: RegExp, requiredClasses: string[]) {
  const match = source.match(pattern)
  expect(match).not.toBeNull()

  const classList = match?.[1].split(/\s+/).filter(Boolean) ?? []
  for (const className of requiredClasses) {
    expect(classList).toContain(className)
  }
}

describe('Lume theme contract', () => {
  test('index.css defines the exact theme foundation tokens in :root and .dark', () => {
    const indexCss = readWebFile('src', 'index.css')
    const rootBlock = extractCssBlockWithToken(indexCss, ':root', '--lume-bg-app: oklch(0.982 0.006 248);')
    const darkBlock = extractCssBlockWithToken(indexCss, '.dark', '--lume-bg-app: oklch(0.155 0.012 248);')
    const rootTokens = [
      '--lume-bg-app: oklch(0.982 0.006 248);',
      '--lume-bg-rail: oklch(0.962 0.007 248);',
      '--lume-bg-panel: oklch(0.996 0.003 248);',
      '--lume-bg-elevated: oklch(1 0 0);',
      '--lume-border-subtle: oklch(0.89 0.012 248);',
      '--lume-border-strong: oklch(0.79 0.018 248);',
      '--lume-text-primary: oklch(0.18 0.012 248);',
      '--lume-text-secondary: oklch(0.42 0.014 248);',
      '--lume-text-muted: oklch(0.58 0.012 248);',
      '--lume-accent: oklch(0.57 0.13 202);',
      '--lume-accent-soft: oklch(0.93 0.03 202);',
      '--lume-accent-foreground: oklch(0.99 0.004 202);',
      '--lume-focus-ring: oklch(0.66 0.13 202 / 42%);',
      '--lume-danger: oklch(0.62 0.18 25);',
      '--lume-success: oklch(0.62 0.13 155);',
      '--lume-warning: oklch(0.72 0.14 75);',
      '--lume-shadow-panel: var(--shadow-panel);',
      '--brand: var(--lume-accent);',
      '--surface-1: var(--lume-bg-panel);',
      '--text-1: var(--lume-text-primary);',
      '--border-strong: var(--lume-border-strong);',
      '--app-scrollbar-thumb: color-mix(in oklab, var(--lume-border-subtle) 78%, transparent);',
      '--app-scrollbar-thumb-active: color-mix(in oklab, var(--lume-text-primary) 16%, var(--lume-border-subtle));',
      '--app-scrollbar-track: transparent;',
    ]
    const darkTokens = [
      '--lume-bg-app: oklch(0.155 0.012 248);',
      '--lume-bg-rail: oklch(0.18 0.013 248);',
      '--lume-bg-panel: oklch(0.205 0.012 248);',
      '--lume-bg-elevated: oklch(0.245 0.014 248);',
      '--lume-border-subtle: oklch(0.33 0.012 248 / 62%);',
      '--lume-border-strong: oklch(0.4 0.018 248);',
      '--lume-text-primary: oklch(0.94 0.006 248);',
      '--lume-text-secondary: oklch(0.78 0.01 248);',
      '--lume-text-muted: oklch(0.62 0.012 248);',
      '--lume-accent: oklch(0.72 0.12 202);',
      '--lume-accent-soft: oklch(0.35 0.05 202 / 42%);',
      '--lume-accent-foreground: oklch(0.12 0.018 202);',
      '--lume-focus-ring: oklch(0.74 0.13 202 / 42%);',
      '--lume-danger: oklch(0.68 0.16 25);',
      '--lume-success: oklch(0.72 0.12 155);',
      '--lume-warning: oklch(0.78 0.13 75);',
      '--lume-shadow-panel: var(--shadow-panel);',
      '--brand: var(--lume-accent);',
      '--surface-1: var(--lume-bg-panel);',
      '--text-1: var(--lume-text-primary);',
      '--border-strong: var(--lume-border-strong);',
      '--app-scrollbar-thumb: color-mix(in oklab, var(--lume-border-subtle) 78%, transparent);',
      '--app-scrollbar-thumb-active: color-mix(in oklab, var(--lume-text-primary) 16%, var(--lume-border-subtle));',
      '--app-scrollbar-track: transparent;',
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
      'bg-[var(--lume-bg-app)]',
      'text-[var(--lume-text-primary)]',
    ]

    expectClassListToContain(appShell, /<div className="([^"]+)">\s*<TitleBar \/>/s, requiredClasses)

    expect(appShell).not.toContain('from-zinc-50')
    expect(appShell).not.toContain('dark:from-zinc-950')
  })

  test('MainArea keeps the required baseline wrapper and content classes without legacy glass styling', () => {
    const mainArea = readWebFile('src', 'components', 'tabs', 'MainArea.tsx')
    const wrapperClasses = [
      'h-full',
      'flex',
      'flex-col',
      'overflow-hidden',
      'bg-[var(--lume-bg-panel)]',
    ]
    const contentClasses = [
      'flex-1',
      'min-h-0',
      'flex',
      'bg-[var(--lume-bg-panel)]',
    ]

    expectClassListToContain(mainArea, /<div className="([^"]+)">\s*<TabBar \/>/s, wrapperClasses)
    expectClassListToContain(mainArea, /<div className="([^"]+)">\s*<TabContent \/>/s, contentClasses)

    expect(mainArea).not.toContain('bg-white/95')
    expect(mainArea).not.toContain('dark:bg-zinc-900/95')
  })

  test('TabBar uses Lume surface tokens without legacy zinc tabs', () => {
    const tabBar = readWebFile('src', 'components', 'tabs', 'TabBar.tsx')
    expect(tabBar).toContain('bg-[var(--lume-bg-elevated)]')
    expect(tabBar).not.toContain('bg-white')
    expect(tabBar).not.toContain('dark:bg-zinc')
  })

  test('LumeSidebar uses the unified sidebar border token for its main rail divider', () => {
    const lumeSidebar = readWebFile('src', 'components', 'app-shell', 'LumeSidebar.tsx')
    const collapsedRail = lumeSidebar.match(/className="([^"]*w-\[72px\][^"]*)"/)?.[1] ?? ''
    const expandedRail = lumeSidebar.match(/className="([^"]*w-\[286px\][^"]*)"/)?.[1] ?? ''

    expect(collapsedRail).toContain('border-r')
    expect(collapsedRail).toContain('border-sidebar-border')
    expect(expandedRail).toContain('border-r')
    expect(expandedRail).toContain('border-sidebar-border')
    expect(collapsedRail).not.toContain('border-[var(--border-strong)]')
    expect(expandedRail).not.toContain('border-[var(--border-strong)]')
    expect(lumeSidebar).toContain('bg-[var(--lume-bg-rail)]')
    expect(lumeSidebar).not.toContain('bg-gradient-to-r')
    expect(lumeSidebar).not.toContain('hover:translate-y-[-1px]')
  })
})

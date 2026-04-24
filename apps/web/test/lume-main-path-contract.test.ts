import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')

function readWebFile(...parts: string[]) {
  return readFileSync(join(webRoot, ...parts), 'utf-8')
}

function expectSourceToExclude(source: string, legacyTokens: string[]) {
  for (const legacyToken of legacyTokens) {
    expect(source).not.toContain(legacyToken)
  }
}

describe('Lume main-path contract', () => {
  test('LeftSidebar routes the shell through LumeSidebar without legacy glass-shell classes', () => {
    const source = readWebFile('src', 'components', 'app-shell', 'LeftSidebar.tsx')

    expect(source).toContain("import { LumeSidebar } from './LumeSidebar'")
    expect(source).toContain('<LumeSidebar')

    expectSourceToExclude(source, [
      'bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl',
      'SidebarAction',
      'ThreadItem',
    ])
  })

  test('WelcomeView routes the welcome surface through LumeWelcomeSurface without legacy inline welcome-shell classes', () => {
    const source = readWebFile('src', 'components', 'welcome', 'WelcomeView.tsx')

    expect(source).toContain("import { LumeWelcomeSurface } from './LumeWelcomeSurface'")
    expect(source).toContain('<LumeWelcomeSurface')

    expectSourceToExclude(source, [
      'max-w-xl flex flex-col items-center',
      'bg-gradient-to-r from-indigo-500 to-violet-500 bg-clip-text text-transparent',
      '<RecentThreads',
    ])
  })

  test('AgentInput routes the shared composer through LumeComposer and drops the legacy disabled naming', () => {
    const inputSource = readWebFile('src', 'components', 'agent', 'AgentInput.tsx')
    const viewSource = readWebFile('src', 'components', 'agent', 'AgentView.tsx')

    expect(inputSource).toContain("import { getLumeComposerPrimaryActionClassName, LumeComposer } from '@/components/composer/LumeComposer'")
    expect(inputSource).toContain('<LumeComposer')
    expect(inputSource).toContain('streaming?: boolean')
    expect(inputSource).not.toContain('disabled?: boolean')

    expect(viewSource).toContain('<AgentInput threadId={threadId} streaming={streamingState === \'streaming\'} />')
    expect(viewSource).not.toContain('<AgentInput threadId={threadId} disabled={streamingState === \'streaming\'} />')

    expectSourceToExclude(inputSource, [
      'rounded-2xl border border-border/60 bg-background shadow-sm transition-colors',
      'bg-primary text-primary-foreground hover:opacity-90 transition-opacity',
      'bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors',
    ])
  })
})

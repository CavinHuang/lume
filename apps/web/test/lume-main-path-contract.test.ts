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

  test('Skills sidebar entry opens the restored main skills marketplace surface', () => {
    const tabAtoms = readWebFile('src', 'atoms', 'tab-atoms.ts')
    const leftSidebar = readWebFile('src', 'components', 'app-shell', 'LeftSidebar.tsx')
    const tabContent = readWebFile('src', 'components', 'tabs', 'TabContent.tsx')
    const viewModel = readWebFile('src', 'components', 'app-shell', 'lume-sidebar-view-model.ts')
    const source = readWebFile('src', 'components', 'skills', 'SkillsMarketView.tsx')

    expect(tabAtoms).toContain("'skills'")
    expect(leftSidebar).toContain("const skillsId = '__skills__'")
    expect(leftSidebar).toContain("{ id: skillsId, type: 'skills', title: '技能' }")
    expect(tabContent).toContain("import { SkillsMarketView } from '@/components/skills/SkillsMarketView'")
    expect(tabContent).toContain("if (activeTab.type === 'skills')")
    expect(viewModel).toContain("activeTabId === '__skills__'")
    expect(source).toContain('技能市场')
    expect(source).toContain('统一管理和筛选内置技能、本地发现技能与外部市场源技能。')
    expect(source).toContain('市场源')
    expect(source).toContain('grid-cols-[minmax(0,1fr)_338px]')
    expect(source).toContain('getSkillMarketCatalog')
    expect(source).not.toContain('SKILL_MARKET_FALLBACK_ITEMS')
    expect(source).toContain('SkillSourcePanel')
  })

  test('Skills marketplace includes an add-source dialog with source details and trust copy', () => {
    const source = readWebFile('src', 'components', 'skills', 'SkillsMarketView.tsx')

    expect(source).toContain('AddSkillSourceDialog')
    expect(source).toContain('sourceDialogOpen')
    expect(source).toContain('添加市场源')
    expect(source).toContain('添加新的技能来源')
    expect(source).toContain('接入方式')
    expect(source).toContain('本地目录')
    expect(source).toContain('远程地址')
    expect(source).toContain('来源类型')
    expect(source).toContain('源名称')
    expect(source).toContain('源地址')
    expect(source).toContain('本地路径')
    expect(source).toContain("connectionMode === 'remote'")
    expect(source).toContain("connectionMode === 'local'")
    expect(source).toContain('信任与同步')
    expect(source).toContain('添加并同步')
    expect(source).toContain('setSourceDialogOpen(true)')
    expect(source).toContain('importLocalSkillDirectoryToWorkspace')
    expect(source).toContain('getGitHubSkillReview')
    expect(source).toContain('installGitHubSkillToWorkspace')
    expect(source).toContain('installSkillMarketItemToWorkspace')
    expect(source).toContain('deleteWorkspaceSkill')
  })

  test('Skills marketplace opens real skill details with an Agent skill file tree', () => {
    const source = readWebFile('src', 'components', 'skills', 'SkillsMarketView.tsx')
    const api = readWebFile('src', 'lib', 'desktop-api', 'skills-market.ts')
    const shared = readWebFile('..', '..', 'packages', 'shared', 'src', 'types', 'agent.ts')
    const sidecar = readWebFile('..', 'sidecar', 'src', 'services', 'system', 'skills-market-service.ts')

    expect(source).toContain('SkillDetailDialog')
    expect(source).toContain('SkillFileTree')
    expect(source).toContain('handleOpenSkillDetail')
    expect(source).toContain('getSkillMarketDetail')
    expect(source).toContain('installSkillMarketItemToWorkspace')
    expect(source).toContain('isInstallableSkillMarketItem')
    expect(source).not.toContain('.slice(0, 6)')
    expect(source).toContain('文件树')
    expect(source).toContain('技能目录')
    expect(source).toContain('当前文件内容')
    expect(source).toContain('selectedFile')
    expect(source).toContain('findDefaultSkillFilePath')
    expect(source).toContain('findFileNode')
    expect(api).toContain("sidecarCall<SkillMarketDetailResult>('agent:get-skill-market-detail'")
    expect(shared).toContain('SkillMarketDetailResult')
    expect(shared).toContain('content?: string')
    expect(shared).toContain("GET_SKILL_MARKET_DETAIL: 'agent:get-skill-market-detail'")
    expect(sidecar).toContain('getSkillMarketDetail')
    expect(sidecar).toContain('buildFileTreeFromDir')
  })
})

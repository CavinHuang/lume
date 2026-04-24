# Lume Main Path UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Lume's first-pass main path UI so the sidebar, welcome surface, and composer match the approved design direction while preserving real data flows and existing editor behavior.

**Architecture:** Keep the existing desktop shell and data atoms, but split presentation into three branded surfaces: a Lume sidebar, a Lume welcome surface, and a shared Lume composer. Use pure view-model helpers and file-content contract tests to lock the visual structure before changing the React components, then wire the new surfaces into the current `WelcomeView` and `AgentInput` flows.

**Tech Stack:** React 18, Vite, Tailwind CSS v4, shadcn/base-ui primitives, Jotai, TipTap, Bun test

---

## File Structure

### Create

- `apps/web/test/lume-theme-contract.test.ts`
- `apps/web/test/lume-main-path-contract.test.ts`
- `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`
- `apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`
- `apps/web/src/components/app-shell/LumeSidebar.tsx`
- `apps/web/src/components/welcome/welcome-surface-view-model.ts`
- `apps/web/src/components/welcome/welcome-surface-view-model.test.ts`
- `apps/web/src/components/welcome/LumeWelcomeSurface.tsx`
- `apps/web/src/components/composer/lume-composer-state.ts`
- `apps/web/src/components/composer/lume-composer-state.test.ts`
- `apps/web/src/components/composer/LumeComposer.tsx`

### Modify

- `apps/web/src/index.css`
- `apps/web/src/components/app-shell/AppShell.tsx`
- `apps/web/src/components/app-shell/LeftSidebar.tsx`
- `apps/web/src/components/tabs/MainArea.tsx`
- `apps/web/src/components/welcome/WelcomeView.tsx`
- `apps/web/src/components/welcome/RecentThreads.tsx`
- `apps/web/src/components/welcome/WorkspaceSelector.tsx`
- `apps/web/src/components/welcome/WelcomeModelPicker.tsx`
- `apps/web/src/components/agent/AgentInput.tsx`
- `apps/web/src/components/agent/AgentView.tsx`

### Responsibilities

- `index.css` owns the Lume theme contract: semantic tokens stay intact, branded `--brand`, `--surface-*`, `--text-*`, `--border-strong`, and shadow/glow tokens get added here.
- `LumeSidebar.tsx` owns visual markup for the branded sidebar; `lume-sidebar-view-model.ts` owns all grouping and display-limiting logic so it can be tested without rendering.
- `LumeWelcomeSurface.tsx` owns the center-stage welcome layout; `welcome-surface-view-model.ts` owns fixed-card slots, recent-item limits, and empty-state decisions.
- `LumeComposer.tsx` owns the branded input shell; `lume-composer-state.ts` owns the send/stop/disabled state mapping used by both welcome and thread input.
- Contract tests under `apps/web/test` enforce that the top-level shells actually use the new branded surfaces and do not regress to the current zinc-heavy layout classes.

## Task 1: Establish the Lume Theme Contract

**Files:**
- Create: `apps/web/test/lume-theme-contract.test.ts`
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/components/app-shell/AppShell.tsx`
- Modify: `apps/web/src/components/tabs/MainArea.tsx`

- [ ] **Step 1: Write the failing contract test**

```ts
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')
const indexCss = readFileSync(resolve(webRoot, 'src/index.css'), 'utf-8')
const appShell = readFileSync(resolve(webRoot, 'src/components/app-shell/AppShell.tsx'), 'utf-8')
const mainArea = readFileSync(resolve(webRoot, 'src/components/tabs/MainArea.tsx'), 'utf-8')

describe('lume theme contract', () => {
  test('defines branded theme tokens in index.css', () => {
    expect(indexCss).toContain('--brand:')
    expect(indexCss).toContain('--brand-2:')
    expect(indexCss).toContain('--surface-1:')
    expect(indexCss).toContain('--surface-2:')
    expect(indexCss).toContain('--surface-3:')
    expect(indexCss).toContain('--text-1:')
    expect(indexCss).toContain('--text-2:')
    expect(indexCss).toContain('--text-3:')
    expect(indexCss).toContain('--border-strong:')
    expect(indexCss).toContain('--shadow-panel:')
  })

  test('main path shells stop using the old zinc gradient container', () => {
    expect(appShell).not.toContain('from-zinc-50')
    expect(appShell).not.toContain('dark:from-zinc-950')
    expect(mainArea).not.toContain('bg-white/95')
    expect(mainArea).not.toContain('dark:bg-zinc-900/95')
  })
})
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `bun test apps/web/test/lume-theme-contract.test.ts`  
Expected: FAIL because the new `--brand`, `--surface-*`, `--text-*`, and `--shadow-panel` tokens do not exist yet, and the shell components still contain the old zinc/white classes.

- [ ] **Step 3: Add the theme tokens and move the shell surfaces to the new contract**

```css
/* apps/web/src/index.css */
:root {
  --brand: oklch(0.67 0.2 282);
  --brand-2: oklch(0.73 0.18 294);
  --brand-foreground: oklch(1 0 0);
  --surface-1: oklch(0.985 0.004 275);
  --surface-2: oklch(0.968 0.006 275);
  --surface-3: oklch(0.945 0.008 275);
  --text-1: oklch(0.19 0.01 275);
  --text-2: oklch(0.42 0.01 275);
  --text-3: oklch(0.58 0.008 275);
  --border-strong: oklch(0.85 0.01 275);
  --shadow-panel: 220 40% 2%;
}

.dark {
  --brand: oklch(0.72 0.19 283);
  --brand-2: oklch(0.78 0.17 295);
  --brand-foreground: oklch(1 0 0);
  --surface-1: oklch(0.19 0.01 275);
  --surface-2: oklch(0.22 0.012 275);
  --surface-3: oklch(0.255 0.014 275);
  --text-1: oklch(0.96 0.004 275);
  --text-2: oklch(0.82 0.006 275);
  --text-3: oklch(0.67 0.008 275);
  --border-strong: oklch(0.34 0.012 275);
  --shadow-panel: 228 60% 2%;
}
```

```tsx
// apps/web/src/components/app-shell/AppShell.tsx
return (
  <div className="h-screen w-screen flex overflow-hidden bg-background text-foreground">
    <TitleBar />
    <div className="p-0 relative z-[60]">
      <LeftSidebar />
    </div>
    <div className="flex-1 min-w-0 relative z-[60]">
      <MainArea />
    </div>
    <CommandPalette />
  </div>
)
```

```tsx
// apps/web/src/components/tabs/MainArea.tsx
return (
  <div className="h-full flex flex-col bg-background overflow-hidden">
    <TabBar />
    <div className="flex-1 min-h-0 flex bg-background">
      <TabContent />
    </div>
  </div>
)
```

- [ ] **Step 4: Re-run the contract test**

Run: `bun test apps/web/test/lume-theme-contract.test.ts`  
Expected: PASS with 2 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/test/lume-theme-contract.test.ts apps/web/src/index.css apps/web/src/components/app-shell/AppShell.tsx apps/web/src/components/tabs/MainArea.tsx
git commit -m "💄 ui(web): 建立 Lume 主路径主题基线"
```

## Task 2: Rebuild the Sidebar as a Branded Navigation Surface

**Files:**
- Create: `apps/web/src/components/app-shell/lume-sidebar-view-model.ts`
- Create: `apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`
- Create: `apps/web/src/components/app-shell/LumeSidebar.tsx`
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`
- Modify: `apps/web/src/components/agent/AgentView.tsx`

- [ ] **Step 1: Write the failing sidebar view-model tests**

```ts
import { describe, expect, test } from 'bun:test'
import { buildSidebarSections } from './lume-sidebar-view-model'

const threads = [
  { id: 't-1', title: '重新设计 Lume 的 UI', workspaceId: 'ws-1', updatedAt: Date.now(), pinned: false },
  { id: 't-2', title: 'Q2 产品路线图讨论', workspaceId: 'ws-1', updatedAt: Date.now() - 86_400_000, pinned: false },
]

const workspaces = [
  { id: 'ws-1', name: 'Lume Core', slug: 'lume-core' },
]

describe('buildSidebarSections', () => {
  test('returns the fixed top actions in design order', () => {
    const result = buildSidebarSections({
      workspaces,
      threads,
      currentWorkspaceId: 'ws-1',
      activeTabId: '__welcome__',
      streamingStates: {},
    })

    expect(result.topActions.map((item) => item.id)).toEqual([
      'new-chat',
      'search',
      'skills',
      'automations',
    ])
  })

  test('marks the active welcome thread row and groups timeline items', () => {
    const result = buildSidebarSections({
      workspaces,
      threads,
      currentWorkspaceId: 'ws-1',
      activeTabId: '__welcome__',
      streamingStates: {},
    })

    expect(result.workspaceRows[0]?.items.some((item) => item.isActive)).toBe(true)
    expect(result.workspaceRows[0]?.groups.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the sidebar tests and verify they fail**

Run: `bun test apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`  
Expected: FAIL because `buildSidebarSections` does not exist yet.

- [ ] **Step 3: Create the sidebar view model and branded component**

```ts
// apps/web/src/components/app-shell/lume-sidebar-view-model.ts
export function buildSidebarSections(input: {
  workspaces: Array<{ id: string; name: string; slug?: string }>
  threads: Array<{ id: string; title: string; workspaceId?: string | null; updatedAt: number; pinned?: boolean }>
  currentWorkspaceId: string | null
  activeTabId: string | null
  streamingStates: Record<string, string>
}) {
  const topActions = [
    { id: 'new-chat', label: '新建聊天', kind: 'primary' as const },
    { id: 'search', label: '搜索', kind: 'search' as const },
    { id: 'skills', label: '技能', kind: 'nav' as const },
    { id: 'automations', label: '自动化', kind: 'disabled' as const, badge: '即将推出' },
  ]

  const workspaceRows = input.workspaces.map((workspace) => ({
    id: workspace.id,
    label: workspace.name,
    isCurrent: workspace.id === input.currentWorkspaceId,
    items: [
      {
        id: '__welcome__',
        label: '新对话',
        isActive: input.activeTabId === '__welcome__' && workspace.id === input.currentWorkspaceId,
      },
    ],
    groups: [],
  }))

  return { topActions, workspaceRows, footerActions: ['trash', 'settings'] }
}
```

```tsx
// apps/web/src/components/app-shell/LumeSidebar.tsx
export function LumeSidebar(props: {
  collapsed: boolean
  sections: ReturnType<typeof buildSidebarSections>
  onNewThread: () => void
  onOpenCommandPalette: () => void
  onOpenSettings: () => void
}) {
  return (
    <aside className="h-full w-[312px] shrink-0 border-r border-border bg-[hsl(var(--surface-1))]">
      <div className="flex h-full flex-col px-6 py-5">
        <button className="lume-primary-button h-12 w-full justify-between rounded-2xl px-4">
          <span>新建聊天</span>
          <span className="text-xs opacity-80">⌘N</span>
        </button>
        <div className="mt-4 rounded-2xl border border-border bg-[hsl(var(--surface-2))] px-4 py-3 text-sm text-[hsl(var(--text-3))]">
          搜索
        </div>
      </div>
    </aside>
  )
}
```

```tsx
// apps/web/src/components/app-shell/LeftSidebar.tsx
export function LeftSidebar() {
  const sections = buildSidebarSections({
    workspaces,
    threads,
    currentWorkspaceId,
    activeTabId,
    streamingStates,
  })

  return (
    <LumeSidebar
      collapsed={collapsed}
      sections={sections}
      onNewThread={handleNewThread}
      onOpenCommandPalette={() => setOpenCommandPalette(true)}
      onOpenSettings={openSettings}
    />
  )
}
```

- [ ] **Step 4: Re-run the sidebar tests and visually verify the shell spacing**

Run: `bun test apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`  
Expected: PASS with 2 passing tests.

Run: `bun run --filter @lume/web dev`  
Expected: The sidebar renders as a light, thin-bordered navigation surface instead of the current white/zinc glass card.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/app-shell/lume-sidebar-view-model.ts apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts apps/web/src/components/app-shell/LumeSidebar.tsx apps/web/src/components/app-shell/LeftSidebar.tsx apps/web/src/components/agent/AgentView.tsx
git commit -m "💄 ui(web): 重构左侧导航层级"
```

## Task 3: Build the Welcome Surface with Fixed Hero and Card Slots

**Files:**
- Create: `apps/web/src/components/welcome/welcome-surface-view-model.ts`
- Create: `apps/web/src/components/welcome/welcome-surface-view-model.test.ts`
- Create: `apps/web/src/components/welcome/LumeWelcomeSurface.tsx`
- Modify: `apps/web/src/components/welcome/WelcomeView.tsx`
- Modify: `apps/web/src/components/welcome/RecentThreads.tsx`
- Modify: `apps/web/src/components/welcome/WorkspaceSelector.tsx`
- Modify: `apps/web/src/components/welcome/WelcomeModelPicker.tsx`

- [ ] **Step 1: Write the failing welcome surface tests**

```ts
import { describe, expect, test } from 'bun:test'
import { buildWelcomeSurfaceModel } from './welcome-surface-view-model'

const threads = [
  { id: 't-1', title: '重新设计 Lume 的 UI', workspaceId: 'ws-1', updatedAt: Date.now(), pinned: false },
  { id: 't-2', title: 'Q2 产品路线图讨论', workspaceId: 'ws-1', updatedAt: Date.now() - 2_000, pinned: false },
  { id: 't-3', title: 'AI 赋能代码质量分析', workspaceId: 'ws-1', updatedAt: Date.now() - 4_000, pinned: false },
  { id: 't-4', title: '用户反馈分析与洞察', workspaceId: 'ws-1', updatedAt: Date.now() - 6_000, pinned: false },
]

describe('buildWelcomeSurfaceModel', () => {
  test('always returns four primary cards in a stable order', () => {
    const result = buildWelcomeSurfaceModel({
      workspaceName: 'Lume Core',
      threads,
      recentFiles: [],
    })

    expect(result.primaryCards).toHaveLength(4)
    expect(result.primaryCards.map((card) => card.id)).toEqual([
      'organize-requirements',
      'analyze-code',
      'release-checklist',
      'improve-ui-system',
    ])
  })

  test('caps recent threads to the designed panel size', () => {
    const result = buildWelcomeSurfaceModel({
      workspaceName: 'Lume Core',
      threads,
      recentFiles: [],
    })

    expect(result.recentThreads).toHaveLength(4)
  })
})
```

- [ ] **Step 2: Run the welcome tests and verify they fail**

Run: `bun test apps/web/src/components/welcome/welcome-surface-view-model.test.ts`  
Expected: FAIL because `buildWelcomeSurfaceModel` does not exist yet.

- [ ] **Step 3: Implement the welcome view model and branded welcome surface**

```ts
// apps/web/src/components/welcome/welcome-surface-view-model.ts
const PRIMARY_CARD_SLOTS = [
  { id: 'organize-requirements', title: '整理产品需求', description: '梳理需求要点，输出 PRD 大纲和功能清单。' },
  { id: 'analyze-code', title: '分析代码结构', description: '解读项目结构，生成模块依赖图和优化建议。' },
  { id: 'release-checklist', title: '生成发布清单', description: '基于变更内容，生成发布说明和验证清单。' },
  { id: 'improve-ui-system', title: '优化 UI 设计系统', description: '提出设计系统改进建议，统一组件与视觉语言。' },
]

export function buildWelcomeSurfaceModel(input: {
  workspaceName: string | null
  threads: Array<{ id: string; title: string; updatedAt: number }>
  recentFiles: Array<{ name: string; updatedLabel: string }>
}) {
  return {
    heroTitle: '今天想一起完成什么？',
    heroSubtitle: input.workspaceName ? `在 ${input.workspaceName} 中开始新的工作流` : '开始新的工作流',
    primaryCards: PRIMARY_CARD_SLOTS,
    recentThreads: input.threads.slice(0, 4),
    recentFiles: input.recentFiles.slice(0, 5),
  }
}
```

```tsx
// apps/web/src/components/welcome/LumeWelcomeSurface.tsx
export function LumeWelcomeSurface(props: {
  heroTitle: string
  heroSubtitle: string
  primaryCards: Array<{ id: string; title: string; description: string }>
  recentThreads: Array<{ id: string; title: string; updatedLabel: string }>
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-8 py-10">
      <section className="flex flex-col items-center gap-3 pt-6 text-center">
        <div className="text-brand text-4xl">✳</div>
        <h1 className="text-4xl font-semibold tracking-tight text-[hsl(var(--text-1))]">
          {props.heroTitle}
        </h1>
        <p className="text-sm text-[hsl(var(--text-3))]">{props.heroSubtitle}</p>
      </section>
      <section className="grid grid-cols-4 gap-4">
        {props.primaryCards.map((card) => (
          <article key={card.id} className="rounded-[28px] border border-border bg-card p-6 shadow-panel">
            <h2 className="text-base font-semibold text-brand">{card.title}</h2>
            <p className="mt-3 text-sm leading-6 text-[hsl(var(--text-3))]">{card.description}</p>
          </article>
        ))}
      </section>
      {props.children}
    </div>
  )
}
```

```tsx
// apps/web/src/components/welcome/WelcomeView.tsx
const surface = buildWelcomeSurfaceModel({
  workspaceName: selectedWorkspace?.name ?? null,
  threads: recentThreads.map((thread) => ({
    id: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
  })),
  recentFiles: [],
})

return (
  <div className="flex-1 overflow-y-auto bg-background">
    <LumeWelcomeSurface
      heroTitle={surface.heroTitle}
      heroSubtitle={surface.heroSubtitle}
      primaryCards={surface.primaryCards}
      recentThreads={surface.recentThreads}
    >
      {/* filters, info panels, and composer go here */}
    </LumeWelcomeSurface>
  </div>
)
```

- [ ] **Step 4: Re-run the welcome tests and verify the designed item limits**

Run: `bun test apps/web/src/components/welcome/welcome-surface-view-model.test.ts`  
Expected: PASS with 2 passing tests.

Run: `bun run --filter @lume/web dev`  
Expected: Welcome view renders as hero + two pills + four primary cards + three lower panels, with visibly larger top whitespace than the current implementation.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/welcome/welcome-surface-view-model.ts apps/web/src/components/welcome/welcome-surface-view-model.test.ts apps/web/src/components/welcome/LumeWelcomeSurface.tsx apps/web/src/components/welcome/WelcomeView.tsx apps/web/src/components/welcome/RecentThreads.tsx apps/web/src/components/welcome/WorkspaceSelector.tsx apps/web/src/components/welcome/WelcomeModelPicker.tsx
git commit -m "💄 ui(web): 重构欢迎页舞台布局"
```

## Task 4: Extract and Reuse a Shared Lume Composer

**Files:**
- Create: `apps/web/src/components/composer/lume-composer-state.ts`
- Create: `apps/web/src/components/composer/lume-composer-state.test.ts`
- Create: `apps/web/src/components/composer/LumeComposer.tsx`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`
- Modify: `apps/web/src/components/welcome/WelcomeView.tsx`

- [ ] **Step 1: Write the failing composer state tests**

```ts
import { describe, expect, test } from 'bun:test'
import { deriveComposerState } from './lume-composer-state'

describe('deriveComposerState', () => {
  test('disables send for empty text when not streaming', () => {
    expect(
      deriveComposerState({ text: '', disabled: false })
    ).toEqual({
      canSend: false,
      showStop: false,
      tone: 'idle',
    })
  })

  test('switches to stop mode while streaming', () => {
    expect(
      deriveComposerState({ text: 'ship it', disabled: true })
    ).toEqual({
      canSend: false,
      showStop: true,
      tone: 'streaming',
    })
  })
})
```

- [ ] **Step 2: Run the composer tests and verify they fail**

Run: `bun test apps/web/src/components/composer/lume-composer-state.test.ts`  
Expected: FAIL because `deriveComposerState` does not exist yet.

- [ ] **Step 3: Create the shared composer and wire both input entry points to it**

```ts
// apps/web/src/components/composer/lume-composer-state.ts
export function deriveComposerState(input: { text: string; disabled: boolean }) {
  if (input.disabled) {
    return { canSend: false, showStop: true, tone: 'streaming' as const }
  }

  if (input.text.trim().length === 0) {
    return { canSend: false, showStop: false, tone: 'idle' as const }
  }

  return { canSend: true, showStop: false, tone: 'ready' as const }
}
```

```tsx
// apps/web/src/components/composer/LumeComposer.tsx
export function LumeComposer(props: {
  editor: React.ReactNode
  leadingTools: React.ReactNode
  trailingTools: React.ReactNode
  sendButton: React.ReactNode
  tone: 'idle' | 'ready' | 'streaming'
}) {
  return (
    <div className="rounded-[28px] border border-[hsl(var(--brand)/0.35)] bg-[hsl(var(--surface-1))] px-6 py-5 shadow-[0_0_0_1px_hsl(var(--brand)/0.08),0_0_24px_hsl(var(--brand)/0.12)]">
      <div className="min-h-[92px] text-sm text-[hsl(var(--text-2))]">
        {props.editor}
      </div>
      <div className="mt-5 flex items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">{props.leadingTools}</div>
        <div className="flex items-center gap-2">
          {props.trailingTools}
          {props.sendButton}
        </div>
      </div>
    </div>
  )
}
```

```tsx
// apps/web/src/components/agent/AgentInput.tsx
const composerState = deriveComposerState({
  text: editor?.getText() ?? '',
  disabled: Boolean(disabled),
})

return (
  <div className="px-6 pb-6 pt-3">
    <LumeComposer
      tone={composerState.tone}
      editor={<EditorContent editor={editor} />}
      leadingTools={<>{attachButton}{mentionChips}</>}
      trailingTools={<><ModelPicker threadId={threadId} /><ThinkingLevelPicker value={thinkingLevel} onChange={setThinkingLevel} /></>}
      sendButton={composerState.showStop ? stopButton : sendButton}
    />
  </div>
)
```

- [ ] **Step 4: Re-run the composer tests and check both entry points manually**

Run: `bun test apps/web/src/components/composer/lume-composer-state.test.ts`  
Expected: PASS with 2 passing tests.

Run: `bun run --filter @lume/web dev`  
Expected: Both the welcome page input and the active thread input render the same branded composer shell; welcome still sends the first message by creating a thread, while agent view still uses stop/send behavior correctly.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/composer/lume-composer-state.ts apps/web/src/components/composer/lume-composer-state.test.ts apps/web/src/components/composer/LumeComposer.tsx apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/welcome/WelcomeView.tsx
git commit -m "💄 ui(web): 统一主路径输入区"
```

## Task 5: Lock the Main Path Integration and Run Full Verification

**Files:**
- Create: `apps/web/test/lume-main-path-contract.test.ts`
- Modify: `apps/web/src/components/app-shell/LeftSidebar.tsx`
- Modify: `apps/web/src/components/welcome/WelcomeView.tsx`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

- [ ] **Step 1: Write the failing integration contract test**

```ts
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const webRoot = resolve(import.meta.dir, '..')
const leftSidebar = readFileSync(resolve(webRoot, 'src/components/app-shell/LeftSidebar.tsx'), 'utf-8')
const welcomeView = readFileSync(resolve(webRoot, 'src/components/welcome/WelcomeView.tsx'), 'utf-8')
const agentInput = readFileSync(resolve(webRoot, 'src/components/agent/AgentInput.tsx'), 'utf-8')

describe('lume main path integration contract', () => {
  test('sidebar and welcome view use branded surfaces', () => {
    expect(leftSidebar).toContain('LumeSidebar')
    expect(welcomeView).toContain('LumeWelcomeSurface')
    expect(agentInput).toContain('LumeComposer')
  })

  test('legacy shell classes are removed from the main path', () => {
    expect(leftSidebar).not.toContain('dark:bg-zinc-900/95')
    expect(welcomeView).not.toContain('rounded-2xl border border-border/50 bg-background shadow-md')
    expect(agentInput).not.toContain('rounded-2xl border border-border/60 bg-background shadow-sm')
  })
})
```

- [ ] **Step 2: Run the integration test and verify it fails**

Run: `bun test apps/web/test/lume-main-path-contract.test.ts`  
Expected: FAIL until all three entry points import and render the new branded surfaces.

- [ ] **Step 3: Finish the cleanup and run the full verification set**

```tsx
// apps/web/src/components/welcome/WelcomeView.tsx
return (
  <div className="flex-1 overflow-y-auto bg-background">
    <LumeWelcomeSurface
      heroTitle={surface.heroTitle}
      heroSubtitle={surface.heroSubtitle}
      primaryCards={surface.primaryCards}
      recentThreads={surface.recentThreads}
    >
      <section className="grid grid-cols-[1.15fr_1fr_1fr] gap-4">
        {recentThreadsPanel}
        {workflowPanel}
        {filesPanel}
      </section>
      {composer}
    </LumeWelcomeSurface>
  </div>
)
```

```tsx
// apps/web/src/components/app-shell/LeftSidebar.tsx
return <LumeSidebar {...sidebarProps} />
```

```tsx
// apps/web/src/components/agent/AgentInput.tsx
return (
  <div className="px-6 pb-6 pt-3">
    <LumeComposer {...composerProps} />
  </div>
)
```

- [ ] **Step 4: Run every verification command in order**

Run: `bun test apps/web/test/lume-theme-contract.test.ts`  
Expected: PASS

Run: `bun test apps/web/src/components/app-shell/lume-sidebar-view-model.test.ts`  
Expected: PASS

Run: `bun test apps/web/src/components/welcome/welcome-surface-view-model.test.ts`  
Expected: PASS

Run: `bun test apps/web/src/components/composer/lume-composer-state.test.ts`  
Expected: PASS

Run: `bun test apps/web/test/lume-main-path-contract.test.ts`  
Expected: PASS

Run: `bun run --filter @lume/web typecheck`  
Expected: PASS with no TypeScript errors

Run: `bun run --filter @lume/web build`  
Expected: PASS and emit the Vite production bundle

Run: `bun run --filter @lume/web dev`  
Expected: Manual check passes in both light and dark themes:
- sidebar hierarchy matches the approved “精致还原型” direction
- welcome hero has larger top whitespace
- primary cards render in a stable four-card row
- lower panels keep limits and truncation
- composer looks consistent in welcome and thread contexts

- [ ] **Step 5: Commit**

```bash
git add apps/web/test/lume-main-path-contract.test.ts apps/web/src/components/app-shell/LeftSidebar.tsx apps/web/src/components/welcome/WelcomeView.tsx apps/web/src/components/agent/AgentInput.tsx
git commit -m "✅ test(web): 锁定主路径 UI 契约"
```

## Self-Review

### Spec coverage

- Sidebar redesign: covered by Task 2 and Task 5.
- Welcome hero, pills, four-card row, three lower panels: covered by Task 3 and Task 5.
- Shared branded composer for welcome and thread input: covered by Task 4 and Task 5.
- Dual-theme token strategy: covered by Task 1.
- Real-data mapping and display-layer trimming: covered by Task 2 and Task 3 through the new view-model helpers.

### Placeholder scan

- No placeholder markers or deferred implementation notes remain.
- Every task lists exact files and exact commands.
- Every code step contains concrete test or implementation code.

### Type consistency

- `buildSidebarSections`, `buildWelcomeSurfaceModel`, and `deriveComposerState` are defined before later tasks depend on them.
- Branded component names stay consistent across the plan: `LumeSidebar`, `LumeWelcomeSurface`, `LumeComposer`.

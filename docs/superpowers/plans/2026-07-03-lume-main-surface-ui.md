# Lume Main Surface UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Lume's main interface feel by unifying semantic UI tokens, dark-mode surface hierarchy, high-frequency component states, and lightweight transitions.

**Architecture:** Keep the current React component structure and move visual decisions into Lume semantic CSS tokens. Migrate the main path in layers: token foundation, application frame, navigation/tab surfaces, composer, messages, and a final cleanup pass. No business state, routing, IPC, or Agent behavior changes are part of this plan.

**Tech Stack:** React 18, Tailwind CSS v4 arbitrary values, CSS custom properties in `apps/web/src/index.css`, Bun test runner.

---

## Cleanup Plan

This is a UI cleanup and deslop task, so apply this cleanup plan before editing implementation files:

1. Replace main-path hardcoded colors with semantic Lume tokens.
2. Keep legacy aliases (`--brand`, `--surface-1`, `--text-1`, `--border-strong`) during migration so existing components do not break mid-plan.
3. Delete visual noise introduced by previous styling: large gradients, `hover:translate-y-*`, `dark:bg-zinc-*`, isolated hex colors, and repeated foreground opacity styles in the main path.
4. Do not touch route structure, atoms, IPC calls, Agent runtime behavior, queue behavior, or clipboard behavior.
5. Leave out-of-scope pages alone: skills market, settings, old file preview tabs, browser tabs, and tool-result renderers not visible as the primary message chrome.
6. If a target file is already dirty, inspect its existing diff first and preserve unrelated user changes. Stage only intentional hunks for each task.

## File Structure

- Modify `apps/web/src/index.css`: own Lume semantic tokens, backward-compatible aliases, markdown color cleanup, motion preference utilities.
- Modify `apps/web/test/lume-theme-contract.test.ts`: lock the new Lume token contract and the absence of legacy zinc classes in main shell files.
- Modify `apps/web/src/components/app-shell/AppShell.tsx`: apply app-level background and frame spacing.
- Modify `apps/web/src/components/app-shell/TitleBar.tsx`: make titlebar use rail surface and tokenized title/search states.
- Modify `apps/web/src/components/app-shell/WindowButtons.tsx`: tokenized window button hover/active/danger states.
- Modify `apps/web/src/components/right-panel/RightPanelWindowControls.tsx`: keep titlebar-adjacent right-panel controls aligned with window buttons.
- Modify `apps/web/src/components/app-shell/LumeSidebar.tsx`: tokenized rail surface, selected states, compact rail buttons, and quieter primary action.
- Modify `apps/web/src/components/app-shell/WorkspaceGroupItem.tsx`: workspace row focus/hover/selected states.
- Modify `apps/web/src/components/app-shell/ThreadItem.tsx`: status colors and active row styling.
- Modify `apps/web/src/components/app-shell/ThreadItemActions.tsx`: align row action hover and destructive states with tokens.
- Modify `apps/web/src/components/tabs/MainArea.tsx`: main content surface.
- Modify `apps/web/src/components/tabs/TabBar.tsx`: tokenized tab active/inactive states, remove `bg-white` and `dark:bg-zinc-*`.
- Modify `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`: right panel shell, divider, resize handle, and compact state.
- Modify `apps/web/src/components/right-panel/RightPanelTabBar.tsx`: tokenized right-panel tabs and menu.
- Modify `apps/web/src/components/right-panel/RightPanelLauncher.tsx`: tokenized empty right-panel launcher.
- Modify `apps/web/src/components/composer/LumeComposer.tsx`: composer surface, focus-ready tone, action button, shadow, and reduced-motion behavior.
- Modify `apps/web/src/components/agent/composer-control-styles.ts`: shared composer control trigger/menu tokens.
- Modify `apps/web/src/components/agent/AgentInput.tsx`: composer outer spacing, attach/plugin popover styling, stop/send button states.
- Modify `apps/web/src/components/agent/ModelPicker.tsx`: model menu search and unavailable badge tokens.
- Modify `apps/web/src/components/agent/PermissionModePicker.tsx`: tokenized selected option.
- Modify `apps/web/src/components/agent/ThinkingLevelPicker.tsx`: tokenized selected option.
- Modify `apps/web/src/components/agent/AgentHeader.tsx`: quieter status pill and tokenized status colors.
- Modify `apps/web/src/components/agent/AgentMessages.tsx`: message viewport surface and scroll-to-bottom button.
- Modify `apps/web/src/components/agent/AgentAttachmentGrid.tsx`: tokenized attachment cards.
- Modify `apps/web/src/components/agent/TodoPanel.tsx`: tokenized floating task panel.
- Modify `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`: tokenized main message chrome, plan preview, tool-call shell, inline action menus, and file links.

---

### Task 1: Token Foundation And Contract

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/test/lume-theme-contract.test.ts`

- [ ] **Step 1: Check target file state**

Run:

```bash
git status --short -- apps/web/src/index.css apps/web/test/lume-theme-contract.test.ts
```

Expected: either no output or only known local changes that belong to this UI task. If either file is dirty from another task, inspect it before editing:

```bash
git diff -- apps/web/src/index.css apps/web/test/lume-theme-contract.test.ts
```

- [ ] **Step 2: Update the token contract test first**

In `apps/web/test/lume-theme-contract.test.ts`, replace the first test body with checks for the new semantic token names and compatibility aliases. Keep helper functions unchanged.

Use this token list inside the test:

```ts
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
  '--brand: var(--lume-accent);',
  '--surface-1: var(--lume-bg-panel);',
  '--text-1: var(--lume-text-primary);',
  '--border-strong: var(--lume-border-strong);',
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
  '--brand: var(--lume-accent);',
  '--surface-1: var(--lume-bg-panel);',
  '--text-1: var(--lume-text-primary);',
  '--border-strong: var(--lume-border-strong);',
]
```

Also change the block selectors in the test to:

```ts
const rootBlock = extractCssBlockWithToken(indexCss, ':root', '--lume-bg-app: oklch(0.982 0.006 248);')
const darkBlock = extractCssBlockWithToken(indexCss, '.dark', '--lume-bg-app: oklch(0.155 0.012 248);')
```

- [ ] **Step 3: Run the focused test and confirm it fails**

Run:

```bash
bun test apps/web/test/lume-theme-contract.test.ts
```

Expected: FAIL because `apps/web/src/index.css` does not yet define the new `--lume-*` token contract.

- [ ] **Step 4: Update `apps/web/src/index.css` semantic tokens**

In both `:root` and `.dark`, keep the existing shadcn variables, but replace the current Lume-specific block (`--brand`, `--surface-*`, `--text-*`, `--border-strong`, `--shadow-panel`, scrollbar tokens) with this structure. Preserve chart/sidebar variables after these values.

For `:root`, use:

```css
  --lume-bg-app: oklch(0.982 0.006 248);
  --lume-bg-rail: oklch(0.962 0.007 248);
  --lume-bg-panel: oklch(0.996 0.003 248);
  --lume-bg-elevated: oklch(1 0 0);
  --lume-border-subtle: oklch(0.89 0.012 248);
  --lume-border-strong: oklch(0.79 0.018 248);
  --lume-text-primary: oklch(0.18 0.012 248);
  --lume-text-secondary: oklch(0.42 0.014 248);
  --lume-text-muted: oklch(0.58 0.012 248);
  --lume-accent: oklch(0.57 0.13 202);
  --lume-accent-2: oklch(0.62 0.12 178);
  --lume-accent-soft: oklch(0.93 0.03 202);
  --lume-accent-foreground: oklch(0.99 0.004 202);
  --lume-focus-ring: oklch(0.66 0.13 202 / 42%);
  --lume-danger: oklch(0.62 0.18 25);
  --lume-success: oklch(0.62 0.13 155);
  --lume-warning: oklch(0.72 0.14 75);
  --background: var(--lume-bg-app);
  --foreground: var(--lume-text-primary);
  --brand: var(--lume-accent);
  --brand-2: var(--lume-accent-2);
  --brand-foreground: var(--lume-accent-foreground);
  --border: var(--lume-border-subtle);
  --border-strong: var(--lume-border-strong);
  --ring: var(--lume-focus-ring);
  --surface-1: var(--lume-bg-panel);
  --surface-2: var(--lume-bg-elevated);
  --surface-3: color-mix(in oklab, var(--lume-bg-elevated) 82%, var(--lume-accent-soft));
  --text-1: var(--lume-text-primary);
  --text-2: var(--lume-text-secondary);
  --text-3: var(--lume-text-muted);
  --shadow-panel: 220 42% 8%;
  --sidebar: var(--lume-bg-rail);
  --sidebar-foreground: var(--lume-text-primary);
  --sidebar-border: var(--lume-border-subtle);
  --sidebar-accent: var(--lume-accent-soft);
  --sidebar-accent-foreground: var(--lume-text-primary);
```

For `.dark`, use:

```css
  --lume-bg-app: oklch(0.155 0.012 248);
  --lume-bg-rail: oklch(0.18 0.013 248);
  --lume-bg-panel: oklch(0.205 0.012 248);
  --lume-bg-elevated: oklch(0.245 0.014 248);
  --lume-border-subtle: oklch(0.33 0.012 248 / 62%);
  --lume-border-strong: oklch(0.4 0.018 248);
  --lume-text-primary: oklch(0.94 0.006 248);
  --lume-text-secondary: oklch(0.78 0.01 248);
  --lume-text-muted: oklch(0.62 0.012 248);
  --lume-accent: oklch(0.72 0.12 202);
  --lume-accent-2: oklch(0.78 0.11 178);
  --lume-accent-soft: oklch(0.35 0.05 202 / 42%);
  --lume-accent-foreground: oklch(0.12 0.018 202);
  --lume-focus-ring: oklch(0.74 0.13 202 / 42%);
  --lume-danger: oklch(0.68 0.16 25);
  --lume-success: oklch(0.72 0.12 155);
  --lume-warning: oklch(0.78 0.13 75);
  --background: var(--lume-bg-app);
  --foreground: var(--lume-text-primary);
  --brand: var(--lume-accent);
  --brand-2: var(--lume-accent-2);
  --brand-foreground: var(--lume-accent-foreground);
  --border: var(--lume-border-subtle);
  --border-strong: var(--lume-border-strong);
  --ring: var(--lume-focus-ring);
  --surface-1: var(--lume-bg-panel);
  --surface-2: var(--lume-bg-elevated);
  --surface-3: color-mix(in oklab, var(--lume-bg-elevated) 82%, var(--lume-accent-soft));
  --text-1: var(--lume-text-primary);
  --text-2: var(--lume-text-secondary);
  --text-3: var(--lume-text-muted);
  --shadow-panel: 220 52% 3%;
  --sidebar: var(--lume-bg-rail);
  --sidebar-foreground: var(--lume-text-primary);
  --sidebar-border: var(--lume-border-subtle);
  --sidebar-accent: var(--lume-accent-soft);
  --sidebar-accent-foreground: var(--lume-text-primary);
```

- [ ] **Step 5: Tokenize markdown base colors**

In `apps/web/src/index.css`, replace the hardcoded `.agent-message-markdown` colors:

```css
.agent-message-markdown {
  color: var(--lume-text-primary);
  font-weight: 450;
  overflow-wrap: anywhere;
}

.agent-message-markdown strong {
  color: var(--lume-text-primary);
  font-weight: 700;
}

.agent-message-markdown h1,
.agent-message-markdown h2,
.agent-message-markdown h3,
.agent-message-markdown h4 {
  margin: 22px 0 10px;
  color: var(--lume-text-primary);
  font-weight: 700;
  line-height: 1.45;
}
```

Replace `.lume-shimmer-text` background with:

```css
  background: linear-gradient(90deg, var(--lume-text-muted) 0%, var(--lume-text-secondary) 45%, var(--lume-text-muted) 90%);
```

- [ ] **Step 6: Run the focused test and commit**

Run:

```bash
bun test apps/web/test/lume-theme-contract.test.ts
```

Expected: PASS.

Commit only these files:

```bash
git add -- apps/web/src/index.css apps/web/test/lume-theme-contract.test.ts
git diff --cached --name-only
git commit -m "💄 ui(web): 收敛主界面语义 token" -m "建立 Lume 自有 surface、text、accent、state token，并保留旧 token alias 以便主路径逐步迁移。" -m "Constraint: 不改业务行为" -m "Tested: bun test apps/web/test/lume-theme-contract.test.ts"
```

Expected staged file list:

```text
apps/web/src/index.css
apps/web/test/lume-theme-contract.test.ts
```

---

### Task 2: Application Frame And Title Controls

**Files:**
- Modify: `apps/web/src/components/app-shell/AppShell.tsx`
- Modify: `apps/web/src/components/tabs/MainArea.tsx`
- Modify: `apps/web/src/components/app-shell/TitleBar.tsx`
- Modify: `apps/web/src/components/app-shell/WindowButtons.tsx`
- Modify: `apps/web/src/components/right-panel/RightPanelWindowControls.tsx`
- Modify: `apps/web/test/lume-theme-contract.test.ts`

- [ ] **Step 1: Update AppShell surface classes**

In `AppShell.tsx`, replace the outer shell classes with:

```tsx
<div className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--lume-bg-app)] text-[var(--lume-text-primary)]">
```

Replace the content row with:

```tsx
<div className="flex-1 flex min-h-0 gap-1.5 p-2 pt-0">
```

Replace the main wrapper with:

```tsx
<div className="flex-1 min-w-0 overflow-hidden rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)]">
```

- [ ] **Step 2: Update MainArea surfaces**

In `MainArea.tsx`, use these two wrappers:

```tsx
<div className="h-full flex flex-col overflow-hidden bg-[var(--lume-bg-panel)]">
  <TabBar />
  <div className="flex-1 min-h-0 flex bg-[var(--lume-bg-panel)]">
    <TabContent />
  </div>
</div>
```

- [ ] **Step 3: Update titlebar classes**

In `TitleBar.tsx`, replace the titlebar class base with:

```tsx
'flex h-10 items-center gap-2 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-rail)] pr-2 text-[var(--lume-text-primary)] select-none'
```

Replace the sidebar-toggle button class with:

```tsx
"flex size-8 items-center justify-center rounded-[8px] text-[var(--lume-text-muted)] transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)] active:bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_78%,black)]"
```

Change the logo icon class:

```tsx
<Sparkles size={16} className="text-[var(--lume-accent)]" />
```

Replace the command button class with:

```tsx
"flex h-8 w-full max-w-[420px] items-center gap-2 rounded-[8px] border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_62%,transparent)] px-3 text-sm text-[var(--lume-text-muted)] transition-colors duration-150 ease-out hover:border-[var(--lume-border-strong)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-secondary)]"
```

- [ ] **Step 4: Update window control button states**

In `WindowButtons.tsx`, replace `buttonClass` with:

```tsx
const buttonClass = cn(
  'flex size-8 items-center justify-center rounded-[8px] text-[var(--lume-text-muted)] transition-colors duration-150 ease-out',
  focused
    ? 'hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)] active:bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_82%,black)]'
    : 'text-[color:color-mix(in_oklab,var(--lume-text-muted)_56%,transparent)]',
)
```

Replace the close button extra class:

```tsx
className={cn(buttonClass, 'hover:bg-[color:color-mix(in_oklab,var(--lume-danger)_20%,var(--lume-bg-elevated))] hover:text-[var(--lume-text-primary)]')}
```

- [ ] **Step 5: Update right-panel window controls**

In `RightPanelWindowControls.tsx`, use the same state language:

```tsx
'flex size-8 items-center justify-center rounded-[8px] text-[var(--lume-text-muted)] transition-colors duration-150 ease-out'
```

For enabled hover:

```tsx
'hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'
```

For the larger panel open button:

```tsx
layout.open
  ? 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)] hover:bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_86%,var(--lume-accent-soft))]'
  : 'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'
```

- [ ] **Step 6: Update shell contract test**

In `apps/web/test/lume-theme-contract.test.ts`, change the AppShell required classes to:

```ts
const requiredClasses = [
  'h-screen',
  'w-screen',
  'flex',
  'overflow-hidden',
  'bg-[var(--lume-bg-app)]',
  'text-[var(--lume-text-primary)]',
]
```

Change the MainArea wrapper classes:

```ts
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
```

- [ ] **Step 7: Run focused test and commit**

Run:

```bash
bun test apps/web/test/lume-theme-contract.test.ts
```

Expected: PASS.

Commit:

```bash
git add -- apps/web/src/components/app-shell/AppShell.tsx apps/web/src/components/tabs/MainArea.tsx apps/web/src/components/app-shell/TitleBar.tsx apps/web/src/components/app-shell/WindowButtons.tsx apps/web/src/components/right-panel/RightPanelWindowControls.tsx apps/web/test/lume-theme-contract.test.ts
git diff --cached --name-only
git commit -m "💄 ui(web): 统一应用框架 surface" -m "让标题栏、应用底色、主工作区和窗口控件使用同一套 Lume surface 与状态 token。" -m "Constraint: 保持布局结构和窗口行为不变" -m "Tested: bun test apps/web/test/lume-theme-contract.test.ts"
```

---

### Task 3: Sidebar And Thread State Language

**Files:**
- Modify: `apps/web/src/components/app-shell/LumeSidebar.tsx`
- Modify: `apps/web/src/components/app-shell/WorkspaceGroupItem.tsx`
- Modify: `apps/web/src/components/app-shell/ThreadItem.tsx`
- Modify: `apps/web/src/components/app-shell/ThreadItemActions.tsx`
- Modify: `apps/web/test/lume-theme-contract.test.ts`

- [ ] **Step 1: Replace LumeSidebar rail backgrounds**

In `LumeSidebar.tsx`, remove both inline gradient `style` props from the collapsed and expanded `<aside>` elements.

Use this collapsed aside class:

```tsx
className="flex h-full w-[72px] -ml-2 flex-col border-r border-sidebar-border bg-[var(--lume-bg-rail)] text-[var(--lume-text-primary)]"
```

Use this expanded aside class:

```tsx
className="flex h-full w-[286px] min-w-[286px] -ml-2 flex-col border-r border-sidebar-border bg-[var(--lume-bg-rail)] text-[var(--lume-text-primary)]"
```

- [ ] **Step 2: Remove large primary gradients and lift effects**

For the collapsed `new-chat` button, replace the active primary classes with:

```tsx
'border-transparent bg-[var(--lume-accent)] text-[var(--lume-accent-foreground)] shadow-[0_12px_30px_-24px_hsl(var(--lume-shadow-panel)/0.72)]'
```

For the expanded `new-chat` button, replace the full class with:

```tsx
className="flex h-10 w-full items-center gap-3 rounded-xl bg-[var(--lume-accent)] px-4 text-left text-[13px] font-medium text-[var(--lume-accent-foreground)] shadow-[0_12px_30px_-24px_hsl(var(--lume-shadow-panel)/0.72)] transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_88%,var(--lume-accent-2))]"
```

This deletes `bg-gradient-to-*` and `hover:translate-y-[-1px]`.

- [ ] **Step 3: Normalize sidebar row state classes**

For non-primary sidebar buttons in `LumeSidebar.tsx`, use the pattern:

```tsx
'text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'
```

For selected rows, use:

```tsx
'bg-[var(--lume-accent-soft)] text-[var(--lume-text-primary)]'
```

For separators and footer top border, use:

```tsx
"bg-[var(--lume-border-subtle)]"
```

and:

```tsx
"border-t border-[var(--lume-border-subtle)]"
```

- [ ] **Step 4: Normalize workspace group rows**

In `WorkspaceGroupItem.tsx`, replace workspace row hover/active classes with this pattern:

```tsx
'relative flex-1 min-w-0 flex items-center gap-1 px-1 py-1 rounded-md text-left transition-colors duration-150 ease-out group-hover/workspace:pr-11 hover:bg-[var(--lume-bg-elevated)]'
```

For current workspace text:

```tsx
isCurrent ? 'text-[var(--lume-text-primary)]' : 'text-[var(--lume-text-secondary)] hover:text-[var(--lume-text-primary)]'
```

For synthetic rows:

```tsx
syntheticRow.active
  ? 'bg-[var(--lume-accent-soft)]'
  : 'hover:bg-[var(--lume-bg-elevated)]'
```

- [ ] **Step 5: Replace thread status color classes**

In `ThreadItem.tsx`, replace `TREE_ACCENT_CLASS` and `STATUS_ICON_CLASS` with:

```ts
const TREE_ACCENT_CLASS: Record<ThreadStatus, string> = {
  blocked: 'bg-[var(--lume-warning)]',
  running: 'bg-[var(--lume-accent)] animate-pulse',
  completed: 'bg-[var(--lume-success)]',
  idle: '',
}

const STATUS_ICON_CLASS: Record<ThreadStatus, string> = {
  blocked: 'text-[var(--lume-warning)]',
  running: 'text-[var(--lume-accent)]',
  completed: 'text-[var(--lume-success)]',
  idle: 'text-[var(--lume-text-muted)]',
}
```

Replace the main thread row active/hover classes:

```tsx
thread.active && 'bg-[var(--lume-accent-soft)]',
!thread.active && 'hover:bg-[var(--lume-bg-elevated)]',
```

Replace child branch borders:

```tsx
className={cn(indent && 'border-l border-l-[var(--lume-border-subtle)] ml-3')}
```

- [ ] **Step 6: Tokenize thread row actions**

In `ThreadItemActions.tsx`, replace any destructive class containing `text-red-500` or `bg-red-500/10` with:

```tsx
'text-[var(--lume-danger)] bg-[color:color-mix(in_oklab,var(--lume-danger)_10%,transparent)]'
```

Replace neutral action hover classes with:

```tsx
'hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'
```

- [ ] **Step 7: Update contract test and verify**

In `apps/web/test/lume-theme-contract.test.ts`, keep the existing sidebar border token test, and add these expectations:

```ts
expect(lumeSidebar).toContain('bg-[var(--lume-bg-rail)]')
expect(lumeSidebar).not.toContain('bg-gradient-to-r')
expect(lumeSidebar).not.toContain('hover:translate-y-[-1px]')
```

Run:

```bash
bun test apps/web/test/lume-theme-contract.test.ts
```

Expected: PASS.

Commit:

```bash
git add -- apps/web/src/components/app-shell/LumeSidebar.tsx apps/web/src/components/app-shell/WorkspaceGroupItem.tsx apps/web/src/components/app-shell/ThreadItem.tsx apps/web/src/components/app-shell/ThreadItemActions.tsx apps/web/test/lume-theme-contract.test.ts
git diff --cached --name-only
git commit -m "💄 ui(web): 统一侧栏交互状态" -m "将侧栏、工作区和线程状态迁移到 Lume token，删除主操作的大渐变和位移动效。" -m "Constraint: 不改变线程选择、展开、重命名和归档行为" -m "Tested: bun test apps/web/test/lume-theme-contract.test.ts"
```

---

### Task 4: Tabs And Right Panel Surfaces

**Files:**
- Modify: `apps/web/src/components/tabs/TabBar.tsx`
- Modify: `apps/web/src/components/right-panel/RightPanelWorkspace.tsx`
- Modify: `apps/web/src/components/right-panel/RightPanelTabBar.tsx`
- Modify: `apps/web/src/components/right-panel/RightPanelLauncher.tsx`
- Modify: `apps/web/test/lume-theme-contract.test.ts`

- [ ] **Step 1: Tokenize TabBar**

In `TabBar.tsx`, replace the tab button class branch with:

```tsx
className={cn(
  'flex items-center gap-1.5 rounded-t-lg border border-transparent px-3 py-1.5 text-[13px] whitespace-nowrap transition-[background-color,border-color,color] duration-150 ease-out',
  activeTabId === tab.id
    ? 'border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)] shadow-[0_10px_28px_-24px_hsl(var(--lume-shadow-panel)/0.5)]'
    : 'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-secondary)]'
)}
```

Replace the close icon span class with:

```tsx
className="size-4 flex items-center justify-center rounded text-[var(--lume-text-muted)] transition-colors hover:bg-[var(--lume-accent-soft)] hover:text-[var(--lume-text-primary)]"
```

- [ ] **Step 2: Update right-panel workspace shell**

In `RightPanelWorkspace.tsx`, replace the outer aside class with:

```tsx
className={cn(
  'relative z-[60] flex h-full shrink-0 flex-col border-l border-[var(--lume-border-subtle)] bg-[var(--lume-bg-app)] pb-2 pr-2 transition-[width] duration-200 ease-out',
  resizing && 'transition-none',
)}
```

Replace the resize handle class with:

```tsx
className="absolute left-0 top-0 z-20 h-full w-2 -translate-x-1 cursor-col-resize touch-none transition-colors duration-150 ease-out hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_14%,transparent)]"
```

Replace the inner panel class with:

```tsx
className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)]"
```

Replace compact empty state text class with:

```tsx
className="flex min-h-0 flex-1 items-center justify-center text-[var(--lume-text-muted)]"
```

- [ ] **Step 3: Tokenize right-panel tab bar**

In `RightPanelTabBar.tsx`, replace the root class with:

```tsx
className="relative flex h-11 shrink-0 items-center gap-1 border-b border-[var(--lume-border-subtle)] px-3"
```

Replace active/inactive tab classes:

```tsx
active
  ? 'bg-[var(--lume-bg-elevated)] text-[var(--lume-text-primary)]'
  : 'text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-secondary)]'
```

Replace menu class:

```tsx
className="absolute left-0 top-10 z-20 min-w-[240px] rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-2 shadow-[0_18px_55px_-32px_hsl(var(--lume-shadow-panel)/0.62)] backdrop-blur"
```

Replace menu item hover:

```tsx
className="flex h-9 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px] font-medium text-[var(--lume-text-primary)] transition-colors hover:bg-[var(--lume-accent-soft)]"
```

- [ ] **Step 4: Tokenize right-panel launcher**

In `RightPanelLauncher.tsx`, replace launcher item classes with:

```tsx
className="flex h-11 w-full items-center gap-3 rounded-[8px] border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_68%,transparent)] px-3 text-left text-[15px] font-medium text-[var(--lume-text-primary)] transition-colors duration-150 ease-out hover:border-[var(--lume-border-strong)] hover:bg-[var(--lume-bg-elevated)]"
```

Replace shortcut pill:

```tsx
className="rounded-full bg-[var(--lume-accent-soft)] px-2 py-0.5 text-[12px] font-medium text-[var(--lume-text-secondary)]"
```

- [ ] **Step 5: Extend TabBar contract test**

In `apps/web/test/lume-theme-contract.test.ts`, add:

```ts
test('TabBar uses Lume surface tokens without legacy zinc tabs', () => {
  const tabBar = readWebFile('src', 'components', 'tabs', 'TabBar.tsx')
  expect(tabBar).toContain('bg-[var(--lume-bg-elevated)]')
  expect(tabBar).not.toContain('bg-white')
  expect(tabBar).not.toContain('dark:bg-zinc')
})
```

Run:

```bash
bun test apps/web/test/lume-theme-contract.test.ts
```

Expected: PASS.

Commit:

```bash
git add -- apps/web/src/components/tabs/TabBar.tsx apps/web/src/components/right-panel/RightPanelWorkspace.tsx apps/web/src/components/right-panel/RightPanelTabBar.tsx apps/web/src/components/right-panel/RightPanelLauncher.tsx apps/web/test/lume-theme-contract.test.ts
git diff --cached --name-only
git commit -m "💄 ui(web): 优化标签和右侧面板层级" -m "让 TabBar 与右侧面板共享 Lume surface、border 和 selected 状态。" -m "Constraint: 不改变右侧面板 tab 状态模型" -m "Tested: bun test apps/web/test/lume-theme-contract.test.ts"
```

---

### Task 5: Composer Surface And Controls

**Files:**
- Modify: `apps/web/src/components/composer/LumeComposer.tsx`
- Modify: `apps/web/src/components/agent/composer-control-styles.ts`
- Modify: `apps/web/src/components/agent/AgentInput.tsx`
- Modify: `apps/web/src/components/agent/ModelPicker.tsx`
- Modify: `apps/web/src/components/agent/PermissionModePicker.tsx`
- Modify: `apps/web/src/components/agent/ThinkingLevelPicker.tsx`
- Test: `apps/web/src/components/composer/LumeComposer.contract.test.tsx`

- [ ] **Step 1: Update LumeComposer tone palette**

In `LumeComposer.tsx`, replace all `toneStyles` entries with tokenized values:

```ts
const baseShell = {
  borderColor: 'var(--lume-border-subtle)',
  background: 'linear-gradient(180deg, color-mix(in oklab, var(--lume-bg-elevated) 96%, transparent), color-mix(in oklab, var(--lume-bg-panel) 90%, var(--lume-bg-elevated)))',
  boxShadow: '0 22px 52px -38px hsl(var(--lume-shadow-panel) / 0.58)',
}

const toneStyles: Record<LumeComposerTone, {
  shell: {
    borderColor: string
    background: string
    boxShadow: string
  }
  glow: {
    background: string
    opacity: number
  }
  dividerColor: string
}> = {
  idle: {
    shell: baseShell,
    glow: {
      background: 'radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--lume-accent) 10%, transparent) 0%, transparent 58%)',
      opacity: 0.5,
    },
    dividerColor: 'var(--lume-border-subtle)',
  },
  ready: {
    shell: {
      ...baseShell,
      borderColor: 'color-mix(in oklab, var(--lume-accent) 32%, var(--lume-border-strong))',
    },
    glow: {
      background: 'radial-gradient(circle at 50% 0%, color-mix(in oklab, var(--lume-accent) 14%, transparent) 0%, transparent 56%)',
      opacity: 0.62,
    },
    dividerColor: 'var(--lume-border-subtle)',
  },
  streaming: {
    shell: {
      ...baseShell,
      borderColor: 'color-mix(in oklab, var(--lume-accent) 24%, var(--lume-border-strong))',
    },
    glow: {
      background: 'transparent',
      opacity: 0,
    },
    dividerColor: 'var(--lume-border-subtle)',
  },
}
```

- [ ] **Step 2: Update composer transition classes**

In `LumeComposer.tsx`, replace the root class base with:

```tsx
'relative overflow-visible border backdrop-blur transition-[border-color,box-shadow,transform,background-color] duration-200 ease-out motion-reduce:transition-none'
```

Replace primary action classes in `getLumeComposerPrimaryActionClassName`:

```tsx
'inline-flex items-center gap-2 rounded-full font-medium transition-colors duration-150 ease-out'
```

Enabled state:

```tsx
'bg-[var(--lume-accent)] text-[var(--lume-accent-foreground)] shadow-[0_16px_32px_-24px_hsl(var(--lume-shadow-panel)/0.72)] hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_88%,var(--lume-accent-2))]'
```

Disabled state:

```tsx
'cursor-not-allowed bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_70%,transparent)] text-[var(--lume-text-muted)]'
```

- [ ] **Step 3: Tokenize shared composer controls**

In `composer-control-styles.ts`, replace exports with:

```ts
export const composerControlTriggerClassName =
  'inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'

export const composerControlChevronClassName = 'text-[var(--lume-text-muted)]'

export const composerControlMenuClassName =
  'absolute bottom-full left-0 z-50 mb-2 rounded-xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] shadow-[0_18px_42px_-28px_hsl(var(--lume-shadow-panel)/0.62)] backdrop-blur'
```

- [ ] **Step 4: Update AgentInput composer shell spacing and popovers**

In `AgentInput.tsx`, replace the outer wrapper classes:

```tsx
<div className="px-3 pb-4 pt-2">
  <div className="w-full px-14">
```

with:

```tsx
<div className="px-3 pb-4 pt-2">
  <div className="mx-auto w-full max-w-[980px] px-4">
```

For the attach button, use:

```tsx
className="inline-flex size-8 items-center justify-center rounded-lg border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_72%,transparent)] text-[var(--lume-text-secondary)] transition-colors duration-150 ease-out hover:border-[var(--lume-border-strong)] hover:text-[var(--lume-text-primary)]"
```

For the attach/plugin popover containers, use:

```tsx
className="absolute bottom-full left-0 z-50 mb-2 w-[140px] overflow-hidden rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] shadow-[0_18px_42px_-28px_hsl(var(--lume-shadow-panel)/0.62)]"
```

and:

```tsx
className="absolute bottom-full left-0 z-50 mb-2 w-[260px] overflow-hidden rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] shadow-[0_18px_42px_-28px_hsl(var(--lume-shadow-panel)/0.62)]"
```

For menu item hover:

```tsx
className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] text-[var(--lume-text-primary)] transition-colors hover:bg-[var(--lume-accent-soft)]"
```

For the stop button, replace brand-2 classes with:

```tsx
className="inline-flex h-8 items-center gap-2 rounded-full border border-[color:color-mix(in_oklab,var(--lume-danger)_28%,var(--lume-border-subtle))] bg-[color:color-mix(in_oklab,var(--lume-danger)_10%,var(--lume-bg-elevated))] px-3 text-[11.5px] font-medium text-[var(--lume-text-primary)] transition-colors hover:border-[color:color-mix(in_oklab,var(--lume-danger)_40%,var(--lume-border-strong))]"
```

- [ ] **Step 5: Tokenize picker selected states**

In `ModelPicker.tsx`, replace unavailable badge classes with:

```tsx
className="inline-flex h-6 items-center rounded-full border border-[color:color-mix(in_oklab,var(--lume-warning)_28%,transparent)] bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,transparent)] px-2 text-[10.5px] font-medium text-[var(--lume-warning)]"
```

In `PermissionModePicker.tsx`, replace selected option classes:

```tsx
selected
  ? 'border-[color:color-mix(in_oklab,var(--lume-accent)_34%,var(--lume-border-strong))] bg-[var(--lume-accent-soft)]'
  : 'border-transparent hover:bg-[var(--lume-bg-elevated)]'
```

In `ThinkingLevelPicker.tsx`, replace the inline selected branch:

```tsx
selected
  ? 'border border-[color-mix(in_oklab,var(--lume-accent)_40%,var(--lume-border-strong))] bg-[var(--lume-accent-soft)] text-[var(--lume-accent)]'
  : 'border border-transparent text-[var(--lume-text-secondary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]'
```

Replace `ThinkingLevelCard` selected branch:

```tsx
selected
  ? 'border-[color:color-mix(in_oklab,var(--lume-accent)_34%,var(--lume-border-strong))] bg-[var(--lume-accent-soft)]'
  : 'border-transparent hover:bg-[var(--lume-bg-elevated)]'
```

- [ ] **Step 6: Run composer contract test and commit**

Run:

```bash
bun test apps/web/src/components/composer/LumeComposer.contract.test.tsx
```

Expected: PASS.

Commit:

```bash
git add -- apps/web/src/components/composer/LumeComposer.tsx apps/web/src/components/agent/composer-control-styles.ts apps/web/src/components/agent/AgentInput.tsx apps/web/src/components/agent/ModelPicker.tsx apps/web/src/components/agent/PermissionModePicker.tsx apps/web/src/components/agent/ThinkingLevelPicker.tsx
git diff --cached --name-only
git commit -m "💄 ui(web): 打磨 composer 输入体感" -m "统一 composer surface、focus-ready tone、工具菜单和发送按钮状态，使输入区成为稳定视觉锚点。" -m "Constraint: 不改变发送、停止、队列、附件和 picker 行为" -m "Tested: bun test apps/web/src/components/composer/LumeComposer.contract.test.tsx"
```

---

### Task 6: Messages, Attachments, And Runtime Chrome

**Files:**
- Modify: `apps/web/src/components/agent/AgentHeader.tsx`
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`
- Modify: `apps/web/src/components/agent/AgentAttachmentGrid.tsx`
- Modify: `apps/web/src/components/agent/TodoPanel.tsx`
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`
- Test: `apps/web/src/components/agent/AgentMessages.test.ts`
- Test: existing `RuntimeEventContentBlock.*.test.tsx` files only if rendered output behavior changes unexpectedly.

- [ ] **Step 1: Tokenize AgentHeader status**

In `AgentHeader.tsx`, replace `PHASE_STYLE` with:

```ts
const PHASE_STYLE: Record<AgentRuntimePhase, { label: string; dot: string; text: string }> = {
  idle: { label: '空闲', dot: 'bg-[var(--lume-text-muted)]', text: 'text-[var(--lume-text-muted)]' },
  streaming: { label: '运行中', dot: 'bg-[var(--lume-accent)] animate-pulse', text: 'text-[var(--lume-accent)]' },
  awaiting_permission: { label: '等待授权', dot: 'bg-[var(--lume-warning)]', text: 'text-[var(--lume-warning)]' },
  awaiting_user_answer: { label: '等待回答', dot: 'bg-[var(--lume-warning)]', text: 'text-[var(--lume-warning)]' },
  compacting: { label: '压缩中', dot: 'bg-[var(--lume-accent-2)] animate-pulse', text: 'text-[var(--lume-accent-2)]' },
  completed: { label: '已完成', dot: 'bg-[var(--lume-success)]', text: 'text-[var(--lume-success)]' },
  errored: { label: '出错', dot: 'bg-[var(--lume-danger)]', text: 'text-[var(--lume-danger)]' },
}
```

Replace header root:

```tsx
<div className="flex items-center gap-3 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] px-4 py-3">
```

Replace status pill base:

```tsx
'flex items-center gap-1.5 rounded-full bg-[var(--lume-bg-elevated)] px-2 py-0.5 text-[11px] font-medium flex-shrink-0'
```

- [ ] **Step 2: Tokenize message viewport and empty state**

In `AgentMessages.tsx`, replace the empty state classes:

```tsx
<div className="text-center space-y-1">
  <p className="text-[var(--lume-text-secondary)] text-sm font-medium">Agent 已就绪</p>
  <p className="text-[var(--lume-text-muted)] text-xs">输入任务开始</p>
</div>
```

Replace scroll-to-bottom button:

```tsx
className="absolute bottom-4 right-14 z-20 inline-flex size-9 items-center justify-center rounded-full border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] text-[var(--lume-text-secondary)] shadow-[0_12px_30px_-24px_hsl(var(--lume-shadow-panel)/0.72)] transition-colors hover:border-[var(--lume-border-strong)] hover:text-[var(--lume-accent)]"
```

- [ ] **Step 3: Tokenize attachment cards**

In `AgentAttachmentGrid.tsx`, replace the button base classes with:

```tsx
'flex h-full w-full min-w-0 overflow-hidden rounded-[12px] border text-left shadow-[0_1px_0_hsl(var(--lume-shadow-panel)/0.08)] transition-colors duration-150 ease-out'
```

Replace image and file branches:

```tsx
image
  ? 'items-center justify-center border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] hover:border-[var(--lume-border-strong)]'
  : 'items-center gap-4 border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-3 hover:border-[var(--lume-border-strong)]'
```

Replace fallback preview:

```tsx
<div className="flex h-full w-full items-center justify-center bg-[var(--lume-accent-soft)] text-[var(--lume-accent)]">
```

Replace file icon tile:

```tsx
<span className="flex size-16 shrink-0 items-center justify-center rounded-[12px] bg-[var(--lume-bg-panel)] text-[var(--lume-accent)]">
```

Replace filename and extension text:

```tsx
<span className="block truncate text-[18px] font-semibold leading-6 text-[var(--lume-text-primary)]">
```

```tsx
<span className="mt-1 flex items-center gap-1.5 text-[17px] font-medium uppercase leading-6 text-[var(--lume-text-muted)]">
```

Replace remove button:

```tsx
className="absolute -right-1.5 -top-1.5 flex size-7 items-center justify-center rounded-full bg-[var(--lume-bg-app)] text-[var(--lume-text-primary)] opacity-95 shadow-[0_8px_18px_-14px_hsl(var(--lume-shadow-panel)/0.9)] transition-colors hover:bg-[var(--lume-bg-elevated)] disabled:cursor-not-allowed disabled:opacity-45"
```

- [ ] **Step 4: Tokenize TodoPanel**

In `TodoPanel.tsx`, replace floating panel classes with:

```tsx
className="flex max-w-[320px] items-center gap-2 rounded-lg border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_94%,transparent)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--lume-text-secondary)] shadow-[0_12px_30px_-24px_hsl(var(--lume-shadow-panel)/0.72)] backdrop-blur"
```

Replace hover details panel:

```tsx
className="pointer-events-none absolute bottom-full left-1/2 mb-2 w-[280px] -translate-x-1/2 rounded-lg border border-[var(--lume-border-subtle)] bg-[color:color-mix(in_oklab,var(--lume-bg-elevated)_96%,transparent)] p-3 text-[12px] opacity-0 shadow-[0_18px_42px_-28px_hsl(var(--lume-shadow-panel)/0.62)] backdrop-blur transition-opacity duration-150"
```

Replace active stroke colors in `TodoRing`:

```tsx
stroke={active ? 'var(--lume-accent)' : 'var(--lume-text-muted)'}
```

- [ ] **Step 5: Tokenize primary runtime chrome**

In `RuntimeEventContentBlock.tsx`, focus only on visible message chrome. Replace the recurring hardcoded shell colors with these token patterns:

Assistant markdown class:

```tsx
className="agent-message-markdown x-markdown text-[15px] leading-7 text-[var(--lume-text-primary)]"
```

Muted action row:

```tsx
className="pointer-events-none flex min-h-6 w-full -translate-y-1 items-center justify-between gap-3 pt-2 text-[var(--lume-text-muted)] opacity-0 transition-[opacity,transform] duration-150 ease-out group-hover/agent-message:pointer-events-auto group-hover/agent-message:translate-y-0 group-hover/agent-message:opacity-100 group-focus-within/agent-message:pointer-events-auto group-focus-within/agent-message:translate-y-0 group-focus-within/agent-message:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none"
```

User message bubble:

```tsx
className="rounded-[12px] rounded-tr-[10px] bg-[var(--lume-accent-soft)] px-3 py-2 text-[15px] font-medium leading-[22px] text-[var(--lume-text-primary)] shadow-[0_1px_0_hsl(var(--lume-shadow-panel)/0.08)]"
```

Plan preview shell:

```tsx
className="w-full max-w-[920px] overflow-hidden rounded-[18px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-5 py-5 shadow-[0_18px_50px_-36px_hsl(var(--lume-shadow-panel)/0.62)]"
```

Tool-call shell:

```tsx
className="w-full max-w-[460px] overflow-hidden rounded-[10px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] shadow-[0_1px_2px_hsl(var(--lume-shadow-panel)/0.08)]"
```

Inline action menu:

```tsx
className="absolute left-0 top-full z-30 mt-1 min-w-[112px] rounded-lg border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-1 shadow-[0_16px_40px_-24px_hsl(var(--lume-shadow-panel)/0.62)]"
```

File link:

```tsx
className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md border border-[color:color-mix(in_oklab,var(--lume-accent)_28%,var(--lume-border-subtle))] bg-[var(--lume-accent-soft)] px-1.5 py-0.5 align-baseline font-mono text-[0.92em] font-medium text-[var(--lume-accent)] shadow-[0_1px_0_hsl(var(--lume-shadow-panel)/0.08)] transition-colors hover:border-[color:color-mix(in_oklab,var(--lume-accent)_46%,var(--lume-border-strong))] hover:text-[var(--lume-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--lume-focus-ring)]"
```

Leave code syntax colors and `buildExportHtml` inline HTML styles unchanged in this task.

- [ ] **Step 6: Run focused message tests and commit**

Run:

```bash
bun test apps/web/src/components/agent/AgentMessages.test.ts
```

Expected: PASS.

If `RuntimeEventContentBlock.tsx` changes snapshots or rendered output assumptions, run the directly related tests:

```bash
bun test apps/web/src/components/agent/RuntimeEventContentBlock.test.ts apps/web/src/components/agent/RuntimeEventContentBlock.markdown-streaming.test.tsx apps/web/src/components/agent/RuntimeEventContentBlock.plan-preview.test.tsx
```

Expected: PASS.

Commit:

```bash
git add -- apps/web/src/components/agent/AgentHeader.tsx apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/AgentAttachmentGrid.tsx apps/web/src/components/agent/TodoPanel.tsx apps/web/src/components/agent/RuntimeEventContentBlock.tsx
git diff --cached --name-only
git commit -m "💄 ui(web): 降低消息区视觉噪音" -m "将消息区、附件、运行状态和主要 runtime chrome 迁移到 Lume token，保留消息投影与滚动行为。" -m "Constraint: 不改 runtime event 投影、自动滚动和附件打开逻辑" -m "Tested: bun test apps/web/src/components/agent/AgentMessages.test.ts"
```

---

### Task 7: Main-Path Visual Cleanup And Manual QA

**Files:**
- Modify only if needed: files changed in Tasks 1-6

- [ ] **Step 1: Scan for legacy main-path styling**

Run:

```bash
rg -n "dark:bg-zinc|bg-white|#[0-9a-fA-F]{3,8}|rgba\\(|bg-black|border-white|text-white|red-500|blue-500|green-500|orange-500" apps/web/src/components/app-shell apps/web/src/components/tabs/TabBar.tsx apps/web/src/components/tabs/MainArea.tsx apps/web/src/components/agent/AgentHeader.tsx apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/AgentAttachmentGrid.tsx apps/web/src/components/agent/TodoPanel.tsx apps/web/src/components/agent/RuntimeEventContentBlock.tsx apps/web/src/components/composer apps/web/src/components/right-panel apps/web/src/index.css
```

Expected remaining matches:

```text
apps/web/src/components/agent/RuntimeEventContentBlock.tsx: buildExportHtml CSS or syntax/code fallback colors
apps/web/src/components/right-panel/BrowserRightPanelTab.tsx: embedded browser preview white surface
```

If matches appear in `TabBar.tsx`, `MainArea.tsx`, `AgentHeader.tsx`, `AgentMessages.tsx`, `AgentAttachmentGrid.tsx`, `TodoPanel.tsx`, `LumeComposer.tsx`, or right-panel shell/menu files, replace them with `--lume-*` tokens before continuing.

- [ ] **Step 2: Start the local web app**

Run:

```bash
bun --filter @lume/web dev
```

Expected: dev server starts and prints a local URL. Keep this command running for manual QA. If the default port is busy, use the alternate URL printed by Vite.

- [ ] **Step 3: Manual visual QA in dark mode**

Open the local URL and verify:

- App, titlebar, sidebar, main panel, composer, and right panel are visually distinct.
- Tab switching does not flash a white or zinc background.
- Sidebar hover, active workspace, active thread, running thread, blocked thread, and completed thread are visually distinguishable.
- Composer focus/readiness feels like entering input mode without resizing the layout.
- Right panel resize handle is discoverable on hover and does not shift content.
- Scroll-to-bottom button, TodoPanel, attachment cards, and primary runtime blocks use the same surface language.

- [ ] **Step 4: Manual visual QA in light mode**

Toggle light mode and verify:

- Text contrast remains readable.
- Accent does not dominate large areas.
- Composer, tab, sidebar, and right panel still have clear hierarchy.
- No dark-only foreground appears on light surfaces.

- [ ] **Step 5: Run focused contract tests**

Run:

```bash
bun test apps/web/test/lume-theme-contract.test.ts apps/web/src/components/composer/LumeComposer.contract.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit cleanup if there were final edits**

If Step 1 or QA caused edits, commit them:

```bash
git add -- apps/web/src/index.css apps/web/test/lume-theme-contract.test.ts apps/web/src/components/app-shell apps/web/src/components/tabs/TabBar.tsx apps/web/src/components/tabs/MainArea.tsx apps/web/src/components/agent/AgentHeader.tsx apps/web/src/components/agent/AgentMessages.tsx apps/web/src/components/agent/AgentAttachmentGrid.tsx apps/web/src/components/agent/TodoPanel.tsx apps/web/src/components/agent/RuntimeEventContentBlock.tsx apps/web/src/components/composer apps/web/src/components/right-panel
git diff --cached --name-only
git commit -m "💄 ui(web): 清理主路径暗黑散色" -m "补齐主路径残留硬编码颜色和 legacy dark zinc 类，完成视觉一致性清扫。" -m "Constraint: 不覆盖设置页、市场页和边缘预览页" -m "Tested: bun test apps/web/test/lume-theme-contract.test.ts apps/web/src/components/composer/LumeComposer.contract.test.tsx"
```

If Step 1 and QA did not require edits, skip this commit and report that no cleanup diff was needed.

---

## Final Verification

Run only these focused checks unless implementation changed logic beyond this plan:

```bash
bun test apps/web/test/lume-theme-contract.test.ts apps/web/src/components/composer/LumeComposer.contract.test.tsx apps/web/src/components/agent/AgentMessages.test.ts
```

Expected: PASS.

Do not run full repository lint, typecheck, or full test suite for this pure UI/token pass unless a touched file introduces a TypeScript error or a focused test exposes behavior risk.

## Remaining Risk To Report After Execution

- Token values are visually chosen; final dark-mode feel still requires human review in the app.
- `RuntimeEventContentBlock.tsx` is large and contains syntax/export-specific colors that should remain outside this pass.
- If target files were dirty before implementation, commits may need hunk-level staging to avoid including unrelated work.
- Light mode is supported but dark mode is the primary design target for this pass.

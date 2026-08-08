# 灵动岛体验优化 Phase 3（renderer+window 对齐 Proma）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Lume 灵动岛 Electron 路径（Windows/Linux/macOS<26）相对 Proma 的用户可感知差距——planning 渲染、窗口拖动、dismiss/open-main 按钮、activityLines、紧凑紧迫图标、Windows 位置持久化。

**Architecture:** 纯 renderer（`AgentIslandSurface.tsx`）+ window（`agent-island-window.ts`）+ 投影（`agent-island-projections.ts`）层改动，**不碰 state schema**（不加 idleDashboard/recentSessions 字段——留下一批）。native（Swift Phase 2）路径不动。参考 Proma `apps/electron/src/renderer/components/agent-island/AgentIslandApp.tsx` + `apps/electron/src/main/lib/agent-island-window.ts`。

**Tech Stack:** React 18 + TypeScript、shadcn `Button`、Tailwind v4、`bun:test` + `renderToStaticMarkup` 契约测。

**参考实现：** `D:/workspace/projects/ai-projects/Proma`（灵动岛原生实现，已验证）。

---

## Global Constraints

- **不破坏 Phase 1/2**：Electron 路径行为不回归；native（Swift/Phase 2）路径完全不动；service 的 native 推送分支（Task 4 Phase 2 已修）不动。
- **首批不碰 state schema**：不加 `idleDashboard`/`recentSessions`/`pill` 等字段（那是下批）。本批只渲染/交互已有 `state`（`sessions`/`planning`/`compactLabel`）。
- **service 命名**：`AgentIslandServiceDeps`（`this.deps`，非 opts）——Phase 2 Task 4 既有约定。
- **apps/desktop import**：相对路径 `../../../packages/shared/src/...`（不解析 `@lume/shared` 别名）。
- **apps/web 用别名**：`@lume/shared`、`@/components/ui`（Surface 在 apps/web，可用别名）。
- **UI 原子**：交互控件用 shadcn `Button`（`apps/web/src/components/ui`）；岛屿 morphing 表面/drag handle 手写 CSS。
- **测试**：`bun:test`；renderer 契约测 `renderToStaticMarkup`；纯逻辑测 co-locate `*.test.ts`。改动有可测逻辑（projections 新函数）必须 TDD。
- **提交策略**：按主题 5–7 commit、emoji 前缀；SDD 每 task 独立 commit。
- **平台形态**：mac 圆角 vs Windows 矩形由 CSS `html.darwin` 键控（preload 注入），组件不引用 `process.platform`。

---

## File Structure

**修改：**
- `apps/web/src/components/agent-island/AgentIslandSurface.tsx` — planning 渲染 + dismiss/open-main 按钮 + drag handle + activityLines + 紧迫图标
- `apps/web/src/components/agent-island/agent-island.css` — planning 两列样式 + drag handle + 紧迫图标
- `apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx` — 补 planning/dissmiss/activityLines 契约断言
- `apps/desktop/src/agent-island-window.ts` — movable:true + 位置持久化 + move 事件存盘
- `apps/desktop/src/main.ts` — 位置存/读到 settings 接线
- `apps/desktop/src/agent-island-service.ts` — activityLines push（识别 tool/task 事件）
- `packages/shared/src/agent-island-projections.ts` — `selectPlanningIndicator` 纯函数 + activityLines 截断
- `packages/shared/src/agent-island-projections.test.ts` — 补紧迫指示器/activityLines 测
- `packages/shared/src/types/general-settings.ts`（或等价 settings 文件）— `islandWindowPosition?: {x,y}` 字段

---

## Task 1: Electron renderer 渲染 planning（高·重大缺失）

**Files:**
- Modify: `apps/web/src/components/agent-island/AgentIslandSurface.tsx`
- Modify: `apps/web/src/components/agent-island/agent-island.css`
- Test: `apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx`

**参考:** Proma `apps/electron/src/renderer/components/agent-island/AgentIslandApp.tsx:269-295`（两列 todos/events，逾期红框 + 时间标签 + 计数）。

**Interfaces:**
- Consumes: `state.planning: AgentIslandPlanningSnapshot`（`{todos, reminders}`，已由 service 投好，字段 `id/title/kind/dueAt/overdue`）
- Produces: expanded 卡片在 sessions 之后渲染 planning 两列

- [ ] **Step 1: 补契约测（先写失败）**

在 `AgentIslandSurface.contract.test.tsx` 加：expanded + planning 非空时，输出含 `待办` 与 `提醒` 文本节点；逾期项含 `data-overdue="true"`。
```tsx
test('expanded 渲染 planning 两列', () => {
  const state: AgentIslandState = {
    presentation: 'expanded', primarySessionId: 't1', compactLabel: 'Lume · 正在执行',
    sessions: [{ threadId: 't1', title: 'A', phase: 'running', detail: '', activityLines: [], attention: false, unread: false, terminalAt: null, lastActivityAt: 1 }],
    planning: {
      todos: [{ id: 'p1', title: '写文档', kind: 'todo', dueAt: 1, overdue: true }],
      reminders: [{ id: 'r1', title: '站会', kind: 'calendar_event', dueAt: 2, overdue: false }],
    },
    updatedAt: 1,
  }
  const html = renderToStaticMarkup(<AgentIslandSurface state={state} onIntent={() => {}} />)
  expect(html).toContain('待办')
  expect(html).toContain('提醒')
  expect(html).toContain('data-overdue="true"')
})
```

- [ ] **Step 2: 跑测确认失败** — Run: `bun test apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx`

- [ ] **Step 3: Surface 加 planning 区**

在 `expanded` 块的 `<ul className="island-sessions">` 之后，加 planning 两列（结构对齐 Proma 但用 Lume 字段）：
```tsx
{(state.planning.todos.length > 0 || state.planning.reminders.length > 0) && (
  <div className="island-planning">
    {state.planning.todos.length > 0 && (
      <div className="island-planning-col">
        <div className="island-planning-head"><ListTodo className="island-planning-icon" /><span>待办</span><span className="island-planning-count">{state.planning.todos.length}</span></div>
        {state.planning.todos.slice(0, 3).map((t) => (
          <div key={t.id} className="island-planning-row" data-overdue={t.overdue ? 'true' : 'false'} role="button" tabIndex={0}
            onClick={() => onIntent({ name: 'open-planning' in {} ? 'open-main' : 'open-main' })}>
            <span className={cn('island-planning-check', t.overdue && 'island-planning-check-overdue')} />
            <span className="island-planning-text">{t.title}</span>
            <span className="island-planning-time">{formatIslandTime(t.dueAt)}</span>
          </div>
        ))}
      </div>
    )}
    {state.planning.reminders.length > 0 && (
      <div className="island-planning-col">
        <div className="island-planning-head"><CalendarDays className="island-planning-icon" /><span>提醒</span><span className="island-planning-count">{state.planning.reminders.length}</span></div>
        {state.planning.reminders.slice(0, 3).map((r) => (
          <div key={r.id} className="island-planning-row" role="button" tabIndex={0} onClick={() => onIntent({ name: 'open-main' })}>
            <span className="island-planning-time">{formatIslandTime(r.dueAt)}</span>
            <span className="island-planning-text">{r.title}</span>
          </div>
        ))}
      </div>
    )}
  </div>
)}
```
- 顶部加 import：`import { ListTodo, CalendarDays } from 'lucide-react'`
- 加 `formatIslandTime(ts)` helper（`new Date(ts).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})`，逾期加"逾期"前缀）
- `open-planning` 在 Lume 无独立窗，降级 `open-main`（与 Phase 2 nativeEventToIntent 一致）。但 `AgentIslandIntentName` 若无 `open-planning`，直接用 `open-main`。

- [ ] **Step 4: css 加 `.island-planning*` 样式** — 两列 grid（`grid-template-columns: 1fr 1fr`）、列容器半透明白底圆角、逾期红框、时间灰色小字。参考 Proma `agent-island.css` 的 planning 段。

- [ ] **Step 5: 跑测确认通过** — `bun test ...AgentIslandSurface.contract.test.tsx`

- [ ] **Step 6: commit** — `✨ feat(web): 灵动岛 expanded 渲染 planning 两列(对齐 Proma)`

---

## Task 2: 窗口拖动（高·功能缺失）

**Files:**
- Modify: `apps/desktop/src/agent-island-window.ts`
- Modify: `apps/web/src/components/agent-island/AgentIslandSurface.tsx`
- Modify: `apps/web/src/components/agent-island/agent-island.css`

**参考:** Proma `agent-island-window.ts`（`movable:true`）+ `agent-island.css`（`.island-drag-handle { -webkit-app-region: drag }`，按钮 `no-drag`）。

- [ ] **Step 1: window 开 movable** — `agent-island-window.ts` 的 `createIslandWindow`：`movable: false` → `movable: true`（保留 `resizable:false`）。

- [ ] **Step 2: Surface 加 drag handle** — expanded 头部空白区作 drag handle（`-webkit-app-region:drag`）；按钮/会话行 `no-drag`。在 `.island-expanded-head` 加 `island-drag-handle` 类；`.island-actions / .island-session-row / .island-planning-row` 加 `island-no-drag`。
```tsx
<div className="island-expanded-head island-drag-handle">
  <span className="island-title">...</span>
  <div className="island-actions island-no-drag">...</div>
</div>
```

- [ ] **Step 3: css** — `.island-drag-handle { -webkit-app-region: drag; cursor: move }`；`.island-no-drag { -webkit-app-region: no-drag }`。compact 层也可拖（整个 compact 是 drag，按钮 no-drag）。

- [ ] **Step 4: 视觉验证**（需启动 app；SDD 步骤里 typecheck 即可，端到端留 finishing 验证）— `bunx tsc --noEmit -p apps/desktop/tsconfig.json` + `apps/web`。

- [ ] **Step 5: commit** — `✨ feat(desktop,web): 灵动岛窗口可拖动(drag handle)`

---

## Task 3: dismiss / open-main 按钮（中·Surface UI 缺失）

**Files:**
- Modify: `apps/web/src/components/agent-island/AgentIslandSurface.tsx`
- Test: `AgentIslandSurface.contract.test.tsx`

**参考:** Proma `AgentIslandApp.tsx:255-262`（"打开 Proma"按钮 + 顶部空白收起手势）。

- [ ] **Step 1: 补契约测** — expanded 含"打开 Lume"按钮（触发 `open-main`）与"关闭"按钮（触发 `dismiss`）。
```tsx
test('expanded 有 open-main 与 dismiss 按钮', () => {
  const state = /* expanded + 1 session */;
  const intents: AgentIslandIntent[] = []
  renderToStaticMarkup(<AgentIslandSurface state={state} onIntent={(i) => intents.push(i)} />)
  // 契约测只断言渲染含按钮文本；interaction 测在组件 click（若用 jsdom）或不断言 click
  expect(html).toContain('打开 Lume')
  expect(html).toContain('关闭')
})
```

- [ ] **Step 2: Surface expanded actions 加两按钮** — 在 `island-actions` 加：
```tsx
<Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'open-main' })}>打开 Lume</Button>
{primary?.attention && <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'dismiss' })}>关闭</Button>}
<Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'open-session', threadId: primary.threadId })}>打开会话</Button>
<Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'set-expanded', value: false })}>收起</Button>
```
> dismiss 仅在 `attention`（紧迫/待交互）时显示，避免空闲误关。

- [ ] **Step 3: 跑测 + commit** — `✨ feat(web): 灵动岛 expanded 加打开主窗/关闭按钮`

---

## Task 4: activityLines 显示（中·功能缺失）

**Files:**
- Modify: `packages/shared/src/agent-island-projections.ts`（截断 helper）
- Modify: `apps/desktop/src/agent-island-service.ts`（push activityLines）
- Modify: `apps/web/src/components/agent-island/AgentIslandSurface.tsx`（显示最近一条）
- Test: `packages/shared/src/agent-island-projections.test.ts`

**参考:** Proma `agent-island-service.ts:137-142`（`pushActivity` 累积工具名/状态行）+ `AgentIslandApp.tsx`（`session.activityLines.last` 显示）。

**现状:** Lume service `handleSidecarNotification` 只识别 `agent:runtime-status-changed`，其他事件（tool/task）未 push activityLines → `applyStatus` 用 `prev?.activityLines ?? []`，永远空。

- [ ] **Step 1: projections 加 `pushActivityLine` 纯函数 + 测**
```ts
const MAX_ACTIVITY_LINES = 4
export function pushActivityLine(prev: string[], line: string): string[] {
  const next = [...prev, line]
  return next.slice(-MAX_ACTIVITY_LINES)
}
```
测：累积 + 截断到 4 条。

- [ ] **Step 2: service 识别 tool/task 事件 push activityLines**

读 service `handleSidecarNotification`，对 sidecar 的 tool 执行事件（如 `agent:tool-call` / `RUNTIME_EVENT` 含 tool 名）调 `pushActivityLine`。**先读现有 service 确认事件名**（Lume sidecar 的事件 method），按实际适配。若事件未在 service 订阅，在 `applyStatus` 里从 `detail` 兜底生成（`detail` 已含"第 N 步 · toolName"）。
> 关键：让 `session.activityLines` 至少有最近一条，而非空数组。

- [ ] **Step 3: Surface session row 显示 activityLines 最近一条**
```tsx
{s.activityLines.length > 0 && (
  <span className="island-session-activity">{s.activityLines[s.activityLines.length - 1]}</span>
)}
```
css：灰色小字、单行截断。

- [ ] **Step 4: 跑测 + typecheck + commit** — `✨ feat(shared,desktop,web): 灵动岛 activityLines 累积与显示`

---

## Task 5: compact 紧迫图标（低·体验）

**Files:**
- Modify: `packages/shared/src/agent-island-projections.ts`
- Modify: `apps/web/src/components/agent-island/AgentIslandSurface.tsx`
- Test: `packages/shared/src/agent-island-projections.test.ts`

**参考:** Proma `AgentIslandApp.tsx:77-87, 299-303`（无 primary session 时按 imminent event/todo 显示 calendar/checklist 彩色 SF Symbol）。

- [ ] **Step 1: projections 加 `selectPlanningIndicator` 纯函数 + 测**
```ts
export interface PlanningIndicator { symbol: 'calendar' | 'checklist'; color: string }
export function selectPlanningIndicator(
  planning: AgentIslandPlanningSnapshot, now: number,
): PlanningIndicator | null {
  const win = PLANNING_ATTENTION_WINDOW_MS
  const nextEvent = planning.reminders.find(r => r.dueAt >= now && r.dueAt - now <= win)
  const nextTodo = planning.todos.find(t => t.dueAt >= now && t.dueAt - now <= win)
  if (nextEvent && (!nextTodo || nextEvent.dueAt <= nextTodo.dueAt))
    return { symbol: 'calendar', color: 'var(--lume-accent)' }
  if (nextTodo) return { symbol: 'checklist', color: 'var(--lume-warning)' }
  return null
}
```
测：imminent event/todo 优先级 + 无则 null。

- [ ] **Step 2: Surface compact 无 primary session 时显示图标**
```tsx
{!primary && indicator && (
  <span className="island-planning-indicator" style={{ color: indicator.color }}>
    {indicator.symbol === 'calendar' ? <CalendarDays className="island-indicator-icon" /> : <ListTodo className="island-indicator-icon" />}
  </span>
)}
```
（Surface 算 indicator：`selectPlanningIndicator(state.planning, Date.now())`）

- [ ] **Step 3: 跑测 + commit** — `✨ feat(shared,web): 灵动岛 compact 紧迫 planning 图标`

---

## Task 6: Windows 位置持久化（高·功能缺失）

**Files:**
- Modify: `apps/desktop/src/agent-island-window.ts`
- Modify: `apps/desktop/src/main.ts`（存/读接线）
- Modify: settings 类型（`islandWindowPosition?: { x: number; y: number }`）—— 先读确认 Lume settings 文件位置（`packages/shared/src/types/general-settings.ts` 或等价）

**参考:** Proma `agent-island-window.ts:42-79`（win32 `{x,y}` 存 settings，按 `getDisplayNearestPoint(saved)` 重定位）。

- [ ] **Step 1: settings 加 `islandWindowPosition`** — 在 Lume GeneralSettings（与 `agentIsland` 同体系）加可选字段 `{x,y}`。

- [ ] **Step 2: window 创建时读 saved 重定位** — `createIslandWindow` 接收 saved 位置参数；若 saved 且 `screen.getDisplayNearestPoint(saved)` 非空，用 saved 的显示器 workArea + saved 偏移；否则 fallback 光标居中（现状）。

- [ ] **Step 3: 拖动后存盘** — `win.on('move', ...)` 防抖（300ms）后把 `{x,y}` 写回 settings（经 service 的 settings-replace 或 main 的 settings 汇聚点）。

- [ ] **Step 4: main.ts 接线** — `ensureIslandWindow` 传 saved；move 事件接 settings 写。

- [ ] **Step 5: typecheck + commit** — `✨ feat(desktop): 灵动岛窗口位置持久化(Windows/Linux)`

---

## Self-Review

1. **Spec 覆盖（首批 6 项差距）**：planning 渲染→Task 1；拖动→Task 2；dismiss/open-main→Task 3；activityLines→Task 4；紧迫图标→Task 5；位置持久化→Task 6。✅
2. **不碰 state schema**：本批不加 idleDashboard/recentSessions/pill 字段（下批）。Task 4 只填充既有 `activityLines: string[]`。✅
3. **不破坏 Phase 1/2**：native（Swift）路径不动；service native 推送分支不动；Electron 推送保留。Task 4 service 改动仅加 activityLines push，不改 push 结构。✅
4. **依赖**：Task 1/3 共改 Surface（同文件，SDD 顺序执行避免冲突）；Task 4 改 service+Surface+projections（跨文件，但 Surface 部分与 Task 1/3 在同文件——SDD 串行 dispatch，不并行）。Task 5 用 Task 4 的 projections 文件（串行）。
5. **可验证性**：projections 新函数 TDD（Task 4/5）；Surface 契约测（Task 1/3）；window/service typecheck（Task 2/6）。Windows 端到端视觉验证留 finishing 阶段（启动 app）。

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-08-05-agent-island-experience.md`。

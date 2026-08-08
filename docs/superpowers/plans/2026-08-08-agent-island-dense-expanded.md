# Agent Island Dense Expanded Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Windows Electron 灵动岛实现为已确认的高密度展开态，并修复异常阴影、不可拖动和非法时间显示。

**Architecture:** 保留现有 Surface 状态机、高度测量和 intent 接口，只调整渲染结构与局部格式化 helper。拖动完全由 renderer 的 `-webkit-app-region` 处理，主进程 BrowserWindow 配置不变。

**Tech Stack:** React 18、TypeScript、shadcn Button/Tooltip、lucide-react、CSS、bun:test。

---

### Task 1: 锁定标题、时间和拖动契约

**Files:**
- Modify: `apps/web/src/components/agent-island/AgentIslandSurface.test.tsx`
- Modify: `apps/web/src/components/agent-island/AgentIslandSurface.tsx`

- [ ] **Step 1: 写失败测试**

在现有测试文件中导入 `formatIslandSessionTitle` 和 `formatIslandTime`，新增断言：

```tsx
expect(formatIslandSessionTitle('', '18bb87a0-9755')).toBe('未命名会话 · 18bb87')
expect(formatIslandSessionTitle('18bb87a0-9755-4d44-b951-c5bf93de304b', 't1')).toBe('未命名会话 · 18bb87')
expect(formatIslandTime(Number.NaN, false)).toBe('')
expect(formatIslandTime(1, false)).not.toContain('Invalid Date')
```

紧凑态 SSR 断言包含可拖动容器和唯一的展开按钮：

```tsx
expect(html).toContain('island-compact-layer island-drag-handle')
expect(html).toContain('aria-label="展开"')
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `bun test apps/web/src/components/agent-island/AgentIslandSurface.test.tsx -t "高密度展开态 helper|compact 拖动契约"`

Expected: FAIL，因为 helper 尚未导出，且 compact 仍由整条 button 覆盖。

- [ ] **Step 3: 实现最小 helper 和 compact 结构**

在 Surface 中加入：

```tsx
export function formatIslandSessionTitle(title: string, threadId: string): string {
  const normalized = title.trim()
  const uuid = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i
  if (normalized && normalized !== threadId && !uuid.test(normalized)) return normalized
  const source = normalized || threadId
  return `未命名会话 · ${source.slice(0, 6)}`
}

export function formatIslandTime(ts: number, overdue: boolean): string {
  if (!Number.isFinite(ts)) return ''
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const hhmm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return overdue ? `逾期 · ${hhmm}` : hhmm
}
```

把 compact 根节点从全宽 `button` 改为 `div.island-compact-layer.island-drag-handle`，内部只保留一个 shadcn `Button size="icon-xs"` 触发 `set-expanded`。

- [ ] **Step 4: 运行测试确认 GREEN**

Run: `bun test apps/web/src/components/agent-island/AgentIslandSurface.test.tsx -t "高密度展开态 helper|compact 拖动契约"`

Expected: PASS。

### Task 2: 实现高密度展开结构

**Files:**
- Modify: `apps/web/src/components/agent-island/AgentIslandSurface.tsx`
- Modify: `apps/web/src/components/agent-island/agent-island.css`

- [ ] **Step 1: 改为图标操作栏**

导入 `AppWindow`、`MessageSquare`、`X`、`ChevronUp` 和 Tooltip 原子组件。每个操作使用 `Button size="icon-xs" variant="ghost"`，用 `aria-label` 和 Tooltip 保留“打开 Lume”“关闭”“打开会话”“收起”语义。

- [ ] **Step 2: 压缩会话内容**

活动会话只渲染状态点、`formatIslandSessionTitle` 标题、`formatSessionMeta` 摘要和阶段标签。`formatSessionMeta` 只拼模型 label 与正数 Token：

```tsx
if (modelLabel) parts.push(modelLabel)
if (session.tokenTotal != null && session.tokenTotal > 0) {
  parts.push(`${(session.tokenTotal / 1000).toFixed(1)}k`)
}
```

加入 `island-section-head`，顶部摘要用 `state.sessions`/`recentSessions` 和 planning 数量计算。

- [ ] **Step 3: 条件渲染 planning 时间**

每个 planning 条目先得到 `const time = formatIslandTime(item.dueAt, item.overdue)`，仅在 `time` 非空时渲染 `.island-planning-time`。

- [ ] **Step 4: 应用已确认 CSS 尺寸**

删除 surface 阴影和旧的绝对 grip；设置：

```css
.island-expanded-head { height: 32px; padding: 0 4px 0 12px; }
.island-title { font-size: 10.5px; }
.island-actions [data-slot='button'] { width: 24px; height: 24px; }
.island-session-row { height: 30px; border-bottom: 1px solid rgb(255 255 255 / 0.09); }
.island-planning-head { height: 24px; }
.island-planning-row { min-height: 28px; }
```

会话和 planning 容器去掉卡片背景、大圆角和纵向 gap。

### Task 3: 验证与交付

**Files:**
- Verify: `apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx`
- Verify: `apps/web/src/components/agent-island/AgentIslandSurface.test.tsx`

- [ ] **Step 1: 运行相关测试**

Run: `bun test apps/web/src/components/agent-island/AgentIslandSurface.test.tsx apps/web/src/components/agent-island/AgentIslandSurface.contract.test.tsx`

Expected: 本次新增用例通过；若分支原有 expanded SSR 契约仍失败，记录其既有状态，不把无关状态机改动并入本次 UI 修改。

- [ ] **Step 2: 运行 Web typecheck**

Run: `bun run --filter @lume/web typecheck`

Expected: PASS。

- [ ] **Step 3: Windows Electron 手工验证**

在现有 dev 会话中检查：紧凑态可拖动；只有右侧按钮展开；surface 无裁切阴影；展开顶部栏 32px；会话行 30px；非法 dueAt 不显示 `Invalid Date`。

- [ ] **Step 4: 审查改动范围**

Run: `git diff -- apps/web/src/components/agent-island/AgentIslandSurface.tsx apps/web/src/components/agent-island/agent-island.css apps/web/src/components/agent-island/AgentIslandSurface.test.tsx`

Expected: 没有主进程、shared 类型、新依赖或无关格式化改动。

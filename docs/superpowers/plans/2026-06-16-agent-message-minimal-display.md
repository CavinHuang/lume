# Agent 消息极简显示模式 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superparameters:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 agent 消息新增「极简」显示模式（与「明细」二选一，极简为新默认），把工具调用/思考/子代理收进一条次要色可展开过程行，行内显示操作数、子代理数、区块内工具调用总时长（运行中实时跳动）。

**Architecture:** 新增 `agentMessageDisplayMode` 设置，走现有「shared 类型 → sidecar zod → sidecar 持久化 → web state」三层管线；web 端新增 `generalSettingsAtom`（Jotai）在 Agent 视图启动时加载一次，渲染层据此分支。极简模式下把 `RuntimeAssistantBlock[]` 中相邻的 `thinking`/`tool_call` 合并成「过程组」，渲染成一条可展开的次要色过程行；展开后复用现有 `RuntimeEventToolCallBlock` / `RuntimeEventThinkingBlock` 渲染明细。工具耗时 `durationMs` 在投影层由 `tool.started`→`tool.completed/failed` 的 `createdAt` 差值计算。

**Tech Stack:** React 18 + TypeScript + Jotai + Tailwind v4（monorepo: `packages/shared`、`apps/web`、`apps/sidecar`）。无自动化测试框架 → 验证方式为 `typecheck` / `build` / 手动核对。

**参考设计文档:** `docs/superpowers/specs/2026-06-16-agent-message-minimal-display-design.md`

**约定:** 所有命令在仓库根目录 `/Users/cavin/workspace/project/lume` 执行。`- [ ]` 步骤按顺序完成。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `packages/shared/src/types/general-settings.ts` | `GeneralSettings` 类型与默认值 | 修改 |
| `apps/sidecar/src/rpc/schemas.ts` | `updateGeneralSettingsInputSchema`（zod） | 修改 |
| `apps/sidecar/src/services/system/general-settings-service.ts` | sanitize / 持久化 | 修改 |
| `apps/web/src/components/settings/general-settings-state.ts` | `mergeGeneralSettings` | 修改 |
| `apps/web/src/atoms/settings-atoms.ts` | `generalSettingsAtom` | 修改 |
| `apps/web/src/lib/use-general-settings.ts` | `useBootstrapGeneralSettings()` hook | 新建 |
| `apps/web/src/components/agent/AgentMessages.tsx` | 启动时加载设置 | 修改 |
| `apps/web/src/components/agent/runtime-message-view.ts` | `RuntimeToolCallView` 加 `startedAt`/`durationMs` | 修改 |
| `apps/web/src/components/agent/runtime-event-message-projection.ts` | 计算并填充 `durationMs` | 修改 |
| `apps/web/src/components/agent/minimal-assistant-grouping.ts` | 纯函数：blocks → segments（分组） | 新建 |
| `apps/web/src/components/agent/RuntimeEventContentBlock.tsx` | 极简分支 + `MinimalAssistantContent` + `MinimalProcessGroup` + 工具耗时标签 | 修改 |
| `apps/web/src/components/settings/AppearanceSettings.tsx` | 外观 tab：[极简/明细] 开关 | 新建 |
| `apps/web/src/components/settings/SettingsView.tsx` | 替换 appearance 占位符 | 修改 |

**关于组件放置：** `MinimalAssistantContent` / `MinimalProcessGroup` 写在 `RuntimeEventContentBlock.tsx` 内部（复用其内部未导出的 `SmoothText` / `PlanPreviewCard` / `RuntimeEventToolCallBlock` / `RuntimeEventThinkingBlock`，避免循环依赖与重复导出）。分组纯逻辑独立成 `minimal-assistant-grouping.ts`，便于阅读与日后测试。

---

## Task 1: shared 类型 — 新增 `agentMessageDisplayMode`

**Files:**
- Modify: `packages/shared/src/types/general-settings.ts:15-25,81-93`

- [ ] **Step 1: 加类型与字段**

在 `packages/shared/src/types/general-settings.ts` 中：

1) 在 `ThemeMode` 定义下方（第 1 行之后）新增类型：
```ts
export type AgentMessageDisplayMode = "minimal" | "verbose"
```

2) `GeneralSettings` 接口（L15-19）增加字段：
```ts
export interface GeneralSettings {
  themeMode: ThemeMode
  windowBehavior: GeneralSettingsWindowBehavior
  updateSettings: GeneralSettingsUpdateSettings
  agentMessageDisplayMode: AgentMessageDisplayMode
}
```

3) `UpdateGeneralSettingsInput` 接口（L21-25）增加可选字段：
```ts
export interface UpdateGeneralSettingsInput {
  themeMode?: ThemeMode
  windowBehavior?: Partial<GeneralSettingsWindowBehavior>
  updateSettings?: Partial<GeneralSettingsUpdateSettings>
  agentMessageDisplayMode?: AgentMessageDisplayMode
}
```

4) `GENERAL_SETTINGS_DEFAULTS`（L81-93）增加默认值（极简为新默认）：
```ts
export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  themeMode: "system",
  windowBehavior: {
    minimizeToTray: false,
    closeToTray: false
  },
  updateSettings: {
    autoCheckUpdates: true,
    notifyAfterDownload: true,
    installOnlyWhenIdle: true,
    lastUpdateCheckAt: null
  },
  agentMessageDisplayMode: "minimal"
}
```

- [ ] **Step 2: 类型检查**

Run: `bun run --filter @lume/shared typecheck`
Expected: 通过，无错误。

- [ ] **Step 3: 提交**

```bash
git add packages/shared/src/types/general-settings.ts
git commit -m "feat(shared): GeneralSettings 新增 agentMessageDisplayMode"
```

---

## Task 2: sidecar — zod 校验 + 持久化

**Files:**
- Modify: `apps/sidecar/src/rpc/schemas.ts:1119-1131`
- Modify: `apps/sidecar/src/services/system/general-settings-service.ts:55-105,201-219`

- [ ] **Step 1: zod schema 加字段**

在 `apps/sidecar/src/rpc/schemas.ts` 的 `updateGeneralSettingsInputSchema`（L1119-1131）末尾（`updateSettings` 对象之后）增加：
```ts
export const updateGeneralSettingsInputSchema = z.object({
  themeMode: z.enum(["system", "light", "dark"]).optional(),
  windowBehavior: z.object({
    minimizeToTray: z.boolean().optional(),
    closeToTray: z.boolean().optional()
  }).optional(),
  updateSettings: z.object({
    autoCheckUpdates: z.boolean().optional(),
    notifyAfterDownload: z.boolean().optional(),
    installOnlyWhenIdle: z.boolean().optional(),
    lastUpdateCheckAt: z.string().nullable().optional()
  }).optional(),
  agentMessageDisplayMode: z.enum(["minimal", "verbose"]).optional()
});
```

- [ ] **Step 2: sanitize 加字段校验**

在 `apps/sidecar/src/services/system/general-settings-service.ts` 中：

1) 在 `isThemeMode` 函数（L51-53）下方新增校验函数：
```ts
function isAgentMessageDisplayMode(value: unknown): value is AgentMessageDisplayMode {
  return value === "minimal" || value === "verbose";
}
```

2) 在文件顶部 `@lume/shared` 的 import（L10-16）中增加类型导入：
```ts
import {
  GENERAL_SETTINGS_DEFAULTS,
  type GeneralSettings,
  type PersistedUiState,
  type ThemeMode,
  type UpdateGeneralSettingsInput,
  type AgentMessageDisplayMode
} from "@lume/shared";
```

3) 在 `sanitizeGeneralSettings` 的返回对象（L74-104，`updateSettings: {...}` 之后、闭合 `}` 之前）增加：
```ts
    agentMessageDisplayMode: isAgentMessageDisplayMode(value.agentMessageDisplayMode)
      ? value.agentMessageDisplayMode
      : GENERAL_SETTINGS_DEFAULTS.agentMessageDisplayMode
```

- [ ] **Step 3: 持久化 merge 加字段**

在 `updatePersistedGeneralSettings`（L201-223）的 `next` 对象中，`themeMode` 行之后增加：
```ts
  const next: GeneralSettings = {
    themeMode: input.themeMode ?? current.themeMode,
    agentMessageDisplayMode: input.agentMessageDisplayMode ?? current.agentMessageDisplayMode,
    windowBehavior: {
```

- [ ] **Step 4: 类型检查**

Run: `bun run --filter @lume/sidecar typecheck`
Expected: 通过，无错误。

- [ ] **Step 5: 提交**

```bash
git add apps/sidecar/src/rpc/schemas.ts apps/sidecar/src/services/system/general-settings-service.ts
git commit -m "feat(sidecar): 持久化 agentMessageDisplayMode 设置"
```

---

## Task 3: web state — merge 函数透传

**Files:**
- Modify: `apps/web/src/components/settings/general-settings-state.ts:60-82`

- [ ] **Step 1: mergeGeneralSettings 透传新字段**

在 `apps/web/src/components/settings/general-settings-state.ts` 的 `mergeGeneralSettings` 返回对象（L66-81）中，`themeMode` 行之后增加：
```ts
  return {
    themeMode: updates.themeMode ?? base.themeMode,
    agentMessageDisplayMode: updates.agentMessageDisplayMode ?? base.agentMessageDisplayMode,
    windowBehavior: {
```
（`base = current ?? GENERAL_SETTINGS_DEFAULTS`，`GENERAL_SETTINGS_DEFAULTS` 在该文件 L22 直接 re-export 自 shared，已含新字段。）

- [ ] **Step 2: 类型检查**

Run: `bun run --filter @lume/web typecheck`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/components/settings/general-settings-state.ts
git commit -m "feat(web): mergeGeneralSettings 透传 agentMessageDisplayMode"
```

---

## Task 4: web — `generalSettingsAtom` + 启动加载

**Files:**
- Modify: `apps/web/src/atoms/settings-atoms.ts`
- Create: `apps/web/src/lib/use-general-settings.ts`
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`

- [ ] **Step 1: 新增 atom**

把 `apps/web/src/atoms/settings-atoms.ts` 全文改为：
```ts
import { atom } from 'jotai'
import { GENERAL_SETTINGS_DEFAULTS, type GeneralSettings } from '@lume/shared'
import type { SettingsTab } from './tab-atoms'

export const settingsActiveTabAtom = atom<SettingsTab>('channel')

/** 全局通用设置；在 Agent 视图启动时加载一次，渲染层据此决定显示模式。 */
export const generalSettingsAtom = atom<GeneralSettings>(GENERAL_SETTINGS_DEFAULTS)
```

- [ ] **Step 2: 新建 bootstrap hook**

创建 `apps/web/src/lib/use-general-settings.ts`：
```ts
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { generalSettingsAtom } from '@/atoms'
import { getGeneralSettings } from '@/lib/desktop-api'

let bootstrapped = false

/** 加载通用设置到全局 atom，每个 session 仅执行一次。 */
export function useBootstrapGeneralSettings() {
  const setGeneralSettings = useSetAtom(generalSettingsAtom)

  useEffect(() => {
    if (bootstrapped) return
    bootstrapped = true
    getGeneralSettings()
      .then((settings) => setGeneralSettings(settings))
      .catch((error) => console.error('[generalSettings] 加载失败:', error))
  }, [setGeneralSettings])
}
```

- [ ] **Step 3: 在 AgentMessages 启动时调用**

在 `apps/web/src/components/agent/AgentMessages.tsx` 顶部 import 区增加：
```ts
import { useBootstrapGeneralSettings } from '@/lib/use-general-settings'
```
在 `AgentMessages` 组件函数体靠前位置（其它 `useEffect` 之前）增加一行：
```ts
  useBootstrapGeneralSettings()
```

- [ ] **Step 4: 类型检查**

Run: `bun run --filter @lume/web typecheck`
Expected: 通过。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/atoms/settings-atoms.ts apps/web/src/lib/use-general-settings.ts apps/web/src/components/agent/AgentMessages.tsx
git commit -m "feat(web): 新增 generalSettingsAtom 并在启动时加载"
```

---

## Task 5: 投影层 — 工具调用耗时 `durationMs`

**Files:**
- Modify: `apps/web/src/components/agent/runtime-message-view.ts:3-13`
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts:157-210`

- [ ] **Step 1: 扩展 RuntimeToolCallView**

在 `apps/web/src/components/agent/runtime-message-view.ts` 的 `RuntimeToolCallView`（L3-13）增加两个可选字段：
```ts
export interface RuntimeToolCallView {
  id: string
  toolName: string
  input: unknown
  status: 'running' | 'completed' | 'failed'
  output?: unknown
  isError?: boolean
  permissionState?: 'timeout'
  subagentRunId?: string
  subagentStatus?: 'running' | 'completed' | 'errored'
  startedAt?: string
  durationMs?: number
}
```

- [ ] **Step 2: 投影 — tool.started 记录 startedAt**

在 `apps/web/src/components/agent/runtime-event-message-projection.ts` 的 `tool.started` 分支（L157-170），把构造的 `toolCall` 对象增加 `startedAt`：
```ts
      const toolCall: RuntimeToolCallView = {
        id: event.toolCallId,
        toolName: event.toolName,
        input: event.inputPreview ?? {},
        status: 'running',
        startedAt: event.createdAt,
      }
```

- [ ] **Step 3: 投影 — tool.completed/failed 计算 durationMs**

在 `tool.completed || tool.failed` 分支（L172-194）的 `toolCall` 对象中，增加 `startedAt` 与 `durationMs`（在 `input` 行之后、`status` 行之前插入两行）：
```ts
      const toolCall: RuntimeToolCallView = {
        id: event.toolCallId,
        toolName: event.toolName ?? existing?.toolName ?? event.toolCallId,
        input: existing?.input ?? {},
        startedAt: existing?.startedAt ?? event.createdAt,
        durationMs: computeDurationMs(existing?.startedAt, event.createdAt),
        status: isError ? 'failed' : 'completed',
        output: isError ? event.error.message : event.resultPreview,
        isError,
        ...(permissionState ? { permissionState } : {}),
        ...(existing?.subagentRunId ? { subagentRunId: existing.subagentRunId } : {}),
        ...(existing?.toolName === 'Agent' || event.toolName === 'Agent'
          ? { subagentStatus: isError ? 'errored' as const : 'completed' as const }
          : existing?.subagentStatus ? { subagentStatus: existing.subagentStatus } : {}),
      }
```

- [ ] **Step 4: 投影 — tool.permission_timeout 同样记录**

在 `tool.permission_timeout` 分支（L196-210）的 `toolCall` 对象中增加 `startedAt` 与 `durationMs`：
```ts
      const toolCall: RuntimeToolCallView = {
        id: event.toolCallId,
        toolName: event.toolName ?? existing?.toolName ?? event.toolCallId,
        input: existing?.input ?? {},
        startedAt: existing?.startedAt ?? event.createdAt,
        durationMs: computeDurationMs(existing?.startedAt, event.createdAt),
        status: 'failed',
        output: event.message,
        isError: true,
        permissionState: 'timeout',
      }
```

- [ ] **Step 5: 新增纯函数 computeDurationMs**

在 `runtime-event-message-projection.ts` 顶部辅助函数区（例如 `isToolPermissionTimeoutMessage` 函数附近，L243 之后）增加：
```ts
function computeDurationMs(startedAt: string | undefined, endedAt: string): number | undefined {
  if (!startedAt) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined
  return Math.max(0, end - start)
}
```

> 说明：投影是纯函数（不调用 `Date.now()`），仅解析两个 ISO 时间戳字符串，可安全在流式重算中执行。运行中的工具的「已用时间」由渲染层（Task 7）用 `now - Date.parse(startedAt)` 计算。

- [ ] **Step 6: 类型检查**

Run: `bun run --filter @lume/web typecheck`
Expected: 通过。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/components/agent/runtime-message-view.ts apps/web/src/components/agent/runtime-event-message-projection.ts
git commit -m "feat(web): 工具调用视图补充 startedAt 与 durationMs"
```

---

## Task 6: 纯函数 — blocks 分组

**Files:**
- Create: `apps/web/src/components/agent/minimal-assistant-grouping.ts`

- [ ] **Step 1: 新建分组函数**

创建 `apps/web/src/components/agent/minimal-assistant-grouping.ts`：
```ts
import type { RuntimeAssistantBlock } from './runtime-message-view'

/**
 * 极简模式分组：相邻的 thinking / tool_call 合并成一个 process 段；
 * text / plan_preview 等保持原位作为 inline 段。保留 blocks 原顺序。
 */
export type AssistantSegment =
  | { kind: 'inline'; block: RuntimeAssistantBlock }
  | { kind: 'process'; blocks: RuntimeAssistantBlock[] }

export function groupAssistantBlocksForMinimal(blocks: RuntimeAssistantBlock[]): AssistantSegment[] {
  const segments: AssistantSegment[] = []
  let buffer: RuntimeAssistantBlock[] = []

  const flush = () => {
    if (buffer.length > 0) {
      segments.push({ kind: 'process', blocks: buffer })
      buffer = []
    }
  }

  for (const block of blocks) {
    if (block.type === 'thinking' || block.type === 'tool_call') {
      buffer.push(block)
    } else {
      flush()
      segments.push({ kind: 'inline', block })
    }
  }
  flush()
  return segments
}
```

- [ ] **Step 2: 类型检查**

Run: `bun run --filter @lume/web typecheck`
Expected: 通过。

- [ ] **Step 3: 手动核对边界（无测试框架，逐条确认）**

对照确认：
- `[text]` → 1 个 inline 段，0 个 process 段。
- `[tool_call]` → 1 个 process 段。
- `[text, tool_call, text]` → inline, process, inline（共 3 段）。
- `[tool_call, tool_call, text, tool_call]` → process(2), inline, process(1)。
- `[plan_preview, tool_call]` → inline, process。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/agent/minimal-assistant-grouping.ts
git commit -m "feat(web): 新增极简模式 blocks 分组纯函数"
```

---

## Task 7: 极简渲染组件 + 分支 + 工具耗时标签

**Files:**
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`

> 本任务在同一文件内新增 `MinimalAssistantContent` 与 `MinimalProcessGroup`（复用该文件内部已有的 `SmoothText` / `PlanPreviewCard` / `RuntimeEventToolCallBlock` / `RuntimeEventThinkingBlock`，无需导出、无循环依赖），并在 assistant 渲染处按设置分支。

- [ ] **Step 1: 顶部 import 补充**

在 `RuntimeEventContentBlock.tsx` 的 import 区确保有以下（若已存在则跳过对应行）。其中 `useState` / `useEffect` / `cn` / `ChevronDown` 该文件已在用，通常只需补 `useMemo`：
```ts
import { useMemo } from 'react'        // 若该文件尚未导入 useMemo
import { useAtomValue } from 'jotai'   // 若尚未导入 jotai
import { generalSettingsAtom } from '@/atoms'
import { groupAssistantBlocksForMinimal } from './minimal-assistant-grouping'
```

- [ ] **Step 2: 新增耗时格式化函数**

在 `summarizeInput` 函数（L1627）附近新增：
```ts
function formatDurationLabel(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const totalSec = Math.floor(s)
  const mm = Math.floor(totalSec / 60)
  const ss = totalSec % 60
  if (s < 3600) return `${mm}:${String(ss).padStart(2, '0')}`
  const hh = Math.floor(mm / 60)
  return `${hh}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}
```

- [ ] **Step 3: 给 RuntimeEventToolCallBlock 头部加耗时标签**

在 `RuntimeEventToolCallBlock`（L1104 起）的 header `<button>` 内，状态徽章 `<span>`（L1123-1130）之后、`summarizeInput` 那个 `<span>`（L1131）之前，插入：
```tsx
        {typeof toolCall.durationMs === 'number' && toolCall.durationMs > 0 && (
          <span className="tabular-nums text-[11px] font-medium text-[#9aa0a6]">
            {formatDurationLabel(toolCall.durationMs)}
          </span>
        )}
```

> 说明：该标签在两种模式下都会出现（只要有 durationMs）。这是对明细模式的轻微增强，保持组件单一实现（DRY）。

- [ ] **Step 4: 新增 MinimalProcessGroup 组件**

在 `RuntimeEventContentBlock.tsx` 中（建议放在 `RuntimeEventAssistantBlockItem` 函数之后，L542 附近）新增：
```tsx
function MinimalProcessGroup({
  blocks,
  threadId,
  isStreamingMessage,
  onOpenThreadFile,
  onUserResizeStart,
}: {
  blocks: RuntimeAssistantBlock[]
  threadId: string
  isStreamingMessage: boolean
  onOpenThreadFile?: (path: string) => void
  onUserResizeStart?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const toolCalls = blocks
    .filter((b): b is Extract<RuntimeAssistantBlock, { type: 'tool_call' }> => b.type === 'tool_call')
    .map((b) => b.toolCall)
  const subagentCount = toolCalls.filter((tc) => tc.toolName === 'Agent').length
  const nonAgentCount = toolCalls.length - subagentCount
  const failedCount = toolCalls.filter((tc) => tc.status === 'failed').length
  const completedCount = toolCalls.filter((tc) => tc.status !== 'running').length
  const runningTool = toolCalls.find((tc) => tc.status === 'running')
  const hasRunning = isStreamingMessage && Boolean(runningTool)

  useEffect(() => {
    if (!hasRunning) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [hasRunning])

  const completedDurationMs = toolCalls.reduce(
    (sum, tc) => sum + (typeof tc.durationMs === 'number' ? tc.durationMs : 0),
    0,
  )
  const runningElapsedMs = hasRunning && runningTool?.startedAt
    ? Math.max(0, now - Date.parse(runningTool.startedAt))
    : 0
  const totalDurationMs = completedDurationMs + runningElapsedMs

  const parts: string[] = []
  if (hasRunning && runningTool) {
    parts.push(`● 正在执行 ${runningTool.toolName}`)
    parts.push(`已完成 ${completedCount} 步`)
  } else {
    parts.push(failedCount > 0 ? `⚠️ 🔧 ${nonAgentCount} 操作 · ${failedCount} 失败` : `🔧 ${nonAgentCount} 操作`)
    if (subagentCount > 0) parts.push(`🤖 ${subagentCount} 子代理`)
  }
  if (totalDurationMs > 0) {
    const seconds = totalDurationMs / 1000
    const label = seconds < 60
      ? `${seconds.toFixed(hasRunning ? 0 : 1)}s`
      : formatDurationLabel(totalDurationMs)
    parts.push(`⏱ ${label}`)
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-1.5 text-[11.5px] text-foreground/40 transition-colors hover:text-foreground/60"
      >
        <ChevronDown size={12} className={cn('transition-transform', expanded && 'rotate-180')} />
        <span className="tabular-nums">{parts.join(' · ')}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 pl-1">
          {blocks.map((block) => {
            if (block.type === 'thinking') {
              return <RuntimeEventThinkingBlock key={block.id} text={block.text} active={false} />
            }
            if (block.type === 'tool_call') {
              return (
                <RuntimeEventToolCallBlock
                  key={block.id}
                  toolCall={block.toolCall}
                  threadId={threadId}
                  onUserResizeStart={onUserResizeStart}
                />
              )
            }
            return null
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: 新增 MinimalAssistantContent 组件**

紧接 `MinimalProcessGroup` 之后新增：
```tsx
function MinimalAssistantContent({
  blocks,
  threadId,
  isStreamingMessage,
  onOpenThreadFile,
  onUserResizeStart,
}: {
  blocks: RuntimeAssistantBlock[]
  threadId: string
  isStreamingMessage: boolean
  onOpenThreadFile?: (path: string) => void
  onUserResizeStart?: () => void
}) {
  const segments = useMemo(() => groupAssistantBlocksForMinimal(blocks), [blocks])

  return (
    <>
      {segments.map((segment) => {
        if (segment.kind === 'inline') {
          const block = segment.block
          if (block.type === 'text') {
            return (
              <SmoothText
                key={block.id}
                text={block.text}
                isStreaming={isStreamingMessage}
                onOpenThreadFile={onOpenThreadFile}
              />
            )
          }
          if (block.type === 'plan_preview') {
            return <PlanPreviewCard key={block.id} preview={block.preview} onOpenThreadFile={onOpenThreadFile} />
          }
          return null
        }
        return (
          <MinimalProcessGroup
            key={`process:${segment.blocks[0]?.id ?? 'empty'}`}
            blocks={segment.blocks}
            threadId={threadId}
            isStreamingMessage={isStreamingMessage}
            onOpenThreadFile={onOpenThreadFile}
            onUserResizeStart={onUserResizeStart}
          />
        )
      })}
    </>
  )
}
```

> 验证 `SmoothText` / `PlanPreviewCard` 的 props 与现有调用点（L516、L524）一致；若 typecheck 报缺 prop，按 `RuntimeEventAssistantBlockItem` 内的用法对齐。

- [ ] **Step 6: 在 assistant 渲染处按设置分支**

在 `RuntimeEventContentBlock`（L98-138 区域）：

1) 在 `const contentBlocks = ...`（L99）之后增加读取设置：
```ts
  const useMinimalMode = useAtomValue(generalSettingsAtom).agentMessageDisplayMode === 'minimal'
```

2) 把当前的 `contentBlocks.filter(...).map(...)` 块（L123-138）替换为分支：
```tsx
        {useMinimalMode ? (
          <MinimalAssistantContent
            blocks={contentBlocks.filter((b) => b.type !== 'memory_context_used')}
            threadId={threadId}
            isStreamingMessage={streaming === true && message.status === 'streaming'}
            onOpenThreadFile={onOpenThreadFile}
            onUserResizeStart={onUserResizeStart}
          />
        ) : (
          contentBlocks
            .filter((block) => block.type !== 'memory_context_used')
            .map((block, index) => (
              <RuntimeEventAssistantBlockItem
                key={block.id}
                block={block}
                threadId={threadId}
                onOpenThreadFile={onOpenThreadFile}
                onUserResizeStart={onUserResizeStart}
                isStreaming={block.type === 'text' && block.id === activeStreamingTextBlockId}
                isActiveThinking={block.type === 'thinking'
                  && streaming === true
                  && message.status === 'streaming'
                  && index === contentBlocks.length - 1}
              />
            ))
        )}
```
（其后的 `latestTaskProgressBlock` / `showIdleStatus` / `message.error` / `AssistantMessageFooter` / `imDelivery` 保持不变，两种模式共用。）

- [ ] **Step 7: 类型检查 + 构建**

Run: `bun run --filter @lume/web typecheck`
Expected: 通过。

Run: `bun run --filter @lume/web build`
Expected: 构建成功（`tsc --noEmit && vite build`）。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/agent/RuntimeEventContentBlock.tsx
git commit -m "feat(web): agent 消息极简显示模式渲染"
```

---

## Task 8: 外观设置 UI — [极简 / 明细] 开关

**Files:**
- Create: `apps/web/src/components/settings/AppearanceSettings.tsx`
- Modify: `apps/web/src/components/settings/SettingsView.tsx:10,25-30,92-97`

- [ ] **Step 1: 新建 AppearanceSettings 组件**

创建 `apps/web/src/components/settings/AppearanceSettings.tsx`：
```tsx
import * as React from 'react'
import { useAtom } from 'jotai'
import { toast } from 'sonner'
import type { AgentMessageDisplayMode } from '@lume/shared'
import { updateGeneralSettings } from '@/lib/desktop-api'
import { generalSettingsAtom } from '@/atoms'
import { cn } from '@/lib/utils'

const DISPLAY_MODE_OPTIONS: Array<{ value: AgentMessageDisplayMode; label: string; desc: string }> = [
  { value: 'minimal', label: '极简', desc: '只显示文字结论，过程收进可展开的一行' },
  { value: 'verbose', label: '明细', desc: '每个工具/思考/子代理独立折叠展示' },
]

export function AppearanceSettings() {
  const [settings, setSettings] = useAtom(generalSettingsAtom)
  const [saving, setSaving] = React.useState(false)

  const handleChange = async (mode: AgentMessageDisplayMode) => {
    if (mode === settings.agentMessageDisplayMode || saving) return
    setSaving(true)
    try {
      const saved = await updateGeneralSettings({ agentMessageDisplayMode: mode })
      setSettings(saved)
      toast.success('外观设置已保存')
    } catch (error) {
      console.error('[AppearanceSettings] 保存失败:', error)
      toast.error('保存外观设置失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-1)] px-5 py-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <h2 className="mb-3 text-[16px] font-semibold leading-6 text-[var(--text-1)]">Agent 消息显示</h2>
      <div className="flex min-h-[48px] items-center justify-between gap-5 py-2">
        <div className="min-w-0">
          <div className="text-[13px] font-medium leading-5 text-[var(--text-2)]">显示方式</div>
          <div className="mt-0.5 text-[12px] leading-4 text-[var(--text-3)]">
            控制 agent 回合中工具调用 / 思考 / 子代理的展示密度
          </div>
        </div>
        <div className="grid h-9 w-[220px] grid-cols-2 rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] p-0.5">
          {DISPLAY_MODE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => void handleChange(option.value)}
              disabled={saving}
              title={option.desc}
              className={cn(
                'inline-flex items-center justify-center rounded-[6px] text-[13px] font-medium transition-colors disabled:opacity-60',
                settings.agentMessageDisplayMode === option.value
                  ? 'border border-[color-mix(in_oklab,var(--brand)_40%,var(--border-strong))] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                  : 'text-[var(--text-2)] hover:bg-[var(--surface-2)]',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: SettingsView 接入**

在 `apps/web/src/components/settings/SettingsView.tsx`：

1) import 区（L10 附近）增加：
```ts
import { AppearanceSettings } from './AppearanceSettings'
```

2) 把 appearance 占位符（L92-97）：
```tsx
          {tab === 'appearance' && (
            <SettingsPlaceholder
              title="外观"
              desc="外观配置仍沿用现有主题系统，后续可以在这里承载深浅色与显示密度。"
            />
          )}
```
替换为：
```tsx
          {tab === 'appearance' && <AppearanceSettings />}
```

> `SettingsPlaceholder` 若此后不再被其它 tab 使用则保留（`shortcuts` tab 仍在用，L105-110），不要删除。

- [ ] **Step 3: 类型检查 + 构建**

Run: `bun run --filter @lume/web typecheck`
Expected: 通过。

Run: `bun run --filter @lume/web build`
Expected: 构建成功。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/settings/AppearanceSettings.tsx apps/web/src/components/settings/SettingsView.tsx
git commit -m "feat(web): 外观设置新增 Agent 消息显示方式开关"
```

---

## Task 9: 全量验证 + 手动核对

**Files:** 无（验证任务）

- [ ] **Step 1: 全量类型检查**

Run: `bun run typecheck`
Expected: shared / ui / sidecar / cli / web 全部通过，无错误。

- [ ] **Step 2: 构建 web**

Run: `bun run --filter @lume/web build`
Expected: 成功。

- [ ] **Step 3: 手动核对（启动应用 `bun run dev`）**

按以下清单在 Agent 视图逐项确认：

1. **默认值**：全新状态下，agent 消息以极简模式显示（过程收进一行）。设置 → 外观 → 显示方式默认选中「极简」。
2. **切换持久化**：切到「明细」→ 刷新/重启 → 仍为「明细」；切回「极简」同样持久。
3. **分组**：`[文字][工具×N][文字]` 的回合，两段文字主色内联、中间过程收成一条次要色行。
4. **过程行内容**：折叠态显示 `🔧 N 操作 · 🤖 M 子代理 · ⏱ 总时长`；N = 非 Agent 工具数，M = Agent 子代理数。
5. **运行中**：agent 工作时过程行显示 `● 正在执行 <toolName> · 已完成 K 步 · ⏱ 12s`，秒数每秒上跳；**不出现 X/Y 总数**。
6. **展开**：点箭头展开 → 列出思考行 + 每条工具行（带 `0.4s` 等单条耗时）；点工具行 ▸ 展开该工具完整结果（复用现有渲染）。
7. **失败**：若有工具失败，折叠态过程行显示 `⚠️ 🔧 N 操作 · K 失败`；展开后失败工具高亮（沿用现有 failed 样式）。
8. **明细模式回归**：切到「明细」，渲染与改动前完全一致（每个块独立折叠，无回归）。
9. **tabular-nums**：⏱ 数字跳动时宽度不抖动。

- [ ] **Step 4: 最终提交（如有手动核对中发现并修复的小问题）**

若 Step 3 发现并修复了问题，提交修复；否则跳过。

---

## 设计决策备注

- **极简为新默认**：`GENERAL_SETTINGS_DEFAULTS.agentMessageDisplayMode = "minimal"`。老用户若无该字段，sidecar `sanitizeGeneralSettings` 回退到 `"minimal"`（即也会被「升级」为极简）。若产品上希望保留老用户原明细体验，可将 sanitize 的回退默认改为读取缺失时用 `"verbose"`——此处按「极简为新默认」实现，需产品确认。
- **过程行用次要色 `text-foreground/40`**（与现有「思考过程」折叠行一致），无胶囊边框，`ChevronDown` 箭头展开/收起，整行可点。
- **展开明细复用现有组件**：`RuntimeEventToolCallBlock` / `RuntimeEventThinkingBlock`，DRY；展开行视觉为现有卡片样式（非 mockup 中的扁平行），如后续需扁平化可再做视觉打磨。
- **耗时标签同时出现在明细模式**：`RuntimeEventToolCallBlock` 头部在有 `durationMs` 时显示，两种模式共用，属轻微增强。

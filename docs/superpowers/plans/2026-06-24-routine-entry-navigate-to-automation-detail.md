# 日程条目点击跳转自动化任务详情 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 日程（Routine）里点击已完成的条目，不再弹窗显示执行结果，而是跳转到该条目对应的自动化任务详情页（`AutomationJobDetail`）。

**Architecture:** 新增一个 `pendingAutomationJobIdAtom` 作为跨视图"预选任务"的通道：`RoutinePanel` 在点击时写入该 atom 并切换到 automation tab；`AutomationManagementView` 挂载时消费该 atom（设入本地 `selectedJobId` 并清空），从而显示对应任务详情。tab 操作复用既有 `upsertTab` + `tabsAtom`/`activeTabIdAtom` 模式，封装成纯函数 `openAutomationJobDetail`（与既有 `openAutomationRunReplay` 同范式、可单测）。弹窗（Dialog）及其 state 彻底移除。纯前端改动，后端零改动。

**Tech Stack:** React 18 + Jotai（atoms）+ Tailwind + bun:test。无 URL 路由，导航靠 `tabsAtom`/`activeTabIdAtom`。

## Requirements（已确认的决策，作为本计划的需求基准）

- 日程条目（completed 且有 `result.summary`）的**卡片点击**：从"弹窗显示结果"改为"跳转到该自动化任务详情"。
- **彻底移除弹窗**：删除 `RoutinePanel` 里的 Dialog 组件、`resultEntry`/`resultOpen` state 及相关 import。
- `failed` 条目点击仍走 `onTrigger`（重试），**不变**。
- `RoutineEntryItem` 内的**就地展开结果块**（`ChevronDown/Up` 那个，带 `stopPropagation`）**保留**——它不是弹窗。
- 缺失 `automationJobId` 的条目（理论上的边界）：点击 no-op（不弹窗、不跳转）。
- `AutomationManagementView` 从侧栏正常打开时仍显示列表（仅当 `pendingAutomationJobIdAtom` 被写入时才预选任务）。
- **不要动** `AutomationManagementView.tsx:1028-1058` 的"运行历史 → 只读回放 tab"交互（`handleOpenRunReplay`），那是另一个特性。

## Global Constraints

- 测试运行器 `bun:test`（非 vitest/jest）。单测：`cd apps/web && bun test <path>`；项目按**单文件**跑测试。
- 路径别名 `@/*` → `apps/web/src/*`。但 `RoutinePanel.tsx`/`RoutineEntryItem.tsx` 既有风格是**相对路径**（`../../`、`../`），新增 import 沿用相对路径以匹配文件风格。
- 类型检查：`cd apps/web && bun run typecheck`。
- 后端（`apps/sidecar`、`packages/sdk`）**零改动**。
- 提交风格：`<emoji> <type>(<scope>): <中文描述>`。
- 遵循项目 CLAUDE.md：仅改动与请求直接相关的行；匹配既有风格。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `apps/web/src/atoms/automation-atoms.ts` | 自动化相关 atoms | 修改：加 `pendingAutomationJobIdAtom` |
| `apps/web/src/components/automation/automation-run-replay.ts` | 自动化 tab 导航纯函数（含既有 `openAutomationRunReplay`） | 修改：加 `openAutomationJobDetail` |
| `apps/web/src/components/automation/automation-run-replay.test.ts` | 上述纯函数单测 | 修改：加 `openAutomationJobDetail` 用例 |
| `apps/web/src/components/automation/AutomationManagementView.tsx` | 自动化管理视图 | 修改：挂载时消费 `pendingAutomationJobIdAtom` |
| `apps/web/src/components/routine/RoutinePanel.tsx` | 日程面板 | 修改：点击跳转、移除 Dialog |

---

## Task 1: pendingAutomationJobIdAtom + openAutomationJobDetail 纯函数 + 单测

**Files:**
- Modify: `apps/web/src/atoms/automation-atoms.ts`
- Modify: `apps/web/src/components/automation/automation-run-replay.ts`
- Modify: `apps/web/src/components/automation/automation-run-replay.test.ts`

**Interfaces:**
- Produces:
  - `pendingAutomationJobIdAtom: WritableAtom<string | null>` — 默认 `null`；外部写入要预选的 jobId，`AutomationManagementView` 消费后清空。
  - `openAutomationJobDetail(jobId: string, tabs: Tab[]): { tabs: Tab[]; activeTabId: string; selectedJobId: string }` — 纯函数：upsert `__automation__` tab、返回新 tabs、激活 tabId、回传要预选的 jobId。

- [ ] **Step 1: 写失败测试（在 `automation-run-replay.test.ts` 末尾追加）**

在 `apps/web/src/components/automation/automation-run-replay.test.ts` 顶部的 import 行，把：
```ts
import { formatRunTime, buildAutomationRunReplayTab, openAutomationRunReplay } from './automation-run-replay'
```
改为：
```ts
import { formatRunTime, buildAutomationRunReplayTab, openAutomationRunReplay, openAutomationJobDetail } from './automation-run-replay'
```
并在文件末尾追加：
```ts
describe('openAutomationJobDetail', () => {
  test('upserts the __automation__ tab, activates it, and echoes the jobId to preselect', () => {
    const existing = [{ id: 'other', type: 'agent' as const, title: '其它', threadId: 'other' }]
    const result = openAutomationJobDetail('job-42', existing)
    expect(result.activeTabId).toBe('__automation__')
    expect(result.selectedJobId).toBe('job-42')
    expect(result.tabs).toHaveLength(2)
    expect(result.tabs.find((t) => t.id === '__automation__')).toEqual({
      id: '__automation__',
      type: 'automation',
      title: '自动化',
    })
  })

  test('does not duplicate the __automation__ tab if it already exists', () => {
    const existing = [{ id: '__automation__', type: 'automation' as const, title: '自动化' }]
    const result = openAutomationJobDetail('job-42', existing)
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0].id).toBe('__automation__')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd apps/web && bun test src/components/automation/automation-run-replay.test.ts`
Expected: FAIL — `openAutomationJobDetail is not defined`（尚未实现；忽略既有的 `[DEPRECATED] atomFamily` jotai 警告，那是导入噪音）。

- [ ] **Step 3: 加 `pendingAutomationJobIdAtom`**

修改 `apps/web/src/atoms/automation-atoms.ts`，在文件末尾追加：
```ts
/**
 * 跨视图"预选自动化任务"通道。
 * 外部视图（如日程）写入要跳转的 jobId；AutomationManagementView 挂载时消费并清空。
 */
export const pendingAutomationJobIdAtom = atom<string | null>(null)
```

- [ ] **Step 4: 实现 `openAutomationJobDetail`**

在 `apps/web/src/components/automation/automation-run-replay.ts` 末尾（`openAutomationRunReplay` 之后）追加：
```ts
/** 打开自动化管理 tab 并预选某个任务详情：返回应写入的 tabs、激活的 tabId 与要预选的 jobId。 */
export function openAutomationJobDetail(
  jobId: string,
  tabs: Tab[],
): { tabs: Tab[]; activeTabId: string; selectedJobId: string } {
  const automationTab: Tab = { id: '__automation__', type: 'automation', title: '自动化' }
  return {
    tabs: upsertTab(tabs, automationTab),
    activeTabId: '__automation__',
    selectedJobId: jobId,
  }
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `cd apps/web && bun test src/components/automation/automation-run-replay.test.ts`
Expected: PASS（既有 6 个 + 新增 2 个 = 8 个全过）。

- [ ] **Step 6: 类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 无新增错误。

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/atoms/automation-atoms.ts \
        apps/web/src/components/automation/automation-run-replay.ts \
        apps/web/src/components/automation/automation-run-replay.test.ts
git commit -m "✨ feat(web): 新增日程跳转自动化任务详情的 atom 与纯函数"
```

---

## Task 2: AutomationManagementView 挂载时消费 pendingAutomationJobIdAtom

**Files:**
- Modify: `apps/web/src/components/automation/AutomationManagementView.tsx`

**Interfaces:**
- Consumes: `pendingAutomationJobIdAtom`（Task 1 产出）
- Produces: `AutomationManagementView` 在挂载时若发现 `pendingAutomationJobIdAtom` 非 null，则把它写入本地 `selectedJobId` 并清空 atom；既有 `selectedJobId` useState、`onSelect`、`onBack`、runs 加载 effect 全部不变。

**说明：** 这是接线任务。`AutomationManagementView` 是 1590 行且当前无测试的重型组件，渲染测试脆弱（与既有代码库范式一致：逻辑放纯函数测试、组件接线靠 typecheck + 手动）。消费逻辑本身极简（一个 effect），其正确性由 Task 1 的纯函数测试 + Task 3 的端到端手动验收覆盖。

- [ ] **Step 1: 扩展 automation-atoms import**

修改 `apps/web/src/components/automation/AutomationManagementView.tsx:40`，把：
```ts
import { automationJobsAtom, automationRunsAtom } from '@/atoms/automation-atoms'
```
改为：
```ts
import { automationJobsAtom, automationRunsAtom, pendingAutomationJobIdAtom } from '@/atoms/automation-atoms'
```

- [ ] **Step 2: 加消费 atom 的 hooks 与 effect**

在 `apps/web/src/components/automation/AutomationManagementView.tsx` 中，紧接 `const [listTab, setListTab] = useState<AutomationListTab>('manual')`（约 `:225`）之后、`const selectedJob = useMemo(...)`（约 `:227`）之前，插入：
```ts
  const pendingJobId = useAtomValue(pendingAutomationJobIdAtom)
  const clearPendingJobId = useSetAtom(pendingAutomationJobIdAtom)

  useEffect(() => {
    if (!pendingJobId) return
    setSelectedJobId(pendingJobId)
    clearPendingJobId(null)
  }, [pendingJobId, clearPendingJobId])
```

> 说明：`useAtomValue`/`useSetAtom` 已在 `:2` 从 jotai 导入；`useEffect` 已在 `:1` 导入；`setSelectedJobId` 来自既有 `:223` 的 `useState`。既有 runs 加载 effect（`:239` 起，依赖 `selectedJobId`）会在 `selectedJobId` 被设入后自动拉取该任务的运行记录。

- [ ] **Step 3: 类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 无新增错误。

- [ ] **Step 4: 提交**

```bash
git add apps/web/src/components/automation/AutomationManagementView.tsx
git commit -m "✨ feat(web): AutomationManagementView 挂载时消费预选任务 atom"
```

---

## Task 3: RoutinePanel 点击跳转 + 移除弹窗

**Files:**
- Modify: `apps/web/src/components/routine/RoutinePanel.tsx`

**Interfaces:**
- Consumes: `openAutomationJobDetail`（Task 1）、`pendingAutomationJobIdAtom`（Task 1）、`tabsAtom`/`activeTabIdAtom`（既有）、`AutomationManagementView` 的消费能力（Task 2）。
- Produces: 日程已完成条目卡片点击 → 跳转 automation tab 并预选该任务详情；弹窗彻底移除。

**说明：** 接线任务，组件无既有测试且含异步加载，按代码库范式靠 typecheck + 手动验收。跳转的核心逻辑在 Task 1 已测的 `openAutomationJobDetail`。

- [ ] **Step 1: 调整 imports**

1.1 在 `apps/web/src/components/routine/RoutinePanel.tsx:1` 的 react import 之后新增一行：
```ts
import { useAtomValue, useSetAtom } from "jotai"
```

1.2 在 `:14` 的 `from "../../lib/desktop-api/routine"` 之后新增三行（匹配文件相对路径风格）：
```ts
import { tabsAtom, activeTabIdAtom } from "../../atoms"
import { pendingAutomationJobIdAtom } from "../../atoms/automation-atoms"
import { openAutomationJobDetail } from "../automation/automation-run-replay"
```

1.3 删除 `:16-22` 的整个 Dialog import 块：
```ts
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog"
```

1.4 从 `:3-13` 的 lucide-react import 中删除 `CheckCircle2,` 一行（删除弹窗后不再使用）。

- [ ] **Step 2: 删除弹窗相关 state**

删除 `apps/web/src/components/routine/RoutinePanel.tsx:38-39` 这两行：
```ts
  const [resultEntry, setResultEntry] = useState<RoutineEntry | null>(null)
  const [resultOpen, setResultOpen] = useState(false)
```

- [ ] **Step 3: 加 atom hooks**

在 `RoutinePanel` 组件内、既有 state 声明区（例如紧接 `const [hasNext, setHasNext] = useState(false)` 即原 `:41` 之后）新增：
```ts
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setPendingJobId = useSetAtom(pendingAutomationJobIdAtom)
```

- [ ] **Step 4: 重写 handleViewResult 为跳转**

把 `apps/web/src/components/routine/RoutinePanel.tsx:109-112` 的：
```ts
  const handleViewResult = useCallback((entry: RoutineEntry) => {
    setResultEntry(entry)
    setResultOpen(true)
  }, [])
```
替换为：
```ts
  const handleViewResult = useCallback((entry: RoutineEntry) => {
    if (!entry.automationJobId) return
    const result = openAutomationJobDetail(entry.automationJobId, tabs)
    setTabs(result.tabs)
    setActiveTabId(result.activeTabId)
    setPendingJobId(result.selectedJobId)
  }, [tabs, setTabs, setActiveTabId, setPendingJobId])
```

- [ ] **Step 5: 删除弹窗 JSX**

删除 `apps/web/src/components/routine/RoutinePanel.tsx:240-257` 的整段（含外层守卫）：
```tsx
      {resultEntry && (
        <Dialog open={resultOpen} onOpenChange={setResultOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckCircle2 size={16} className="text-emerald-500" />
                执行结果
              </DialogTitle>
              <DialogDescription>
                {resultEntry.customName ?? resultEntry.activity}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto rounded-xl border bg-[var(--reading-panel)] px-4 py-3 text-[13px] leading-6 text-[var(--text-2)] whitespace-pre-wrap">
              {resultEntry.result?.summary}
            </div>
          </DialogContent>
        </Dialog>
      )}
```

- [ ] **Step 6: 类型检查**

Run: `cd apps/web && bun run typecheck`
Expected: 无新增错误（确认 `resultEntry`/`resultOpen`/`Dialog*`/`CheckCircle2` 均无残留引用）。

- [ ] **Step 7: 手动验收（对应需求决策）**

运行应用（项目 `run` 方式或 `cd apps/web && bun run dev` + Tauri 壳），逐一核对：

1. 进入「读书」→ routine 子 tab → 对一个**已完成且有结果**的日程条目**点击卡片** → 跳转到「自动化」tab，并直接展示该条目对应自动化任务的**详情页**（`AutomationJobDetail`，右侧运行历史可见）。
2. 该详情页就是 `entry.automationJobId` 对应的任务（可通过任务名/配置核对）。
3. 点击后**不再出现任何弹窗**。
4. `RoutineEntryItem` 内的**就地展开结果**（`ChevronDown` 按钮）仍可独立展开/收起，且点击它**不会**触发跳转（`stopPropagation` 仍生效）。
5. `failed` 条目点击仍是**重试**（不跳转）。
6. 从侧栏正常打开「自动化」→ 仍显示**任务列表**（不是某个详情），即 `pendingAutomationJobIdAtom` 的预选只在跳转时生效、不会污染正常入口。
7. 既有的"自动化运行历史 → 只读回放 tab"交互（另一特性）不受影响。

如某项在当前环境无法手动验证（如无真实日程数据），明确记录"未验证项"与原因，**不要**谎报通过。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/routine/RoutinePanel.tsx
git commit -m "✨ feat(web): 日程条目点击跳转自动化任务详情，移除执行结果弹窗"
```

---

## Self-Review（计划自检）

**1. 需求覆盖**：逐条对照 Requirements：
- 卡片点击跳转详情（不再弹窗）→ Task 3 Step 4/5 ✓
- 彻底移除弹窗（Dialog + state + import）→ Task 3 Step 1.3/1.4/2/5 ✓
- `failed` 不变（仍 onTrigger）→ RoutineEntryItem 未改，Task 3 不涉及 ✓（Step 7.5 验收）
- 就地展开块保留 → RoutineEntryItem 未改 ✓（Step 7.4 验收）
- 缺失 automationJobId → no-op → Task 3 Step 4 `if (!entry.automationJobId) return` ✓
- 正常打开仍显示列表 → Task 2 pending 仅挂载消费、fresh open 时 atom 为 null ✓（Step 7.6 验收）
- 不动运行历史回放交互 → 计划明确声明不改 `handleOpenRunReplay` ✓
- 后端零改动 → 计划仅 apps/web ✓

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤都给出完整代码与精确锚点行号。

**3. 类型一致性**：
- `openAutomationJobDetail(jobId: string, tabs: Tab[]): { tabs, activeTabId, selectedJobId }`（Task 1 定义）↔ Task 3 Step 4 调用 `openAutomationJobDetail(entry.automationJobId, tabs)` 取 `.tabs/.activeTabId/.selectedJobId` 一致 ✓
- `pendingAutomationJobIdAtom: atom<string | null>`（Task 1）↔ Task 2 `useAtomValue`/`useSetAtom`、Task 3 `setPendingJobId(result.selectedJobId)`（string）一致 ✓
- `RoutineEntry.automationJobId?: string`（`@lume/shared`）↔ Task 3 `entry.automationJobId` 守卫一致 ✓
- `__automation__` tab 形状 `{ id, type:'automation', title }` ↔ 既有 `LeftSidebar.openAutomation`、`TabType` 含 `'automation'` ✓

无遗留问题。

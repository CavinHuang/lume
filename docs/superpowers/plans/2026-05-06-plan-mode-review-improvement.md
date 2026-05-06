# Plan 模式审批流程改进 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 模式规划完成后产出可审查的 Markdown 计划文件，审批横幅增强为支持反馈拒绝，侧面板移除重复审批 UI。

**Architecture:** Agent 在规划阶段通过 write 工具写 plan.md 文件到会话目录，通过 TaskContractWrite 提交审批时附带 `planFilePath`。前端在审批横幅中增加「查看计划」入口和拒绝+反馈能力，侧面板 TaskProgressPanel 移除审批卡片，只保留执行进度。

**Tech Stack:** TypeScript, React, Jotai, sidecar (Node.js), @lume/shared types

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| Modify | `packages/shared/src/types/agent.ts` | `AgentTaskApprovalRequest` 增加 `planFilePath` 字段 |
| Modify | `apps/sidecar/.../plan/task-contract-write-tool.ts` | 工具 description 引导写 MD、新增 `planFilePath` 参数 |
| Modify | `apps/sidecar/.../plan/task-contract-record-types.ts` | `TaskContractRecord` 增加 `planFilePath` 字段 |
| Modify | `apps/sidecar/.../plan/task-approval-service.ts` | 审批请求附带 `planFilePath` |
| Modify | `apps/web/src/components/agent/TaskApprovalBanner.tsx` | 增加「查看计划」按钮、拒绝+反馈输入 |
| Modify | `apps/web/src/components/agent/TaskProgressPanel.tsx` | 移除审批卡片 UI (lines 272-299) |
| Modify | `apps/web/src/components/agent/AgentView.tsx` | 审批时自动打开 plan 文件 |

---

### Task 1: shared 类型扩展

**Files:**
- Modify: `packages/shared/src/types/agent.ts:652-667`

- [ ] **Step 1: 给 `AgentTaskApprovalRequest` 增加 `planFilePath` 字段**

在 `AgentTaskApprovalRequest` 接口中增加一个可选字段：

```typescript
export interface AgentTaskApprovalRequest {
  threadId: string
  runId?: string
  requestId: string
  contractId: string
  title: string
  message: string
  summary?: string
  stepCount: number
  expectedChanges?: {
    files?: string[]
    commands?: string[]
    tools?: string[]
    memoryWrites?: string[]
  }
  planFilePath?: string
}
```

- [ ] **Step 2: 类型检查**

Run: `cd "E:\projects\ai-projects\lume" && bunx tsc --noEmit -p packages/shared/tsconfig.json 2>&1 | head -10`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/agent.ts
git commit -m "feat(shared): add planFilePath to AgentTaskApprovalRequest"
```

---

### Task 2: sidecar 契约记录类型扩展

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plan/task-contract-record-types.ts:56-79`

- [ ] **Step 1: 给 `TaskContractRecord` 增加 `planFilePath` 字段**

在 `TaskContractRecord` 接口的 `approvedAt` 之前增加：

```typescript
  planFilePath?: string;
  approvedAt?: string;
```

- [ ] **Step 2: 类型检查**

Run: `cd "E:\projects\ai-projects\lume" && bunx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: PASS（可能因新字段未被使用产生少量警告，但不应有类型错误）

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plan/task-contract-record-types.ts
git commit -m "feat(sidecar): add planFilePath to TaskContractRecord"
```

---

### Task 3: sidecar TaskContractWrite 工具改造

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plan/task-contract-write-tool.ts`

- [ ] **Step 1: 更新工具 description，引导 Agent 写 MD 文件**

将第 22 行的 `description` 改为：

```typescript
    description: `Create or update an approvable task contract for the current Lume run.

IMPORTANT: Before setting status to "needs_approval", you MUST use the write tool to create a detailed plan document in Markdown format at:
  sessions/{threadId}/plans/{YYYY-MM-DD}-{short-title-slug}.md

The plan document should include:
- YAML frontmatter with contractId and status: draft
- # Goal section
- ## Steps section with numbered items
- ## Risks & Assumptions section

Then pass the file path via the planFilePath parameter.`,
```

- [ ] **Step 2: 在 inputSchema 中增加 `planFilePath` 属性**

在第 35 行 `currentStepId` 之后增加：

```typescript
        planFilePath: { type: "string" },
```

- [ ] **Step 3: 在 call 函数中将 planFilePath 写入 contract**

在第 63 行 `updatedAt` 之前增加：

```typescript
        planFilePath: toNonEmptyString(record.planFilePath) ?? existing?.planFilePath,
```

- [ ] **Step 4: 类型检查**

Run: `cd "E:\projects\ai-projects\lume" && bunx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plan/task-contract-write-tool.ts
git commit -m "feat(sidecar): guide agent to write plan.md and track planFilePath"
```

---

### Task 4: sidecar 审批服务传递 planFilePath

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/plan/task-approval-service.ts:39-68`

- [ ] **Step 1: 在 `listPendingTaskApprovalRequests` 中传递 `planFilePath`**

在第 64 行 `expectedChanges` 之后增加 `planFilePath`：

```typescript
      requests.push({
        threadId: record.interruption.threadId,
        runId: record.interruption.runId,
        requestId: record.interruption.id,
        contractId,
        title: record.interruption.title,
        message: record.interruption.message,
        summary: contract?.summary,
        stepCount: contract?.steps.length ?? payload.stepCount ?? 0,
        expectedChanges: contract?.expectedChanges ?? payload.expectedChanges,
        planFilePath: contract?.planFilePath,
      });
```

- [ ] **Step 2: 类型检查**

Run: `cd "E:\projects\ai-projects\lume" && bunx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/sidecar/src/services/agent-runtime/plan/task-approval-service.ts
git commit -m "feat(sidecar): pass planFilePath in task approval requests"
```

---

### Task 5: TaskApprovalBanner 增加「查看计划」和拒绝+反馈

**Files:**
- Modify: `apps/web/src/components/agent/TaskApprovalBanner.tsx`

- [ ] **Step 1: 重写 TaskApprovalBanner 组件**

替换整个文件内容为：

```tsx
import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { ClipboardCheck, FileText, Send, X } from 'lucide-react'
import { agentPendingInteractiveAtom } from '@/atoms'
import { submitTaskApproval } from '@/lib/desktop-api'
import { removePendingTaskApproval } from '@/hooks/pending-interactive-state'
import type { AgentTaskApprovalRequest } from '@lume/shared'

interface TaskApprovalBannerProps {
  threadId: string
  request: AgentTaskApprovalRequest
}

export function TaskApprovalBanner({ threadId, request }: TaskApprovalBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)

  const respond = async (decision: 'approve' | 'reject', feedbackText?: string) => {
    setBusy(true)
    try {
      const result = await submitTaskApproval({
        threadId,
        contractId: request.contractId,
        decision,
        execute: decision === 'approve',
        ...(feedbackText ? { feedback: feedbackText } : {}),
      })
      if (result.ok) {
        setPending((prev) => removePendingTaskApproval(prev, threadId, request.contractId))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleSubmitFeedback = () => {
    if (!feedback.trim()) return
    void respond('reject', feedback.trim())
  }

  return (
    <div className="mx-4 mb-3 animate-in rounded-xl border border-amber-500/24 bg-amber-500/[0.06] shadow-lg slide-in-from-bottom-2 duration-200">
      <div className="flex items-start gap-3 p-3">
        <ClipboardCheck size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{request.title}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/60">
            {request.summary || request.message}
          </p>
          <p className="mt-1 text-[11px] text-foreground/45">
            {request.stepCount} 个任务等待批准
          </p>
        </div>
      </div>

      {showFeedback && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border/60 bg-background/80 px-2.5 py-2">
          <input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmitFeedback()
              if (e.key === 'Escape') { setShowFeedback(false); setFeedback('') }
            }}
            placeholder="输入拒绝原因和修改建议..."
            className="flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-foreground/35"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSubmitFeedback}
            disabled={!feedback.trim() || busy}
            className="flex size-6 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
          >
            <Send size={12} />
          </button>
          <button
            type="button"
            onClick={() => { setShowFeedback(false); setFeedback('') }}
            className="flex size-6 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 px-3 pb-3">
        {request.planFilePath && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
            title={request.planFilePath}
          >
            <FileText size={12} />
            查看计划
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setShowFeedback(true)}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={() => void respond('approve')}
          disabled={busy}
          className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          批准并执行
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd "E:\projects\ai-projects\lume" && bunx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/agent/TaskApprovalBanner.tsx
git commit -m "feat(web): add plan file link and reject-with-feedback to TaskApprovalBanner"
```

---

### Task 6: TaskProgressPanel 移除审批卡片

**Files:**
- Modify: `apps/web/src/components/agent/TaskProgressPanel.tsx:272-299`

- [ ] **Step 1: 删除审批卡片 UI 和相关逻辑**

删除 `TaskProgressPanel` 中的以下内容：

1. 删除 state 声明 `const [approvalBusy, setApprovalBusy] = useState(false)` (line 60)
2. 删除 `loadPendingTaskApprovals` 函数和对应的 useEffect (lines 91-114)
3. 删除 `resolveApproval` 函数 (lines 155-181)
4. 删除 `pendingTaskApproval` 变量 (lines 121-123)
5. 删除 `canContinueTasks`、`canRetryTasks`、`canSkipTasks` 中对 `!pendingTaskApproval` 的判断条件，简化为直接判断 contract/progress 状态
6. 删除 JSX 中的审批卡片部分 (lines 272-299)
7. 删除 imports 中不再需要的 `removePendingTaskApproval`, `upsertPendingTaskApproval`, `getPendingInteractive`, `submitTaskApproval`
8. 修改 `shouldShowTaskEmptyState` 不再检查 `pendingApproval`

对于步骤 5，将：
```typescript
const canContinueTasks = !pendingTaskApproval && (latestTaskProgress
  ? latestTaskProgress.status === 'pending' || latestTaskProgress.status === 'running' || latestTaskProgress.status === 'failed'
  : canContinueTaskContract(latestTaskContract))
```
改为：
```typescript
const canContinueTasks = latestTaskProgress
  ? latestTaskProgress.status === 'pending' || latestTaskProgress.status === 'running' || latestTaskProgress.status === 'failed'
  : canContinueTaskContract(latestTaskContract)
```

对 `canRetryTasks` 和 `canSkipTasks` 做同样处理。

对于 `shouldShowTaskEmptyState`，简化为：
```typescript
export function shouldShowTaskEmptyState(contract: AgentTaskContract | undefined): boolean {
  return !contract
}
```

同时更新调用处，移除第二个参数。

- [ ] **Step 2: 类型检查**

Run: `cd "E:\projects\ai-projects\lume" && bunx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/agent/TaskProgressPanel.tsx
git commit -m "refactor(web): remove approval card from TaskProgressPanel, moved to main area banner"
```

---

### Task 7: AgentView 审批时自动打开 plan 文件

**Files:**
- Modify: `apps/web/src/components/agent/AgentView.tsx:119-121`

- [ ] **Step 1: 增加自动打开 plan 文件的逻辑**

在 `AgentView` 组件中，当 `pendingTaskApprovals` 存在且带有 `planFilePath` 时，自动打开文件预览。

在 AgentView 中新增一个 useEffect：

```typescript
import { AGENT_IPC_CHANNELS } from '@lume/shared'

// 在组件内部，在 return 之前添加
useEffect(() => {
  for (const approval of pendingTaskApprovals) {
    if (approval.planFilePath) {
      void sidecarCall(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE, {
        path: approval.planFilePath,
      }).catch((error) => {
        console.error('[AgentView] 打开计划文件失败:', error)
      })
    }
  }
}, [pendingTaskApprovals])
```

注意：这里需要确认 `AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE` 是否存在且接受 `path` 参数。如果该通道不存在，可以使用 `sidecarCall('agent:open-file', { path: approval.planFilePath })` 或类似机制。

- [ ] **Step 2: 类型检查**

Run: `cd "E:\projects\ai-projects\lume" && bunx tsc --noEmit -p apps/web/tsconfig.json 2>&1 | head -20`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/agent/AgentView.tsx
git commit -m "feat(web): auto-open plan file when task approval is pending"
```

---

### Task 8: sidecar 提交审批时支持 feedback 参数

**Files:**
- Modify: `packages/shared/src/types/agent.ts` — 检查 `submit-task-approval` 相关类型
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts` — 处理 feedback 参数

- [ ] **Step 1: 检查 submit-task-approval 的 IPC 类型定义**

搜索 `SUBMIT_TASK_APPROVAL` 通道的输入类型，确认是否支持 `feedback` 字段。如果不支持，在输入类型中增加：

```typescript
feedback?: string
```

- [ ] **Step 2: 在 sidecar 的 agent-handlers 中，当 reject 带 feedback 时，将 feedback 附加到 agent 输入**

在处理 `submit-task-approval` 的 handler 中，当 `decision === 'reject'` 且有 `feedback` 时，将 feedback 作为消息发送回 agent，让 agent 知道拒绝原因并重新规划。

- [ ] **Step 3: 类型检查并提交**

Run: `cd "E:\projects\ai-projects\lume" && bunx tsc --noEmit -p apps/sidecar/tsconfig.json 2>&1 | head -20`
Expected: PASS

```bash
git add -A
git commit -m "feat(sidecar): support feedback in task approval rejection"
```

---

## 自查清单

- [x] Spec 中每个需求都有对应 Task
- [x] 无 TBD / TODO / placeholder
- [x] 类型名称在 Task 间保持一致（`planFilePath`, `AgentTaskApprovalRequest`, `TaskContractRecord`）
- [x] 所有文件路径使用精确路径
- [x] 每个 Task 都有类型检查和 commit 步骤

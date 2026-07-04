# Delegate 阶段 2（wait 收敛）+ 阶段 3（冒泡代答验证）设计

| 项 | 值 |
|---|---|
| 日期 | 2026-06-30 |
| 状态 | 待审查 |
| 依赖 | 阶段 1（delegate 同步 + 独立子会话，已实现 commit f5701b87） |
| 对标 | Proma 链路 B 的 `delegate_agent`(异步) + `wait_for_delegations` + 冒泡代答 |

---

## 1. 背景与目标

阶段 1 的 delegate 是**同步**（阻塞等单个子会话结果）。阶段 2 让 delegate 支持**异步并行委派**（立即返回，父继续）+ **wait 工具收敛**多个子会话结果。阶段 3 是冒泡代答——探索发现它**已作为阶段 1 的副产品实现**，本阶段只需验证。

## 2. 关键发现（探索结论）

### 阶段 3（冒泡代答）— 已实现 ✅
- delegate 设 `deliveryThreadId = parentThreadId`（阶段 1）
- 子会话 ask/permission 经 `attempt.ts:487-511, 681-712` 自动改派 `approvalSessionId` 到父（`setAskUserQuestionApprovalSession`/`setToolPermissionApprovalSession`）
- 前端按 `request.threadId`(=父) 路由 banner（`useGlobalAgentListeners.ts:178-187`），提交回带同一 threadId → `submitAskUserQuestionAnswers` resolve 子会话挂起的 Promise
- 子会话来源展示 `getSubagentDisplayLabel` 已有
- **delegate 一级下，冒泡代答端到端已工作**。本阶段只验证 + 文档化。

### 阶段 2（wait 收敛）— 需新增 ❌
- registry 无 completion Promise/callback 机制（`SubagentRun` 无 resolver 字段）
- runtime 无"外部 resolve 挂起工具调用"API，唯一外部干预是 abort
- 父侧只能同步 `await runForegroundSubagentWithTimeout`；无"先返回、后续被唤醒"机制
- **需新增**：`DelegationRecord.completion` Promise + wait 工具

## 3. 范围与非目标

### 范围
- **阶段 2**：delegate `run_in_background=true` 异步（立即返回）+ 新增 wait 工具（收敛多个子会话结果）+ completion Promise 机制
- **阶段 3**：手动验证冒泡代答端到端 + 文档化（预计零或极小代码改动）

### 非目标
- ❌ 多级冒泡（D7 只允许一级 delegate，不需要）
- ❌ wait 的复杂调度（优先级、取消单个）— YAGNI，只做 all/any + 超时
- ❌ 改变阶段 1 同步 delegate 默认行为（`run_in_background=false` 仍同步）

## 4. 设计决策

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D9 | 异步化方式 | delegate 加 `run_in_background` 参数（true=异步+wait收敛，false=同步不变） | 向后兼容阶段 1；对标 AgentTool 既有 background |
| D10 | wait 语义 | mode `all`（默认）/ `any`，超时 30min（`LUME_DELEGATION_WAIT_TIMEOUT_MS`，上限 2h） | 对标 Proma；all 等全部，any 等首个/指定数 |
| D11 | completion 存储 | 扩展 `subagent-run-registry`：内存 `Map<runId, {completion: Promise, resolve}>` | 复用 registry 单例 + runId 索引；不引入新 store |
| D12 | wait 工具阻塞 | sidecar tool，`call` async 内 `await waitForDelegations` | 复用 sidecar tool async call 自然阻塞父 runtime（与 delegate 同步同模式） |
| D13 | wait 返回 | 各子的 `{runId, childThreadId, status, outputSummary}` 列表 + `{completedCount, runningCount, status: completed/timeout}` | 父拿到结构化结果，对标 Proma getDelegationSummary |

## 5. 后端设计

### 5.1 registry 扩展：completion Promise（`subagent-run-registry.ts`）

新增内存 Map（不持久化——completion 是运行期信号量，重启后靠 registry status 判断）：
```ts
const delegationCompletions = new Map<string, { completion: Promise<void>; resolve: () => void }>();

createDelegationCompletion(runId: string): void  // new Promise + 存 resolver
resolveDelegationCompletion(runId: string): void  // 调 resolver（若存在），delete
getDelegationCompletion(runId: string): Promise<void> | undefined
waitForDelegations(input: { parentThreadId: string; mode: "all"|"any"; minCompleted?: number; timeoutMs: number }): Promise<{ status: "completed"|"timeout"; completedCount: number; runningCount: number }>
```

`waitForDelegations` 实现：找父的所有 delegation runs（`listByParentSession`），对 running 的挂 `completion.then(check)`，`Promise.race([allCompleted, timeout])`。每有一个 resolve 触发 check 重评估是否达标（all=全部完成；any=minCompleted 个完成）。

### 5.2 delegate 异步分支（`run.ts` delegateTool）

`run_in_background === true` 时（复用现有 background 分支结构 `run.ts:713-768`）：
1. `createDelegationCompletion(runId)` 注册信号量
2. 立即返回 `{ delegationId: runId, childThreadId, status: "started" }`（tool_result）
3. 后台 `executeSubagent().then(onSubagentEnd)`：onSubagentEnd 内 `resolveDelegationCompletion(runId)`（在现有 registry.update + announce 之后）

`run_in_background === false`（默认）：保持阶段 1 同步行为不变。

### 5.3 wait 工具（`run.ts` 新增 `waitForDelegationsTool`）

```ts
const waitForDelegationsTool: ToolDefinition = {
  name: "WaitForDelegations",
  description: "Wait for previously delegated background child sessions to finish and return their results. Use after Delegate(run_in_background=true). mode: 'all'(default)|'any'.",
  inputSchema: { mode, min_completed, timeout_seconds },
  isReadOnly: () => true, isConcurrencySafe: () => false,
  async call(toolInput, context) {
    const parentThreadId = context.sessionId ?? "";
    const mode = toolInput.mode === "any" ? "any" : "all";
    const timeoutMs = Math.min((toolInput.timeout_seconds ?? 1800) * 1000, 2*3600*1000);
    const result = await getSubagentRunRegistry().waitForDelegations({ parentThreadId, mode, minCompleted: toolInput.min_completed, timeoutMs });
    const runs = getSubagentRunRegistry().listByParentSession(parentThreadId);
    return { type: "tool_result", tool_use_id: "", content: JSON.stringify({ status: result.status, completedCount: result.completedCount, runningCount: result.runningCount, delegations: runs.map(summarize) }) };
  }
};
```
注册到 `groups` 的 `"task"` 组（与 delegateTool 同组）。

### 5.4 prompt 引导（`static-policy-sections.ts`）

在阶段 1 Delegate 引导后补一句：异步并行委派用 `Delegate(run_in_background=true)` + `WaitForDelegations` 收敛。

## 6. 数据流

```
[父 agent] 调 Delegate(run_in_background=true, task)
  → delegateTool: createAgentThread + registry.create + createDelegationCompletion(runId)
  → 立即返回 { delegationId, childThreadId, status:"started" }
  → 后台 runSidecarSubagent 跑子会话
[父 agent] 继续做别的事（可并行起多个 Delegate(bg)）
[父 agent] 调 WaitForDelegations(mode, timeout)
  → waitForDelegationsTool.call: await registry.waitForDelegations(parentThreadId, ...)
       → Promise.race([所有子 completion, timeout])  ★父 runtime 阻塞★
[子会话] 完成 → onSubagentEnd: registry.update + resolveDelegationCompletion(runId) ★唤醒★
[父 agent] wait 返回 { status, delegations:[{childThreadId, status, outputSummary}] }
```

## 7. 边界与错误处理

| 场景 | 处理 |
|---|---|
| wait 时无 running delegation | 立即返回 completed（completedCount=已有完成数） |
| wait 超时 | 返回 status:timeout + 当前各子状态（未完成的仍 running） |
| 子会话失败/中止 | onSubagentEnd 照常 resolveDelegationCompletion（失败也算"结束"），wait 拿到 status:errored/aborted |
| 父中止（D6 级联） | 阶段 1 stopAgent 级联中止子会话 → 子 onSubagentEnd resolve completion → wait（若父还活着）收到；父已死则 wait 随父 runtime 终止 |
| completion Promise 泄漏 | resolveDelegationCompletion 内 delete；registry 已有 500 条 LRU |

## 8. 阶段 3 验证（冒泡代答）

手动验证（`bun run dev`）：
1. delegate 子会话内调 ask_user → 父会话出现 banner（标子会话来源）
2. 父代答 → 子会话继续执行
3. 同理 permission 请求

若验证发现问题（如前端 banner 容器未正确路由子会话来源），做小修。预计零或极小代码。

## 9. 测试策略

- **registry completion 单测**（`subagent-run-registry.test.ts` 追加）：createDelegationCompletion/resolve/waitForDelegations（all 达标、any 达标、超时、无 running）
- **wait 工具测试**（`run.delegate.test.ts` 追加）：mock completion，验证返回结构
- **不测**：delegate background 端到端（需 runtime 集成，代价高，手动验证）

## 10. 成功标准

1. delegate(run_in_background=true) 立即返回，父可继续 → verify: tool_result 含 status:"started"
2. 多个并行 delegate(bg) + WaitForDelegations(all) → 全部完成后返回各子结果 → verify: completedCount === 子数
3. WaitForDelegations(any, min_completed=1) → 首个完成后立即返回 → verify
4. wait 超时 → 返回 status:timeout + 未完成子仍 running → verify
5. 阶段 3：delegate 子会话 ask → 父 banner 代答 → 子继续 → verify（手动）

## 11. 实现地图

| 文件 | 改动 |
|---|---|
| `subagent-run-registry.ts` | +completion Map + createDelegationCompletion/resolveDelegationCompletion/waitForDelegations |
| `subagent-run-registry.test.ts` | +completion 单测 |
| `run.ts` | delegateTool background 分支加 createDelegationCompletion + onSubagentEnd resolveDelegationCompletion；新增 waitForDelegationsTool + 注册 groups |
| `run.delegate.test.ts` | +wait 工具测试 |
| `static-policy-sections.ts` | +异步 delegate + wait 引导 |

## 12. 后续（非本阶段）
- 多级 delegate（需放开 D7 + 多级冒泡链路）
- wait 的取消单个/优先级调度

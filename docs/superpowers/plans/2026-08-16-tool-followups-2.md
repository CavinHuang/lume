# 工具注入 follow-ups 第二批（I-2 根治 + 两条一行级）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① exec deadline lease（host call 在途时延长 exec 超时，根治嵌套审批超时杀沙箱线程）；② 批次晋升按 names 序 append（run 边界 cache 稳定）；③ Skill 激活路径补 onToolsActivated 回调（与 ToolSearch 晋升持久语义一致）。

**Architecture:** ① 在 JsonlNodeReplRuntimeClient 内：exec 的 pending requestId 记入 ActiveExec，host call 到达时重设该 pending 的 setTimeout（一次性续租 `hostCallLeaseMs`，默认 10min，防真死保守上限）；②③ 各为既有函数的顺序/一行回调补齐。

**Tech Stack:** TypeScript、bun:test。

## Global Constraints

- 分支 `feat/tool-followups-2`（基于 main@a0aebd82），一个 PR，3 个主题 commit
- 测试 bun:test；提交 emoji 前缀；注释英文；风格随所在文件
- ① 不改 worker.js / Rust；不改 call() 既有默认语义（非 exec 调用不受 lease 影响）

---

### Task 1: exec deadline lease

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-runtime-manager.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/node-repl/node-repl-contract.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // JsonlNodeReplRuntimeClientOptions 追加
  hostCallLeaseMs?: number  // default 10 * 60_000
  ```
  语义：
  - `ActiveExec` 追加 `execRequestId: string`；私有 `call` 增可选 `requestIdOverride`（或重构 exec 直接组装，二选一以最小 diff 为准）
  - `handleRuntimeHostCall` 找到 active 后（任何 method 分支前）：`extendExecDeadline(active)` —— `pending.get(active.execRequestId)` 命中则 `clearTimeout` + 重设 `setTimeout(同 reject 语义, Math.max(剩余, hostCallLeaseMs))`；未命中（exec 已结算）no-op
  - exec 结算（finally）后 pending 已删，后续 host call no-op —— 既有行为不变

- [ ] 写失败测试（contract 模式，fake child）：
  - 场景 A（续命）：`hostCallLeaseMs: 5_000` 注入 + `timeout_ms: 200` 的 exec 挂起 → 100ms 后伪造 `runtime_host_call`（tool_call，toolRequest 挂起不 resolve）→ 400ms 时 exec 仍未超时（原 200ms deadline 已被续租）→ resolve toolRequest → exec 正常完成
  - 场景 B（租约上限）：同上但 toolRequest 永不 resolve → 等待超过 lease 后 exec 以 "timed out" reject（防真死）
  - 场景 C（无 host call 不受影响）：挂起 exec 无 host call → 原超时照旧 reject
- [ ] 确认失败 → 实现 → 确认通过（node-repl 目录全绿）
- [ ] 提交：`🔧 fix(sidecar): lease exec deadline while host calls are in flight`

### Task 2: 批次晋升按 names 序 append

**Files:**
- Modify: `packages/sdk/src/agent.ts`（recordToolActivation）
- Test: `packages/sdk/src/agent.test.ts`

**Interfaces:**
- 语义：`recordToolActivation(names)` 从 `deferredToolPool` 取工具时按 **names 顺序** append（`names.flatMap(n => deferred.find(t => t.name === n))` 模式），与 engine `activateTools` 的匹配序一致 → run 内与跨 run 的 tools 尾序相同，query 边界 cache 前缀稳定

- [ ] 写失败测试：deferred 注册序 [A, B]，ToolSearch 匹配序返回 [B, A]（engine 匹配序 push B 先）→ 同 run 内请求尾序 [.., B, A]，query2 的 toolPool 尾序也是 [B, A]（toEqual 精确断言）——现有实现（注册序）会在 query 边界产生 [A, B] 而失败
- [ ] 确认失败 → 实现（一行 flatMap）→ 确认通过（packages/sdk 全绿）
- [ ] 提交：`🔧 fix(sdk): append promoted tools in match order for stable prefixes`

### Task 3: Skill 激活路径补持久回调

**Files:**
- Modify: `packages/sdk/src/engine.ts`（applySkillAllowedTools 激活段）
- Test: `packages/sdk/src/engine.test.ts`

**Interfaces:**
- 语义：applySkillAllowedTools 将 deferred 工具 push 进 config.tools 时，收集实际激活名，push 完成后调用 `this.config.onToolsActivated?.(names)`（与 activateTools 的回调契约一致：只在非空激活时触发、在 config 变更之后）

- [ ] 写失败测试：engine 测试（fake skill 输出激活一个 deferred 工具 + config.onToolsActivated 捕获）→ 断言回调收到该名；无激活时不回调
- [ ] 确认失败 → 实现 → 确认通过（packages/sdk 全绿 + typecheck）
- [ ] 提交：`✨ feat(sdk): report skill-scope tool activations through onToolsActivated`

---

## 完成标准

- `bun test packages/sdk` + node-repl 目录全绿；双侧 typecheck clean
- lease 三场景测试锁定（续命/上限/不受影响）；跨 query 尾序 toEqual；skill 回调契约测试
- PR 描述：lease 默认 10min 的取舍（审批长等待放行、真死上限保守）；Task 2/3 为终审 follow-up 清偿

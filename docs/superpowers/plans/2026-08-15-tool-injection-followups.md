# 工具注入 follow-ups 实施计划（第二/三梯队）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清偿 P1-P3 合并后的已记录 follow-ups：I-2 止血（js 默认超时）、M-1（content 数组归一化）、M-4（abort 透传）、晋升跨 query 持久、registry 风格统一与 disposer 测试补齐。

**Architecture:** 全部为已定方案的修复/增强，无新设计。host 侧（create-node-repl-tools）承担 I-2/M-1/M-4；sdk agent 层承担晋升持久化；registry 只做风格与测试补齐。

**Tech Stack:** TypeScript、bun:test。

**Spec:** `docs/superpowers/specs/2026-08-14-tool-injection-optimization-design.md`（三期已合并；本计划为其 follow-ups 清单）

## Global Constraints

- 分支 `feat/tool-injection-followups`（基于 main@950c24c6），一个 PR 交付，~5-6 个主题 commit
- 测试 bun:test；提交 emoji 前缀；注释英文；风格随所在文件
- 已划掉项：legacy ToolSearchTool 幽灵（侦察证伪——registry split 的 RESERVED 排除已挡，P1 测试锁定）；白名单动态化（YAGNI 挂起，待真实 MCP 规模数据）

---

### Task 1: I-2 止血 — js 默认 timeout 300s

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.ts`
- Test: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.test.ts`

**Interfaces:**
- Produces: js 工具 `timeout_ms` 缺省 300_000（模型显式传值优先）；schema description 说明默认值与含义（嵌套 agent 工具调用可能等待用户审批，默认宽限 5 分钟；纯计算可显式传小值）

- [ ] 写失败测试：fake registry 捕获 exec input，断言未传 timeout_ms 时 `input.timeout_ms === 300_000`，显式传 5000 时保持 5000
- [ ] 确认失败 → 实现（call 内 `timeout_ms: parsed.value.timeout_ms ?? 300_000` 组装进 execInput；schema 加 description）→ 确认通过
- [ ] 提交：`🔧 fix(sidecar): default js exec timeout to 300s for approval-bearing nested calls`

### Task 2: M-1 — 嵌套结果 content 归一化

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.ts`
- Test: 同 Task 1 测试文件

**Interfaces:**
- Produces: toolRequest tool_call 分支返回前归一化：content 为数组时 → 文本块 `.text` join `'\n'`、图片/其他块替换 `[unsupported block: <type>]`；string 原样；归一化纯函数 `normalizeNestedToolContent(result)`（文件内私有，可导出供测试）

- [ ] 写失败测试：数组 content（两文本块 + 一图片块）→ join 后文本 + 占位符；string content 原样；is_error 保留
- [ ] 确认失败 → 实现 → 确认通过
- [ ] 提交：`🔧 fix(sidecar): flatten nested tool content blocks for the sandbox`

### Task 3: M-4 — toolRequest abort 透传

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/tools/node-repl/create-node-repl-tools.ts`
- Test: 同上

**Interfaces:**
- Produces: toolRequest 收到已 aborted 的 signal 时立即返回 `{ type: 'tool_result', tool_use_id: '', content: 'Error: aborted before dispatch.', is_error: true }`（不发嵌套执行）；在途 abort 不强杀（engine 侧取消语义未就绪，注释注明 ceiling）

- [ ] 写失败测试：aborted signal → 不调 executeNestedTool、返回 is_error
- [ ] 确认失败 → 实现 → 确认通过
- [ ] 提交：`🔧 fix(sidecar): honor aborted signal at tool bridge dispatch`

### Task 4: 晋升跨 query 持久（sdk）

**Files:**
- Modify: `packages/sdk/src/agent.ts`
- Modify: `packages/sdk/src/engine.ts`（若需回写钩子）
- Test: `packages/sdk/src/agent.test.ts`、`packages/sdk/src/engine.test.ts`

**Interfaces:**
- Produces: `Agent` 私有 `activatedToolNames: Set<string>`（实例级，会话生命周期）；
  - QueryEngine 构造时接收 `onToolsActivated?: (names: string[]) => void`（engine 的 activateTools 晋升成功后回调），agent 接线写入集合
  - `rebuildToolPool`：core + generated 之外，把 `activatedToolNames` 命中的 registry 全局池工具并入 `this.toolPool`，并从 deferred 排除
  - 语义：同一 Agent 实例跨 query 保留晋升；显式 `overrides.tools` 名单分支不受影响（掩码后自然过滤）
- ⚠️ cache 注意：tools 数组随晋升只增不减（追加序），每 query 前缀稳定

- [ ] 写失败测试（agent 级）：query1 内 ToolSearch 晋升 GuanlanSearch → query2 的 engine 收到的 tools 含 GuanlanSearch 且 deferredTools 不含
- [ ] 确认失败 → 实现（engine 回调 + rebuild 合并）→ 确认通过（engine/agent 全量）
- [ ] 提交：`✨ feat(sdk): persist tool promotions across queries for the agent lifetime`

### Task 5: registry 风格统一 + disposer 收缩测试

**Files:**
- Modify: `packages/sdk/src/tools/registry.ts`（风格：单引号、无分号，对齐 sdk 既有文件；顺手清理 pools 分支 registered-then-undone 死写入的误导注释，改为准确说明"语义声明，P2 求值读取"或删除该注册）
- Test: `packages/sdk/src/agent.test.ts`（追加 disposer 场景）

**Interfaces:** 无接口变化（纯风格 + 测试）

- [ ] disposer 测试：连续两次 `rebuildToolPool`（第一次 resolveRuntimeTools 返回 [A,B]，第二次 [A]）→ toolPool 精确为 [A(+generated)]，B 不残留
- [ ] prettier registry.ts（bunx prettier 或手动对齐——以仓库现有格式化配置为准，若无则手动统一）
- [ ] 全量 `bun test packages/sdk` 绿 + typecheck
- [ ] 提交：`🧹 chore(sdk): normalize registry style and lock pool-shrink rebuild`

---

## 完成标准

- `bun test packages/sdk` + node-repl 目录全绿；两处 typecheck clean
- Task 4 测试证明跨 query 持久生效；PR 描述注明根因 I-2 仍需 lease 模式根治（follow-up 保留）

## 划掉项（侦察证伪/挂起）

- legacy ToolSearchTool 幽灵：RESERVED 排除已挡（registry.test.ts 锁定）
- 白名单动态化：待真实 MCP 规模数据再立项
- I-2 根治（exec deadline lease 模式）：独立改动，本次只止血

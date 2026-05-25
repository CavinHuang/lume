# Lume 工作流 Hook 设计

> 日期: 2026-05-25
> 状态: spec review 已通过，等待用户复核
> 范围: sidecar 原生 workflow hook bus、runtime 生命周期接入、记忆/上下文与权限/安全最小闭环、未来插件 hook 扩展边界

## 概述

Lume 需要一套工作流 hook 机制，方便后续在 Agent runtime、记忆、权限、安全、观测、MCP、Skills、IM 与 cron 等能力之间建立稳定扩展点。第一版采用 Lume 原生的 typed hook bus：由 sidecar 内部固定注册 handler，按代码顺序执行，不开放用户 shell command、不开放第三方动态 hook 执行。

设计借鉴 Codex 风格的 `event -> selector -> contribution -> handler` 模型，但不照搬 command hook 执行方式。Lume 第一版的 handler 是内部 TypeScript typed handler，返回受控 effect，由统一 reducer 落地。这样既能把当前散落在 runner 中的记忆、上下文、权限调用整理成清晰生命周期点，也为后续 `.lume-plugin` 插件贡献 hook 留出兼容形状。

本文中的 MVP 即第一版 implementation-ready 边界；后续阶段只作为保留契约和迁移方向。

## 背景

当前代码中已有两类相关基础：

- SDK 层已有 `HookRegistry`，支持 `PreToolUse`、`PostToolUse`、`SessionStart`、`SubagentStart` 等生命周期事件，并能执行 handler 或 shell command。
- Lume sidecar runtime 已有 `LumeRunner`、`ContextAssembler`、`LumeRunObserver`、runtime event、trace、memory-v2、权限审批和 tool runtime 等能力，但这些能力主要通过直接调用串在 runner 与 runtime-core 中。

这带来几个问题：

- SDK hook 更偏 SDK/plugin 兼容层，不理解 Lume workspace、memory、runtime event、trace 和 sidecar 安全边界。
- 记忆召回、上下文注入、权限安全、完成后摘要等逻辑会越来越多，继续散落在 runner 里会降低可维护性。
- 后续插件能力需要统一扩展点，但第一版不能直接开放 shell/JS hook，否则安全和信任模型会过早变复杂。

## 目标

1. 新增 Lume 原生 `LumeWorkflowHookBus`，作为 sidecar 内部工作流扩展点。
2. MVP 只接入 implementation-ready 的最小生命周期：run、context、permission。
3. MVP 实际落地记忆/上下文与权限/安全两个主场景，并预留 prompt、tool、memory、MCP、Skills、IM、cron 的事件命名。
4. 支持两类 hook：可返回流程决策 effect 的 decision hook，以及只返回 observe-safe effect 的 observe hook。
5. 注册顺序由代码固定，配置只控制内部 hook 总开关和模块开关。
6. 借鉴 Codex 插件心智，内部 handler 也使用 contribution 结构，为未来插件 hook 声明保持兼容。
7. 保留现有 SDK `HookRegistry`，不破坏 SDK/plugin 兼容路径。

## 非目标

- 第一版不支持用户在 `lume.yaml` 中配置外部 shell command hook。
- 第一版不支持第三方插件动态加载 hook handler。
- 第一版不支持用户自定义 hook 顺序或 priority。
- 第一版不重写整个 SDK hook 系统。
- 第一版不把所有 runner 逻辑一次性迁移到 hook bus。
- MVP 不接入独立的 `prompt.*`、`tool.*`、`memory.*` hook；这些事件作为后续阶段的保留契约。
- 第一版不改变 memory-v2 的召回、摘要、提取策略本身。
- 第一版不让 hook 绕过现有权限系统；hook 只能作为前置或补充 decision。

## 设计原则

### Lume 原生，不以 SDK HookRegistry 为核心

SDK `HookRegistry` 继续用于 SDK 内部与插件兼容。Lume workflow hook bus 放在 sidecar，理解 workspace、runId、threadId、runtime event、trace、memory 和权限策略。

### 内部 typed handler 优先

第一版 handler 由 Lume 代码固定注册，输入输出都有 TypeScript 类型。handler 不解析 stdout、不依赖 exit code、不执行外部脚本。

### 受控 effect，而不是任意改状态

handler 返回 `LumeWorkflowHookHandlerResult`，其中包含 `effects: LumeWorkflowHookEffect[]`。所有副作用统一由 `applyWorkflowHookEffects` 落地。handler 不直接修改 runner、context assembler、permission session 或 observer 状态。

### 决策确定性

decision hook 串行执行。MVP 遇到 `deny` 后短路后续 decision handler；未来接入 `tool.beforeCall` 时再加入 `block` 短路。observe hook 第一版也保持串行，后续可按事件类别后台化。

observe hook 的含义是“不改变主流程决策”，不是“handler 可以直接做任意 side effect”。observe handler 仍只能返回 observe-safe effect，例如 `emitRuntimeEvent`、`recordTrace`、`enqueueMemoryCandidate`。

### 插件形状前置，插件执行后置

内部 handler 使用和未来插件一致的 contribution 模型，但第一版 contribution 来源只有 Lume core。未来插件可以声明 hook contribution，但必须先有安装信任、capability 授权和受信执行 runtime。

## 架构

新增目录：

```text
apps/sidecar/src/services/workflow-hooks/
  hook-bus.ts
  hook-events.ts
  hook-effects.ts
  contributions.ts
  core-memory-hooks.ts
  core-security-hooks.ts
  core-observability-hooks.ts
```

职责划分：

- `hook-events.ts`: 定义 event name、event payload、selector 输入。
- `hook-effects.ts`: 定义 effect 类型、decision 合并规则、effect reducer。
- `contributions.ts`: 定义 contribution 结构和 Lume core 固定注册表。
- `hook-bus.ts`: 执行 selector 匹配、handler 调用、decision 短路和 effect source 标记。
- `core-memory-hooks.ts`: 记忆召回上下文、完成后记忆候选入队等 handler。
- `core-security-hooks.ts`: 权限和工具调用安全 decision handler。
- `core-observability-hooks.ts`: trace、runtime event、诊断信息等 observe handler。

Shared 层只放可序列化、前端需要理解的最小类型，例如 runtime event 中可展示的 hook source/effect 摘要。sidecar 内部复杂 handler 类型不需要全部导出到 shared。

## Contribution 模型

内部 contribution 使用如下形状：

```ts
interface LumeWorkflowHookContribution {
  id: string
  pluginId?: string
  event: LumeWorkflowHookEventName
  selector?: LumeWorkflowHookSelector
  phase: "decision" | "observe"
  priority: "core" | "normal" | "late"
  capabilities: LumeWorkflowHookCapability[]
  handlerRef: string
}
```

selector、capability 和 handler registry 的 MVP 形状：

```ts
interface LumeWorkflowHookSelector {
  toolName?: string | string[]
  permissionMode?: string | string[]
  threadType?: string | string[]
  chatType?: string | string[]
}

type LumeWorkflowHookCapability =
  | "context.append"
  | "permission.decide"
  | "memory.enqueue"
  | "runtime.emit"
  | "trace.write"

interface LumeWorkflowHookHandlerResult {
  effects: LumeWorkflowHookEffect[]
}

interface LumeWorkflowHookHandlerContext {
  services: {
    memory: LumeWorkflowHookMemoryService
    security: LumeWorkflowHookSecurityService
    runtimeEvents: LumeWorkflowHookRuntimeEventService
    trace: LumeWorkflowHookTraceService
    clock: { now(): Date }
  }
  signal?: AbortSignal
}

type LumeWorkflowHookHandler = (
  event: LumeWorkflowHookEvent,
  context: LumeWorkflowHookHandlerContext
) => Promise<LumeWorkflowHookHandlerResult>

type LumeWorkflowHookHandlerRegistry = Record<string, LumeWorkflowHookHandler>
```

service dependency 边界：

- handler 只能通过 `LumeWorkflowHookHandlerContext.services` 访问 memory、security、runtime event 和 trace facade。
- handler 不接收 runner、agent、session manager 或 observer 实例。
- service facade 返回的数据必须是最小、脱敏、可测试的 DTO。
- 写操作仍返回 effect，由 reducer 统一执行；service facade 不在 handler 内直接写入主流程状态。

MVP service facade 的最小方法：

```ts
interface LumeWorkflowHookMemoryService {
  recallContext(input: {
    threadId: string
    workspaceSlug?: string
    userMessage: string
    tokenBudget: number
  }): Promise<{
    items: Array<{
      id: string
      content: string
      citation?: string
      reason?: string
    }>
  }>

  extractCandidates(input: {
    runId: string
    threadId: string
    workspaceSlug?: string
    userMessage: string
    runSummary?: string
  }): Promise<LumeWorkflowMemoryCandidate[]>
}

interface LumeWorkflowHookSecurityService {
  evaluatePermissionDecision(input: {
    toolName: string
    toolInputSummary: string
    permissionMode?: string
    gatewayDecision: "allow" | "ask"
    risk?: string
    reasonCode?: string
  }): Promise<{
    decision?: "allow" | "ask" | "deny"
    reason?: string
  }>
}

interface LumeWorkflowHookRuntimeEventService {
  buildDiagnosticEvent(input: {
    runId: string
    threadId: string
    contributionId: string
    message: string
    level: "debug" | "info" | "warning" | "error"
  }): LumeWorkflowRuntimeEventDraft
}

interface LumeWorkflowHookTraceService {
  buildHookTrace(input: {
    contributionId: string
    event: LumeWorkflowHookEventName
    status: "success" | "error" | "skipped"
    elapsedMs?: number
    effectTypes?: string[]
    errorMessage?: string
  }): LumeWorkflowTraceRecord
}
```

DTO 形状：

```ts
interface LumeWorkflowMemoryCandidate {
  kind: "preference" | "project_fact" | "event" | "lesson"
  text: string
  confidence?: number
  evidence: {
    runId: string
    threadId: string
    source: string
  }
}

interface LumeWorkflowRuntimeEventDraft {
  type: "workflow_hook.diagnostic"
  runId: string
  threadId: string
  contributionId: string
  message: string
  level: "debug" | "info" | "warning" | "error"
}

interface LumeWorkflowTraceRecord {
  type: "workflow_hook"
  contributionId: string
  event: LumeWorkflowHookEventName
  status: "success" | "error" | "skipped"
  elapsedMs?: number
  effectTypes?: string[]
  errorMessage?: string
}
```

第一版规则：

- Lume 内置 contribution 使用 `pluginId: "lume-core"`。
- `priority` 只作为声明字段和排序校验，实际顺序由代码固定注册表决定。
- `handlerRef` 指向 Lume 内部 handler registry 中的函数 id，不指向文件路径。
- `capabilities` 用于自审和未来插件权限，例如 `context.append`、`permission.decide`、`memory.enqueue`、`runtime.emit`、`trace.write`。
- selector 第一版只支持简单匹配：事件名、toolName、permissionMode、threadType、chatType。复杂条件留给 handler 内部判断。

固定注册顺序：

1. core memory hooks
2. core security hooks
3. core observability hooks

workflow bridge hooks 是后续 IM/cron/notification 阶段的保留模块，不进入 MVP 固定注册表。

## 事件模型

MVP 接入事件：

```ts
type LumeWorkflowHookEventName =
  | "run.beforeStart"
  | "run.afterComplete"
  | "run.afterFailure"
  | "context.beforeAssemble"
  | "context.afterAssemble"
  | "permission.beforeDecision"
```

后续阶段保留事件名：

```ts
type ReservedLumeWorkflowHookEventName =
  | "prompt.beforeSubmit"
  | "tool.beforeCall"
  | "tool.afterCall"
  | "tool.afterFailure"
  | "memory.beforeRecall"
  | "memory.afterRecall"
  | "memory.afterExtract"
  | "workspace.afterOpen"
  | "config.afterChange"
  | "mcp.afterSync"
  | "skills.afterLoad"
  | "schedule.beforeRun"
  | "channel.beforeReply"
```

事件 payload 要最小且默认脱敏。公共字段：

```ts
interface LumeWorkflowHookBaseEvent {
  event: LumeWorkflowHookEventName
  runId: string
  threadId: string
  workspaceId?: string
  workspaceSlug?: string
  cwd: string
  model?: {
    provider?: string
    modelId?: string
    channelId?: string
  }
  threadType?: string
  chatType?: string
  permissionMode?: string
  messageMetadata?: Record<string, unknown>
}
```

事件专属字段：

- `context.beforeAssemble`: user message 摘要、available tool names、token budget、attachments metadata。
- `context.afterAssemble`: context token usage、memory citations summary、available tool names。
- `permission.beforeDecision`: tool name、tool input summary、file/command/path 摘要、当前 permission mode。
- `run.afterComplete`: run state summary、usage summary、memory context used summary。
- `run.afterFailure`: error code/message、completed step summary。

完整 transcript、完整文件内容、API key、headers、env secrets 不进入默认 payload。需要重数据的 handler 通过显式 service dependency 读取。

### MVP 事件矩阵

| Event | Phase | Trigger location | Allowed effects | Fallback behavior | Required tests |
| --- | --- | --- | --- | --- | --- |
| `run.beforeStart` | observe | `LumeRunner.create` 完成 observer/trace 后 | `recordTrace`, `emitRuntimeEvent` | handler 失败只记录诊断，run 继续 | 触发顺序、disabled 不触发 |
| `context.beforeAssemble` | decision | `ContextAssembler.assemble` 前 | `appendContext`, `recordTrace`, `emitRuntimeEvent` | memory/context handler 失败则跳过额外 context | appendContext 来源标记、disabled 不注入 |
| `context.afterAssemble` | observe | `ContextAssembler.assemble` 后 | `recordTrace`, `emitRuntimeEvent` | handler 失败只记录诊断 | token/tool summary 进入 trace |
| `permission.beforeDecision` | decision | descriptor 和 `toolExecutionGateway.authorize` 通过后、交互审批前 | `setPermissionDecision`, `recordTrace`, `emitRuntimeEvent` | security handler 失败返回 `ask`，继续现有审批 | deny 短路、allow 跳过审批、ask 继续审批 |
| `run.afterComplete` | observe | `LumeRunner.complete` 成功结果落地前 | `enqueueMemoryCandidate`, `recordTrace`, `emitRuntimeEvent` | handler 失败不影响完成 | completion hook 触发、memory enqueue 可观测 |
| `run.afterFailure` | observe | `LumeRunner.fail` / `finalizeError` | `recordTrace`, `emitRuntimeEvent` | handler 失败不覆盖原始错误 | 原始错误保留、trace 记录 |

## Effect 模型

MVP 允许的 effect：

```ts
type LumeWorkflowHookEffect =
  | AppendContextEffect
  | SetPermissionDecisionEffect
  | EmitRuntimeEventEffect
  | RecordTraceEffect
  | EnqueueMemoryCandidateEffect
```

### appendContext

仅允许在 `context.beforeAssemble` 返回。用于给 `ContextAssembler` 增加带来源标记的上下文块。

```ts
interface AppendContextEffect {
  type: "appendContext"
  content: string
  source: string
  priority?: "early" | "normal" | "late"
  hidden?: boolean
}
```

### setPermissionDecision

仅允许在 `permission.beforeDecision` 返回。用于给工具调用提供 `allow | ask | deny` 和 reason。

```ts
interface SetPermissionDecisionEffect {
  type: "setPermissionDecision"
  decision: "allow" | "ask" | "deny"
  reason: string
}
```

合并规则：

- `deny` 优先于 `ask` 和 `allow`。
- `ask` 优先于 `allow`。
- 第一个 `deny` 短路后续 decision handler。
- 如果没有 hook decision，继续走现有 `canUseTool` 逻辑。

### blockToolCall

`blockToolCall` 不进入 MVP effect union。后续接入 `tool.beforeCall` 时再增加，用于阻断工具调用并生成模型可见说明。

后续规则预留：`tool.afterCall` 不能撤销已发生副作用，只能补充观测、记忆候选或模型反馈。

### emitRuntimeEvent

用于把内部 hook 行为映射到现有 runtime event 管线。第一版只发诊断和状态类事件，不制造新的用户交互需求。

```ts
interface EmitRuntimeEventEffect {
  type: "emitRuntimeEvent"
  event: LumeWorkflowRuntimeEventDraft
}
```

### recordTrace

用于记录 hook 执行、decision、effect 和错误，进入现有 trace recorder。

```ts
interface RecordTraceEffect {
  type: "recordTrace"
  record: LumeWorkflowTraceRecord
}
```

### enqueueMemoryCandidate

用于把完成后的用户偏好、项目事实、重要事件送入 memory-v2 后台处理。第一版保持当前 memory-v2 策略，只改变调用入口。

```ts
interface EnqueueMemoryCandidateEffect {
  type: "enqueueMemoryCandidate"
  candidates: LumeWorkflowMemoryCandidate[]
}
```

### notify

`NotifyEffect` 不进入 MVP effect union。它只作为后续 IM/系统通知桥接的保留方向，等 channel trust、去重和用户可见通知策略确定后再设计。

所有 effect 在执行前补充：

```ts
interface LumeWorkflowHookEffectEnvelope {
  effect: LumeWorkflowHookEffect
  sourceContributionId: string
  pluginId?: string
  createdAt: string
}
```

## 配置模型

`lume.yaml` 第一版只接受内部模块开关：

```yaml
hooks:
  internal:
    enabled: true
    memory: true
    security: true
    observability: true
```

默认值：

- `enabled`: true
- `memory`: true
- `security`: true
- `observability`: true

配置服务需要 normalize 未知字段但不保留第三方 hook 配置。未来插件 hook 需要独立 manifest 与 trust/capability 模型，不复用这个内部开关作为执行入口。

## Runtime 数据流

### Run 启动

1. `LumeRunner.create` 创建 observer、runId、trace。
2. runner 根据 `getEffectiveLumeConfig(workspaceSlug).hooks.internal` 创建 `WorkflowHookRuntime`。
3. 触发 `run.beforeStart` observe hook。

### Context assembly

1. `createRuntimeCoreSession` 在 `ContextAssembler.assemble` 前触发 `context.beforeAssemble`。
2. hook bus 收集 `appendContext` effect。
3. `ContextAssembler` 接收 hook context blocks，并记录来源，例如 `hook:core-memory-recall`。
4. context 组装完成后触发 `context.afterAssemble` observe hook，用于 trace 与诊断，不再改写上下文。

### Permission decision

1. `createCanUseToolHandler` 继续先做 descriptor 查询和 `toolExecutionGateway.authorize`。
2. descriptor 缺失、gateway `deny`、AskUserQuestion 输入无效等硬性失败在 hook 前返回 deny。
3. gateway 返回 `allow` 或 `ask` 后，wrapper 触发 `permission.beforeDecision`。
4. 如果 hook 返回 `deny`，直接返回 deny，并记录 reason。
5. 如果 hook 返回 `allow`，在 gateway 未 deny 的前提下跳过普通交互审批并返回 allow。
6. 如果 hook 返回 `ask` 或无 decision，继续走现有 approval/automation pause 流程。
7. 如果 security handler 抛错，确定性降级为 `ask`，继续现有审批；不静默 allow。

### Tool lifecycle

SDK 层已有 `PreToolUse/PostToolUse/PostToolUseFailure`。MVP 不接入 tool lifecycle adapter。后续阶段再把 SDK 事件映射为：

- `tool.beforeCall`
- `tool.afterCall`
- `tool.afterFailure`

adapter 的目标不是模拟 SDK shell hook，而是把工具生命周期纳入 Lume trace/runtime event 与后续 memory/security 统一模型。

### Run completion

1. `LumeRunner.complete` 在完成结果落地前触发 `run.afterComplete` observe hook。
2. MVP 的 memory handler 只返回 `enqueueMemoryCandidate`、`recordTrace` 或 `emitRuntimeEvent`。
3. appendDaily、appendRunArchive、conversation summary 迁移到 hook contribution 属于后续阶段。
4. `LumeRunner.fail` 和 `finalizeError` 触发 `run.afterFailure`，用于 trace 与诊断。

## 与 memory-v2 的关系

MVP 优先 hook 化两个位置：

- `context.beforeAssemble`: 记忆召回上下文以 `appendContext` 进入 prompt。
- `run.afterComplete`: 完成后记忆候选以 `enqueueMemoryCandidate` 进入 memory-v2 后台处理。

现有 memory-v2 逻辑保持等价：

- 不改变召回排序。
- 不改变 citations mode。
- 不改变 memory tool policy。
- 不改变 LLM 提取策略和 fallback summary 策略。
- 不在 MVP 中迁移 appendDaily、appendRunArchive 或 conversation summary 写入。

## 与权限/安全的关系

MVP hook 化 `permission.beforeDecision`，用于统一未来的安全能力：

- 私有目录写入保护。
- 命令风险分类。
- 工具 allow/deny policy。
- IM/cron 自动执行场景的更严格默认策略。

约束：

- hook 的 `allow` 不能绕过不可被绕过的硬安全规则。
- hook 的 `deny` 可以提前结束审批并返回清晰 reason。
- security handler 错误固定降级为 `ask`，即继续现有审批；不会因为错误自动 allow。
- hook decision 需要写入 trace，方便审计。
- `tool.afterCall` 不用于撤销工具副作用。

## 与插件系统的关系

未来 Lume 插件可借鉴 Codex plugin 结构：

```text
plugin/
  .lume-plugin/plugin.json
  skills/
  mcp.json
  hooks.json
  apps.json
```

可能的 `plugin.json` 字段：

```json
{
  "name": "repo-policy",
  "version": "1.0.0",
  "description": "Repository policy hooks for Lume",
  "skills": "./skills/",
  "mcpServers": "./mcp.json",
  "hooks": "./hooks.json",
  "apps": "./apps.json"
}
```

第一版不加载该字段。设计只保证当前 contribution 模型未来可以作为 `hooks.json` 的目标形状。

插件 hook 接入前必须具备：

- 插件安装与信任确认。
- hook capability 授权，例如 `permission.decide`、`context.append`。
- handler sandbox 或 connector runtime。
- manifest 校验、版本兼容、错误隔离。
- 可审计 trace 和禁用入口。

## 错误处理

- handler 抛错不应直接导致 run 失败。
- observe hook 错误记录 trace 后继续执行。
- `permission.beforeDecision` 的 security handler 错误固定降级为 `ask`，继续现有审批。
- `context.beforeAssemble` 的 memory/context handler 错误固定跳过对应 `appendContext`。
- effect reducer 遇到非法 event/effect 组合时忽略该 effect 并记录诊断。
- hook bus 需要避免把 secret 或完整 tool input 写入错误日志。

## 观测

每次 hook 执行记录：

- contribution id
- event name
- phase
- status: success/error/skipped
- elapsed time
- effect types
- short error message

runtime event 第一版可只发聚合诊断，避免 UI 噪音。trace 中保留更完整的 hook span。

## 测试策略

只测试有行为风险的逻辑，不做全量 lint/typecheck/test。

### Workflow hooks 单元测试

覆盖：

- 固定注册顺序。
- selector 按 event/toolName 匹配。
- decision hook 串行执行。
- `deny` 短路。
- effect envelope 添加 sourceContributionId。
- handler 错误隔离。

### Context 测试

覆盖：

- `appendContext` 进入 ContextAssembler。
- hook context 带来源标记。
- hooks disabled 时不注入额外 context。

### Permission 测试

覆盖：

- `deny` 优先并短路。
- `ask` 和 `allow` 语义。
- reason 透传到权限结果。
- hooks disabled 时保持现有权限行为。

### Runner 测试

覆盖：

- `run.beforeStart`、`context.beforeAssemble`、`permission.beforeDecision`、`run.afterComplete` 在预期时机触发。
- hooks disabled 时 runtime 仍走现有路径。
- memory candidate enqueue 可观测，原有 summary/archive 写入保持不变。

## 迁移计划

MVP 边界：

- 新增 hook bus 基础设施和配置 normalize。
- 接入 `run.beforeStart`、`context.beforeAssemble`、`context.afterAssemble`、`permission.beforeDecision`、`run.afterComplete`、`run.afterFailure`。
- 不接入独立 `prompt.*`、`tool.*`、`memory.*` adapter。
- 不迁移 appendDaily、appendRunArchive、conversation summary 写入。

### MVP implementation stages

1. 新增 hook bus 基础设施和配置 normalize，不改变现有 runtime 行为。
2. 接入 context hook，将 memory recall context 通过 `appendContext` 注入，但保持原有召回结果等价。
3. 接入 permission hook，将现有安全策略映射为 `permission.beforeDecision` contribution。
4. 接入 run completion/failure hook，将完成后的 memory candidate enqueue 和失败 trace 纳入 observe handler。

### Post-MVP migration direction

- 增加 SDK hook adapter，把 tool lifecycle 纳入 Lume workflow hook 观测。
- 接入独立的 `prompt.*`、`tool.*`、`memory.*` 事件。
- 评估 appendDaily、appendRunArchive、conversation summary 是否迁移为 hook contribution。
- 设计 `NotifyEffect` 和 workflow bridge hooks，用于 IM/cron/notification。

每阶段都保持小 diff，可单独回滚。

## 风险与约束

- Hook bus 过早泛化会增加抽象成本，因此第一版只允许少量明确 effect。
- 如果 effect reducer 不集中，handler 可能重新变成散落的副作用入口；实现阶段必须保持统一落地。
- 权限 hook 的 `allow` 语义需要谨慎，必须明确不能绕过硬安全边界。
- 插件 hook 只做接口预留，不在第一版实现动态加载，避免安全模型不完整。
- 当前工作树已有其他未提交改动，实施时必须保持变更范围只覆盖 workflow hook 相关文件。

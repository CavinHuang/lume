# Lume Agent Loop 边界设计文档

> 目标：把 Agent Loop 定义为 Agent Runtime Kernel 内部的 loop engine，而不是 sidecar handler、agent-service 或 SDK adapter 的副作用。Loop 的最终态边界是：输入标准化、上下文治理、工具调用边界、事件生成、interruption、checkpoint、finalization 都属于 Kernel；provider、MCP、skills、filesystem 等具体能力通过 adapter 接入。

---

## 1. 背景与问题

Alice 的 Agent Loop 文章里有一个关键判断：Agent 主循环的核心虽然可以抽象成“LLM 调用 -> 工具执行 -> 结果写回 -> 继续循环”，但生产可用系统真正复杂的是循环内部的上下文管理、工具集动态计算、事件流、取消、错误终止、后台任务和可观测性。

Lume 当前已经具备不少基础：

- `agent-service.ts` 负责消息发送、模型选择、消息持久化、runtime 状态、自动标题、memory flush 等。
- `runPiAgent` / `runRuntimeCoreAttempt` 负责 attempt、retry、abort、权限审批、guardrail。
- `LumeRunner` 负责创建 runtime session、调用 `agent.query(...)`、消费流式结果、complete/abort/fail。
- `consumeRuntimeCoreQueryStream` 已经消费 `AsyncIterable<SDKMessage>`。
- `LumeRunObserver` 已经把 SDKMessage 转为 run items / run events，并写入 run state 和 trace。
- `createRuntimeCoreSession` 已经做动态工具集、context assembly、MCP、skills、subagent、agent options 组装。

问题不在“没有 Agent Loop”，而在：

1. **Lume 自己的 Agent Loop 合约不清楚**  
   当前底层依赖 `@lume/agent-sdk` 的 `SDKMessage`，上层 UI 和状态系统间接消费多种事件。缺少一个稳定的 `LumeRuntimeEvent` 作为产品级协议。

2. **`agent-service.ts` 职责过重**  
   它同时做消息版本、模型选择、runtime 调用、SDK message 持久化、assistant message 生成、memory flush、title 等，后续继续加功能会难维护。

3. **事件流与最终消息边界不清晰**  
   用户体验应该依赖流式事件，最终 message 只做持久化确认。当前容易形成“等最终 assistant message 才展示”的延迟体感。

4. **上下文整形和压缩缺少明确层级**  
   需要有工具调用伴随文字处理、孤立 tool_use 修复、大工具结果裁剪、紧急压缩重试等标准步骤。

5. **循环终止条件需要标准化**  
   当前有 abort、maxTurns、errored、turn_limited，但需要统一成产品级状态和事件：completed / turn_limited / cancelled / failed / waiting_for_user / waiting_for_approval。

6. **循环结束后的后台任务缺少统一 PostRunPipeline**  
   memory extraction、profile update、skill improvement、title generation、run summary 应该统一进入后台收尾管线，不阻塞用户看到响应。

---

## 2. 设计目标

### 2.1 用户体验目标

- 发送消息后立即显示用户消息和临时 assistant 消息。
- `assistant.delta` 到达后立即流式渲染，不等待最终 message。
- 工具执行状态实时展示，但默认折叠，减少注意力噪音。
- 长任务可以取消、暂停、继续、恢复。
- 出错后用户能看到清晰状态：失败、等待权限、等待用户输入、达到轮次上限、可继续执行。

### 2.2 工程目标

- Agent Loop 输入输出标准化。
- SDK 原始事件和 Lume 产品事件解耦。
- Runtime Event 成为 UI、trace、run state、task progress 的共同基础。
- Context Assembly、Message Shaping、Tool Resolution、PostRunPipeline 可独立测试。
- 保留现有 `@lume/agent-sdk` 能力，不立即重写底层 while loop。
- 为后续 worker isolation、checkpoint、resume、replay 打基础。

---

## 3. Agent Runtime Kernel 边界

### 3.1 Kernel 内部结构

```text
Agent Runtime Kernel
  ├── Kernel API
  │   ├── dispatchRun(input)
  │   ├── resumeRun(runId)
  │   ├── cancelRun(runId)
  │   └── answerInterruption(...)
  │
  ├── Run / Session State
  │   ├── run state machine
  │   ├── session transcript view
  │   ├── pending interruptions
  │   └── checkpoints
  │
  ├── Loop Engine
  │   ├── context assembly
  │   ├── prompt layout
  │   ├── message shaping
  │   ├── model stream adapter
  │   ├── tool call boundary
  │   ├── compaction
  │   └── finalization
  │
  ├── Event Projector
  │   ├── SDKMessage -> RunItem
  │   ├── RunItem -> RuntimeEvent
  │   └── RuntimeEvent -> persisted trace/replay facts
  │
  └── Runtime Ports
      ├── ModelProviderPort
      ├── ToolRuntimePort
      ├── ServiceRuntimePort
      ├── TracePort
      └── StoragePort
```

### 3.2 Loop 不拥有的职责

Agent Loop 不应该：

- 管理 sidecar 进程生命周期。
- 处理 Tauri IPC 或 WebView 投影。
- 直接加载 MCP server、skill 目录或 provider SDK。
- 自行判断工具可见性和审批。
- 直接执行后台记忆抽取、标题生成、workspace watcher。
- 把 SDKMessage 作为 UI 或长期协议暴露出去。

### 3.3 核心流转

```text
UserMessage
  -> Sidecar Runtime Host validates command
  -> Agent Runtime Kernel dispatchRun
  -> AgentLoopInput
  -> Run state created
  -> Context Assembly
  -> ToolRuntime.resolveVisibleTools
  -> Message Shaping
  -> ModelProviderPort.stream
  -> SDK/provider event adapter
  -> RunItem
  -> RuntimeEvent
  -> ToolRuntime.execute when tool call appears
  -> Checkpoint after important boundaries
  -> Finalize run
  -> ServiceRuntime.schedulePostRunJobs
```

### 3.4 Loop 的真相边界

| 事项 | 所属边界 | 说明 |
|---|---|---|
| 本轮输入和模型选择快照 | Kernel | Run 创建时固化，之后不从 UI 反读 |
| 上下文构造结果 | Kernel | Trace 记录 hash/token，不让 UI 拼 prompt |
| 工具可见性结果 | Tool Runtime | Kernel 只消费 resolver 输出 |
| 工具调用生命周期 | Tool Runtime + Kernel | Tool Runtime 执行；Kernel 记录 event/interruption/checkpoint |
| 流式文本 | Kernel | 转为 RuntimeEvent，最终 message 只是持久化确认 |
| 等待用户/审批 | Kernel | interruption 是 run 状态，不是 UI 临时状态 |
| Post-run jobs | Service Runtime | Kernel 调度，不阻塞主响应完成 |

---

## 4. 核心类型设计

### 4.1 AgentLoopInput

新增文件：

```text
packages/shared/src/types/agent-loop.ts
```

建议定义：

```ts
export interface AgentLoopInput {
  threadId: string;
  runId: string;
  userMessage: string;
  workspaceId?: string;
  workspaceSlug?: string;
  threadType?: "direct" | "subagent" | string;
  chatType?: "direct" | "automation" | string;
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  model: {
    provider: string;
    modelId: string;
    modelRef?: string;
    channelId?: string;
    contextWindow?: number;
    maxTokens?: number;
  };
  messageMetadata?: Record<string, unknown>;
  runtimeOptions?: {
    maxTurns?: number;
    includePartialMessages?: boolean;
    resume?: boolean;
  };
}
```

### 4.2 LumeRuntimeEvent

新增文件：

```text
packages/shared/src/types/runtime-event.ts
```

建议定义：

```ts
export type LumeRuntimeEvent =
  | RunStartedEvent
  | AssistantDeltaEvent
  | AssistantFinalEvent
  | AssistantThinkingDeltaEvent
  | ToolCallStartedEvent
  | ToolCallCompletedEvent
  | ToolCallFailedEvent
  | PermissionRequestedEvent
  | AskUserRequestedEvent
  | ContextCompactionStartedEvent
  | ContextCompactionCompletedEvent
  | UsageUpdatedEvent
  | RunCompletedEvent
  | RunTurnLimitedEvent
  | RunFailedEvent
  | RunCancelledEvent;

export interface RuntimeEventBase {
  id: string;
  type: string;
  threadId: string;
  runId: string;
  createdAt: string;
  sequence?: number;
}

export interface AssistantDeltaEvent extends RuntimeEventBase {
  type: "assistant.delta";
  delta: string;
  messageId?: string;
}

export interface ToolCallStartedEvent extends RuntimeEventBase {
  type: "tool.started";
  toolCallId: string;
  toolName: string;
  inputPreview?: unknown;
  riskLevel?: "low" | "medium" | "high";
}

export interface ToolCallCompletedEvent extends RuntimeEventBase {
  type: "tool.completed";
  toolCallId: string;
  toolName: string;
  resultPreview?: string;
  resultRef?: {
    kind: "file";
    path: string;
    size: number;
  };
}

export interface RunCompletedEvent extends RuntimeEventBase {
  type: "run.completed";
  finalMessageId?: string;
}
```

### 4.3 三层事件模型

```text
SDKMessage
  - 来自 @lume/agent-sdk 或 provider adapter
  - 只在 adapter 内部使用

LumeRunItem
  - Kernel 内部可持久化运行事实
  - 用于 run state / checkpoint / replay

LumeRuntimeEvent
  - 产品级事件
  - UI、trace、debug、service callbacks 消费
```

最终态要求：

- UI 不消费 SDKMessage。
- Trace 不记录未治理的大 payload。
- Replay 以 Kernel 事实和 RuntimeEvent 为基础，而不是 provider 原始流。
- RuntimeEvent 的事件名使用产品语义，不继承 SDK 命名。

---

## 5. Agent Loop 模块拆分

### 5.1 目标目录

```text
apps/sidecar/src/services/agent-runtime/loop/
  agent-loop.ts
  loop-types.ts
  sdk-message-adapter.ts
  runtime-event-projector.ts
  run-finalizer.ts
  run-cancellation.ts

apps/sidecar/src/services/agent-runtime/context/
  context-assembler.ts              # 已存在，继续演进
  prompt-cache-layout.ts
  dynamic-system-tail.ts
  context-budget.ts
  context-compaction/
    compact-tool-results.ts
    fold-history-turns.ts
    full-summary-compaction.ts
    emergency-compact-and-retry.ts

apps/sidecar/src/services/agent-runtime/message-shaping/
  repair-orphan-tool-calls.ts
  strip-tool-call-assistant-text.ts
  sanitize-large-tool-results.ts
  inject-dynamic-system-tail.ts

apps/sidecar/src/services/agent-runtime/post-run/
  post-run-pipeline.ts
  memory-extraction-job.ts
  user-profile-update-job.ts
  skill-improvement-job.ts
  title-generation-job.ts
  run-summary-job.ts
```

### 5.2 Sidecar Runtime Host 与 Kernel API

新增：

```text
apps/sidecar/src/services/agent-runtime/runtime-orchestrator.ts
```

职责：

- 作为 Sidecar Runtime Host 调用 Kernel API 的 facade。
- 管理同线程 dispatch queue 和取消入口。
- 把 RuntimeEvent 转发给 EventBus。
- 把 host-level runtime status 暴露给 RPC。
- 不直接执行工具，不直接调用 LLM，不直接拼 prompt。
- 不拥有 run state 真相。

示例：

```ts
export class RuntimeOrchestrator {
  async dispatchUserMessage(input: AgentSendInput): Promise<AgentDispatchResult> {
    const run = await this.createRun(input);
    this.enqueue(input.threadId, async () => {
      for await (const event of this.agentLoop.run(buildLoopInput(input, run))) {
        await this.eventBus.publish(event);
      }
      await this.postRunPipeline.schedule(run);
    });
    return { ok: true, runId: run.runId, status: "sent" };
  }
}
```

---

## 6. 系统提示词设计

### 6.1 目标

让 prompt 结构对缓存友好，并且便于 trace 和测试。

### 6.2 Prompt Layout

```text
Stable Prefix
  - Lume 身份
  - 行为边界
  - 工具使用原则
  - 输出风格
  - 安全与权限规则

Semi-static Context
  - workspace 信息
  - 项目记忆摘要
  - 用户画像摘要
  - Skills 摘要
  - 可用工具说明摘要

Dynamic Tail
  - 当前日期
  - 当前运行模式
  - 当前任务状态
  - 最近权限拒绝摘要
  - 当前文件/选区上下文
  - 本轮用户输入相关上下文
```

### 6.3 实施

新增：

```text
apps/sidecar/src/services/agent-runtime/context/prompt-cache-layout.ts
apps/sidecar/src/services/agent-runtime/context/dynamic-system-tail.ts
```

Trace 记录：

```ts
{
  prompt: {
    staticPrefixHash,
    staticPrefixTokens,
    semiStaticTokens,
    dynamicTailTokens,
    totalTokens
  }
}
```

---

## 7. Message Shaping 设计

### 7.1 修复孤立工具调用

场景：

- 用户中断。
- sidecar 崩溃。
- 权限等待期间退出。
- 工具执行失败但没有写回 tool_result。
- subagent 中途异常。

处理：

```text
detect orphan tool_use
  -> inject synthetic tool_result
  -> mark recovered=true
  -> emit event: message_shaping.orphan_tool_repaired
```

事件：

```ts
{
  type: "message_shaping.orphan_tool_repaired",
  threadId,
  runId,
  toolCallId,
  toolName
}
```

### 7.2 工具调用伴随文字处理

规则：

```text
如果 assistant message 同时包含 text/thinking 和 tool_use：
  - text/thinking 可以进入 UI 和 trace
  - tool_use 进入下一轮上下文
  - text/thinking 默认不进入下一轮上下文
```

原因：

- “我来看看...”这类伴随文字对下一轮推理价值低。
- 长任务中会累计大量 token 浪费。
- 可观测性通过 UI/trace 保留，不需要污染 LLM 上下文。

实现：

```text
strip-tool-call-assistant-text.ts
```

### 7.3 大工具结果处理

规则：

```text
<= 64KB: inline
> 64KB: preview + file_ref
```

类型：

```ts
export type ToolResultPayload =
  | { kind: "inline"; content: string }
  | { kind: "file_ref"; path: string; preview: string; size: number };
```

---

## 8. 上下文压缩设计

### 8.1 分层压缩

```text
Level 1: remove redundant transient text
Level 2: compact large tool results
Level 3: fold old turns into summaries
Level 4: full conversation summary
Emergency: context length error 后深度压缩并重试一次
```

### 8.2 事件

```ts
{ type: "context.compaction.started", level, reason }
{ type: "context.compaction.completed", level, beforeTokens, afterTokens }
{ type: "context.compaction.failed", level, error }
```

### 8.3 验收标准

- 超大工具结果不会直接进入下一轮上下文。
- 达到上下文阈值时能产生可观察的 compaction event。
- context length error 能触发一次 emergency compaction。
- trace 面板能看到压缩前后 token。

---

## 9. 终止条件标准化

### 9.1 状态

```ts
export type AgentLoopExitStatus =
  | "completed"
  | "turn_limited"
  | "cancelled"
  | "failed"
  | "waiting_for_user"
  | "waiting_for_approval";
```

### 9.2 规则

| 条件 | 状态 | 后续动作 |
|---|---|---|
| 无工具调用，生成最终回答 | completed | finalize + post-run |
| 达到 maxTurns | turn_limited | emit 可继续执行事件 |
| 用户取消 | cancelled | flush observer + mark cancelled |
| 不可恢复错误 | failed | emit failed + trace fail |
| AskUserQuestion | waiting_for_user | 持久化 interruption |
| Tool permission | waiting_for_approval | 持久化 approval request |

### 9.3 与现有代码关系

当前 `consumeRuntimeCoreQueryStream` 已经识别 `error_max_turns` 并返回 `turn_limited`，`LumeRunner` 也能处理 completed/failed/abort。后续需要把这些状态映射为统一 RuntimeEvent，而不是只作为内部 result。

---

## 10. PostRunPipeline

### 10.1 设计目标

Agent 主响应完成后，异步执行后台任务，不影响用户看到结果。

### 10.2 任务

```text
memory extraction
user profile update
skill improvement analysis
title generation
run summary
workspace index refresh
```

### 10.3 接口

```ts
export interface PostRunJob {
  id: string;
  run(input: PostRunInput): Promise<void>;
  timeoutMs?: number;
  retry?: number;
}

export class PostRunPipeline {
  schedule(input: PostRunInput): void;
}
```

### 10.4 规则

- 主响应完成后触发。
- 失败只记录 trace/log，不影响对话完成状态。
- 限制并发。
- 支持全局开关和 workspace 开关。
- 后台任务不应该作为 AI 可见工具暴露。

---

## 11. 文件级实施计划

### Phase 1：协议和文档

新增：

```text
docs/architecture/agent-loop.md
packages/shared/src/types/runtime-event.ts
packages/shared/src/types/agent-loop.ts
```

修改：

```text
packages/shared/src/types/agent.ts
```

输出：

- RuntimeEvent 类型定义。
- AgentLoopInput / AgentLoopResult 类型定义。
- 事件命名规范。

### Phase 2：事件适配层

新增：

```text
apps/sidecar/src/services/agent-runtime/loop/sdk-message-adapter.ts
apps/sidecar/src/services/agent-runtime/loop/runtime-event-projector.ts
```

修改：

```text
apps/sidecar/src/services/agent-runtime/runner/run-observer.ts
apps/sidecar/src/services/agent-runtime/runner/run-loop.ts
```

目标：

- SDKMessage 不直接泄露到 UI。
- 统一输出 LumeRuntimeEvent。
- 保留现有 LumeRunItem 持久化。

### Phase 3：Agent Service 瘦身

新增：

```text
apps/sidecar/src/services/agent/agent-dispatch-queue.ts
apps/sidecar/src/services/agent/agent-message-persistence.ts
apps/sidecar/src/services/agent/agent-title-service.ts
apps/sidecar/src/services/agent-runtime/runtime-orchestrator.ts
```

修改：

```text
apps/sidecar/src/services/agent/agent-service.ts
apps/sidecar/src/rpc/agent-handlers.ts
```

目标：

- `agent-service.ts` 变成 facade。
- handler 只做入参校验和调用 orchestrator。

### Phase 4：Message Shaping

新增：

```text
apps/sidecar/src/services/agent-runtime/message-shaping/
```

接入点：

```text
createRuntimeCoreSession 或 agent.query 前
```

目标：

- 修复孤立工具调用。
- 工具调用伴随文字不写回下一轮上下文。
- 大工具结果 file_ref 化。

### Phase 5：上下文压缩

新增：

```text
apps/sidecar/src/services/agent-runtime/context/context-compaction/
```

目标：

- 工具结果压缩。
- 历史轮次折叠。
- emergency compact and retry。

### Phase 6：PostRunPipeline

新增：

```text
apps/sidecar/src/services/agent-runtime/post-run/
```

修改：

```text
apps/sidecar/src/services/agent/agent-service.ts
apps/sidecar/src/services/agent-runtime/runner/lume-runner.ts
```

目标：

- memory flush/title generation 等迁入统一管线。
- 主响应不等待后台任务。

---

## 12. 测试计划

### 12.1 单元测试

```text
sdk-message-adapter.test.ts
runtime-event-projector.test.ts
repair-orphan-tool-calls.test.ts
strip-tool-call-assistant-text.test.ts
sanitize-large-tool-results.test.ts
context-compaction.test.ts
post-run-pipeline.test.ts
```

### 12.2 集成测试

场景：

1. 普通问答，无工具调用，输出 completed。
2. 工具调用 + tool_result，输出 tool.started/tool.completed。
3. 工具调用伴随文字，不进入下一轮上下文。
4. AskUserQuestion 进入 waiting_for_user。
5. 权限审批进入 waiting_for_approval。
6. 用户取消进入 cancelled。
7. maxTurns 进入 turn_limited。
8. context length error 触发 emergency compaction。
9. 大工具结果被转成 file_ref。
10. sidecar 重启后可读取 run state 和 trace。

---

## 13. 验收标准

- UI 可以只依赖 `LumeRuntimeEvent` 渲染一轮完整对话。
- `SDKMessage` 不出现在 Web 层类型里。
- `agent-service.ts` 明显变薄，核心 runtime 逻辑迁到 `agent-runtime/`。
- 工具调用时的伴随文字不污染下一轮 LLM 上下文。
- 大 payload 不直接经过 IPC。
- run completed 后后台任务异步执行，不阻塞用户看到最终回答。
- Trace 面板可以看到 prompt assembly、tool call、compaction、usage、finalize。
- 取消、权限等待、用户输入等待、轮次上限都有统一状态和事件。

---

## 14. 不做事项

本轮不做：

- 不重写 `@lume/agent-sdk` 的底层 while loop。
- 不把 sidecar 迁移到 Electron。
- 不立即引入 worker_threads 隔离。
- 不做完整事件溯源数据库。
- 不把后台记忆提取变成 AI 可见工具。

---

## 15. 总结

Lume 当前不缺 Agent Loop 能力，缺的是 Agent Loop 的边界、协议和治理。

建议路线：

```text
现有 SDK loop
  -> Lume AgentLoopInput / LumeRuntimeEvent
  -> message shaping
  -> context compaction
  -> post-run pipeline
  -> trace/replay/resume
```

这条路线可以最大化复用现有代码，同时逐步补齐生产级 Agent Loop 的体验和可靠性。

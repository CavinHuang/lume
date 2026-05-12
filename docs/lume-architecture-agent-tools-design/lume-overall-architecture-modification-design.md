# Lume 整体架构边界设计文档

> 目标：在保留 Lume 当前 Tauri + Sidecar 技术路线的前提下，先定义最终态架构边界，再安排增量实施。最终态不是“sidecar 变成更大的业务层”，而是形成一个本地 Agent Runtime Kernel：它拥有 run/session/event/context/tool/interruption/checkpoint 的产品真相，Tauri、UI、Sidecar Host、Adapters 都围绕它协作。

---

## 1. 背景

Lume 当前的技术路线是：

```text
Tauri Desktop
  ├── WebView UI
  ├── Rust native shell
  └── Node/Bun Sidecar
        ├── RPC handlers
        ├── Agent runtime
        ├── Memory
        ├── Workspace
        ├── Automation
        ├── MCP
        └── Skills
```

这个选择和 Electron 方案相比，有明显优势：

- 包体更小。
- 内存占用更低。
- 原生能力通过 Rust/Tauri 管理更稳。
- 更符合 Lume “本地、轻量、长期陪伴型助手”的方向。

但代价也很明确：

- Node/TS 生态必须通过 sidecar 承载。
- UI、Rust、sidecar 之间存在多层 IPC。
- LLM 流式、工具事件、MCP stdio、文件结果等都需要桥接。
- 冷启动和首次消息可能有明显延迟。
- sidecar 如果只是“普通消息桥”，会很快变成复杂度中心。

因此，本设计文档的核心判断是：

> Lume 不需要迁移 Electron，但必须把 sidecar 从“桥接进程”升级为“本地 Runtime 宿主”；真正的产品真相由 Agent Runtime Kernel 持有。

---

## 2. 当前架构问题

### 2.1 缺少正式系统地图

Lume 已经有 UI、Tauri、sidecar、agent runtime、memory、MCP、automation、workspace、plan mode、task contract、trace 等模块。

但这些模块之间的边界还不够系统化：

- 哪些逻辑属于 UI？
- 哪些逻辑属于 Tauri？
- 哪些逻辑属于 sidecar orchestration？
- 哪些逻辑属于 Agent Loop？
- 哪些是 AI 可见工具？
- 哪些是后台服务？
- 哪些状态必须持久化？
- 哪些事件只是 UI 临时状态？

缺少系统地图后，出现延迟、工具异常、计划状态错乱、记忆不生效、sidecar 崩溃恢复等问题时，很难快速定位。

---

### 2.2 Sidecar 职责过重但身份不清

当前 sidecar 实际上承担了：

```text
RPC server
Agent runtime
Model provider adapter
Tool host
Memory service
Automation service
Workspace watcher
MCP host
Skills loader
Trace recorder
Run state store
```

这些职责本身合理，但需要明确分层。否则 sidecar 会变成“大泥球”。

---

### 2.3 Tauri 层还不是 Runtime Manager

当前 Tauri 主要做：

- sidecar spawn。
- stdin/stdout JSON line RPC。
- sidecar event 转发。
- native dialog。
- window/tray。
- update。

但从产品体验角度，它还应该负责：

- sidecar ready 状态。
- sidecar health monitor。
- sidecar crash recovery。
- IPC latency metrics。
- sidecar event bridge。
- 大 payload 传输策略。
- 应用启动预热。

也就是说，Tauri 不应该理解业务，但应该是 sidecar 生命周期管理器。

---

### 2.4 UI 对 runtime 状态的投影还不够统一

UI 当前可能同时依赖：

- thread messages。
- run events。
- runtime status。
- plan phase。
- task progress。
- sidecar events。
- message appended。

这种方式短期能跑，但长期会导致 UI 逻辑分散。

目标应该是：

```text
RuntimeEvent -> UI Projection
```

UI 不直接理解 SDKMessage，不直接拼 runtime 内部状态，只消费标准事件和派生视图。

---

### 2.5 Agent Loop、工具系统、状态系统没有统一协议中心

当前 Lume 已有：

- `LumeRunner`
- `consumeRuntimeCoreQueryStream`
- `LumeRunObserver`
- `RunStateStore`
- `TraceStore`
- `TaskContractStore`
- `ToolPolicy`
- `ToolMetadata`

但缺少一个贯穿它们的统一核心协议：

```text
LumeRuntimeEvent
```

它应该成为：

- UI 渲染来源。
- Run state 投影来源。
- Trace 记录来源。
- Task progress 来源。
- Debug panel 来源。
- Replay / Resume 基础。

---

## 3. 最终态架构边界

### 3.1 核心边界原则

最终态的边界定义先于文件拆分：

1. **Agent Runtime Kernel 是产品真相来源**  
   Run、session、runtime event、context、tool call、interruption、checkpoint、resume/replay 的权威状态都属于 Kernel。

2. **Sidecar Runtime Host 是宿主，不是业务真相来源**  
   它负责 RPC、服务生命周期、进程内调度、队列、事件传输和依赖注入，但不直接拼 prompt、不直接执行工具、不直接写 UI message。

3. **Tool Runtime 是 AI 可见能力边界**  
   只要模型能主动选择调用，就必须进入 Tool Runtime 的 registry、visibility、approval、execution、payload、event 治理。

4. **Service Runtime 是 AI 不可见自动能力边界**  
   标题、记忆抽取、profile 更新、workspace watcher、trace recorder、automation runner 等后台能力由 Service Runtime 管理，不暴露成模型工具。

5. **Adapters 只做外部能力接入**  
   Model provider、MCP、skills、filesystem、browser、web search、subagent transport 都是 adapter。Adapter 不拥有 run 状态，不决定产品语义。

6. **UI 和 Tauri 只消费投影和控制命令**  
   UI 做交互和 projection；Tauri 做 native host、sidecar lifecycle、IPC、大 payload 读取。两者都不拥有 Agent Loop 内部状态。

### 3.2 总体分层

```text
┌──────────────────────────────────────────────┐
│ UI Layer                                     │
│ interaction / optimistic view / projections  │
└──────────────────────┬───────────────────────┘
                       │ commands + event stream
┌──────────────────────▼───────────────────────┐
│ Tauri Host Layer                              │
│ window / tray / update / sidecar lifecycle    │
│ IPC bridge / ready / health / native payloads │
└──────────────────────┬───────────────────────┘
                       │ local IPC
┌──────────────────────▼───────────────────────┐
│ Sidecar Runtime Host                          │
│ RPC / service lifecycle / queues / event bus  │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ Agent Runtime Kernel                          │
│ run / session / events / context / checkpoints│
│ loop engine / interruption / replay / resume  │
└──────────────────────┬───────────────────────┘
                       │
       ┌───────────────┴────────────────┐
       ▼                                ▼
┌──────────────────────┐        ┌──────────────────────┐
│ Tool Runtime          │        │ Service Runtime       │
│ AI-visible capability │        │ AI-invisible jobs     │
│ registry / execution  │        │ memory / title / etc. │
└──────────┬───────────┘        └──────────┬───────────┘
           │                               │
           └───────────────┬───────────────┘
                           ▼
┌──────────────────────────────────────────────┐
│ Adapter Layer                                 │
│ model / MCP / skills / subagent / fs / web    │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│ Infrastructure Layer                          │
│ storage / config / encryption / logs / payload│
└──────────────────────────────────────────────┘
```

### 3.3 真相归属矩阵

| 领域 | 真相来源 | 其他层如何使用 |
|---|---|---|
| Run 状态 | Agent Runtime Kernel | UI 只消费 projection；Sidecar Host 只转发和调度 |
| RuntimeEvent | Agent Runtime Kernel | Trace、UI、debug、replay 使用同源事件 |
| Tool 可见性 | Tool Runtime | Agent Loop 请求当前可见工具，不自行拼工具列表 |
| Tool 审批和执行 | Tool Runtime | UI 提供用户决策；Kernel 记录 interruption 和结果 |
| Context 和 compaction | Agent Runtime Kernel | Service Runtime 可提供 memory 摘要，但不直接改 context |
| Post-run 后台任务 | Service Runtime | Kernel 只调度任务并接收事件，不等待任务成为主响应 |
| Sidecar 生命周期 | Tauri Host | UI 展示状态；Kernel 不处理进程生命周期 |
| Provider/MCP/Skill 接入 | Adapter Layer | Kernel/Tool Runtime 通过接口调用，不绑定具体实现 |

---

## 4. 各层职责

### 4.1 UI Layer

职责：

- 展示消息。
- 展示工具调用。
- 展示计划、任务、trace、文件预览。
- 消费 RuntimeEvent。
- 做乐观 UI。
- 做临时 assistant message 投影。
- 处理用户输入、审批、取消、继续。

不应该做：

- 不拼 prompt。
- 不判断工具权限。
- 不直接理解 SDKMessage。
- 不直接做 memory flush。
- 不直接决定 plan/task 状态机。
- 不做业务数据持久化。

推荐结构：

```text
apps/web/src/features/agent/
  runtime-event-store.ts
  message-projection.ts
  tool-call-projection.ts
  plan-projection.ts
  task-projection.ts
  trace-projection.ts
```

---

### 4.2 Tauri Runtime Manager

职责：

- 启动 sidecar。
- 预热 sidecar。
- 监听 sidecar stdout/stderr。
- 转发 RuntimeEvent。
- 提供 sidecar status。
- 处理 sidecar 崩溃和重启。
- 管理 native window/tray/update/dialog。
- IPC latency 埋点。
- 大 payload file_ref 打开和读取。

不应该做：

- 不执行业务工具。
- 不调用 LLM。
- 不理解 Agent Loop。
- 不做 prompt。
- 不做 memory 逻辑。

建议状态：

```ts
type SidecarStatus =
  | "not_started"
  | "starting"
  | "ready"
  | "degraded"
  | "crashed"
  | "restarting"
  | "stopped";
```

建议事件：

```ts
type SidecarLifecycleEvent =
  | { type: "sidecar.starting" }
  | { type: "sidecar.ready"; pid: number }
  | { type: "sidecar.crashed"; reason: string }
  | { type: "sidecar.restarting" }
  | { type: "sidecar.stopped" };
```

---

### 4.3 Sidecar Runtime Host

职责：

- RPC handlers 的统一入口和依赖注入边界。
- 管理 Sidecar 内部服务生命周期。
- 管理 thread/run dispatch queue 和并发限制。
- 承载 EventBus，把 Kernel / Tool Runtime / Service Runtime 事件转发给 Tauri。
- 管理 workspace watcher、automation runner、memory sync watcher 等服务的启动停止。
- 提供 runtime status 的宿主级聚合视图。

不应该做：

- 不直接执行工具。
- 不直接调用 LLM。
- 不直接写 UI message。
- 不把 SDKMessage 暴露给 UI。
- 不拥有 run/session/checkpoint 的业务真相。
- 不决定 Tool visibility / approval 语义。

建议新增：

```text
apps/sidecar/src/services/agent-runtime/runtime-orchestrator.ts
apps/sidecar/src/services/agent-runtime/event-bus.ts
apps/sidecar/src/services/agent-runtime/session-manager.ts
```

---

### 4.4 Agent Runtime Kernel

职责：

- Run / Session 状态机。
- RuntimeEvent 协议。
- Context Assembly。
- Prompt Layout。
- Dynamic Tool Resolution。
- Message Shaping。
- LLM stream。
- SDK adapter。
- Tool Runtime 调用边界。
- Interruption 状态。
- Checkpoint / Resume / Replay。
- Context compaction。
- Run finalization。
- RuntimeEvent 生成。

不应该做：

- 不管理窗口。
- 不处理 Tauri IPC。
- 不直接操作 UI。
- 不做后台长期服务的生命周期管理。
- 不直接包含 provider/MCP/skill/filesystem 的具体实现。

推荐结构：

```text
apps/sidecar/src/services/agent-runtime/
  loop/
  context/
  message-shaping/
  tools/
  plan/
  task-run/
  runner/
  trace/
  post-run/
```

---

### 4.5 Tool Runtime

定义：

> AI 可见、AI 可以主动调用的能力。

包括：

- Read / Write / Edit / Bash。
- Glob / Grep / ls。
- WebSearch / WebFetch。
- AskUserQuestion。
- TaskContractWrite。
- TaskReport。
- Memory read/search。
- MCP tools。
- Skill tools。
- Subagent Task。

工具必须有：

- 名称。
- 描述。
- 输入 schema。
- 风险等级。
- 是否只读。
- 是否 plan-safe。
- 并发安全属性。
- payload policy。
- approval policy。

Tool Runtime 是 Kernel 的子域，但有独立边界：Kernel 只表达“本轮需要哪些能力”和“某个工具调用完成/失败/等待审批”，具体工具来源、可见性、审批、执行、payload 治理由 Tool Runtime 负责。

---

### 4.6 Service Runtime

定义：

> AI 不可见、框架内部自动运行的能力。

包括：

- 自动标题生成。
- 记忆提取。
- 用户画像更新。
- Skill 改进分析。
- Workspace watcher。
- Automation runner。
- Trace recorder。
- Context compaction。
- Sidecar health monitor。
- Default skills seeder。

判断标准：

```text
如果 AI 主动触发该功能是用户期望行为，则做成工具。
如果不是，则做成服务。
```

Service Runtime 可以由 Kernel 调度，也可以由 Sidecar Runtime Host 按生命周期启动；但服务不能绕过 Kernel 直接改写 run state。需要影响用户可见状态时，必须通过 RuntimeEvent 或明确的 service event 回写。

---

### 4.7 Adapter Layer

定义：

> 外部能力、外部协议和具体实现的接入层。

包括：

- Model provider adapters。
- MCP stdio/http/sse adapters。
- Skills loader 和 skill manifest adapter。
- Subagent transport adapter。
- Filesystem / shell / browser / web adapters。
- Native payload reader adapter。

Adapter 的规则：

- 不拥有业务状态。
- 不定义产品事件语义。
- 不直接修改 UI message。
- 不绕过 Tool Runtime 执行 AI 可见能力。
- 失败要返回结构化错误，让 Kernel 或 Tool Runtime 决定产品状态。

---

### 4.8 Infrastructure Layer

职责：

- File-backed stores。
- Config。
- Encryption。
- Logging。
- Trace。
- Metrics。
- Payload store。
- Atomic writes。
- Schema migration。

推荐统一：

```text
apps/sidecar/src/services/infra/
  storage/
  config/
  crypto/
  logger/
  metrics/
  payload-store/
```

---

## 5. 核心数据流

### 5.1 一次对话的完整旅程

```text
1. 用户在 UI 输入消息
2. UI 乐观插入 user message
3. UI 调用 agentSend
4. Tauri sidecar_call 转发给 sidecar
5. Sidecar RPC handler 校验输入
6. RuntimeOrchestrator 创建 run
7. AgentRuntime 组装上下文
8. ToolResolver 计算本轮可见工具集
9. MessageShaping 修复上下文
10. SDK agent.query 开始流式执行
11. SDKMessage 转为 LumeRuntimeEvent
12. RuntimeEvent 写入 run state / trace
13. RuntimeEvent 经 sidecar -> Tauri -> UI
14. UI 根据事件流式渲染
15. Agent Loop 完成
16. Final assistant message 持久化
17. PostRunPipeline 异步执行记忆、标题、Skill 分析等
```

### 5.2 事件流方向

```text
Agent Runtime
  -> Sidecar EventBus
  -> Tauri Runtime Manager
  -> WebView UI
```

注意：事件是单向流动。UI 可以发控制命令，比如 cancel/resume/approval，但不反向修改 runtime 内部状态。

---

## 6. 统一 RuntimeEvent 协议

### 6.1 为什么需要 RuntimeEvent

统一 RuntimeEvent 后：

- UI 不依赖 SDKMessage。
- Trace 和 UI 使用同源数据。
- Run replay 变得可行。
- Sidecar crash recovery 更容易。
- 工具调用、计划、任务、消息都可以统一投影。
- 延迟问题可观测。

### 6.2 事件类别

```text
run.*
message.*
assistant.*
tool.*
permission.*
ask_user.*
plan.*
task.*
context.*
memory.*
trace.*
sidecar.*
usage.*
```

### 6.3 示例

```ts
type LumeRuntimeEvent =
  | { type: "run.started"; threadId: string; runId: string }
  | { type: "assistant.delta"; threadId: string; runId: string; delta: string }
  | { type: "tool.started"; threadId: string; runId: string; toolCallId: string; toolName: string }
  | { type: "tool.completed"; threadId: string; runId: string; toolCallId: string }
  | { type: "permission.requested"; threadId: string; runId: string; requestId: string }
  | { type: "plan.awaiting_approval"; threadId: string; contractId: string }
  | { type: "context.compaction.completed"; threadId: string; runId: string }
  | { type: "run.completed"; threadId: string; runId: string }
  | { type: "run.failed"; threadId: string; runId: string; error: string };
```

---

## 7. 状态模型

### 7.1 Thread

```text
Thread
  - messages
  - active run
  - workspace
  - model selection
  - title
```

### 7.2 Run

```text
Run
  - runId
  - threadId
  - status
  - input
  - model
  - generatedItems
  - pendingInterruptions
  - usage
  - traceId
```

### 7.3 Plan / Task

```text
TaskContract
  - id
  - threadId
  - status
  - tasks
  - approvedAt
  - updatedAt

TaskRun
  - id
  - contractId
  - threadId
  - currentTaskId
  - status
  - events
```

### 7.4 Trace

```text
Trace
  - traceId
  - runId
  - spans
    - prompt assembly
    - memory retrieval
    - model routing
    - LLM call
    - tool call
    - compaction
    - finalization
```

---

## 8. Sidecar 生命周期设计

### 8.1 启动预热

当前延迟问题的重要来源是首次调用才承担 sidecar 冷启动。建议改为：

```text
Tauri setup
  -> 创建窗口
  -> 异步启动 sidecar
  -> sidecar boot
  -> sidecar 发 system.ready
  -> Tauri 缓存 ready
  -> UI 显示 Agent 可用
```

### 8.2 Ready 事件

sidecar boot 完成后发：

```json
{
  "method": "system.ready",
  "params": {
    "pid": 1234,
    "startedAt": "...",
    "features": ["agent", "memory", "mcp", "automation"]
  }
}
```

### 8.3 Healthcheck

Tauri 定期或按需调用：

```text
sidecar_healthcheck
```

如果失败：

```text
ready -> degraded -> crashed -> restarting -> ready
```

### 8.4 崩溃恢复

策略：

```text
1. Tauri 检测 sidecar stdout 关闭或 child exit
2. UI 收到 sidecar.crashed
3. Tauri 尝试重启 sidecar
4. Sidecar 启动后扫描 active run state
5. 标记未完成 run 为 interrupted/resumable
6. UI 提供继续/重试
```

---

## 9. IPC 与 Payload 策略

### 9.1 IPC 路线

短期保留：

```text
JSON-RPC over stdio
```

中期可以评估：

```text
local socket / named pipe
```

但当前最重要的是协议治理，不是立刻换 IPC。

### 9.2 大 Payload 不走 IPC

对于大文件、命令输出、网页内容、MCP 大 JSON：

```text
<= 64KB inline
> 64KB preview + file_ref
```

结构：

```ts
type Payload =
  | { kind: "inline"; content: string }
  | { kind: "file_ref"; path: string; preview: string; size: number };
```

UI 展示 preview，需要时再读取完整内容。

---

## 10. 配置层级

吸收配置层级思想，Lume 建议采用：

```text
Global Default
  < System Config
  < Workspace Config
  < User Settings
  < Thread Settings
  < Run Metadata
```

### 10.1 层级说明

| 层级 | 内容 | 存储 |
|---|---|---|
| Global Default | 内置默认模型、权限、工具策略 | 代码 |
| System Config | 全局 runtime/tool/memory 配置 | config json/yaml |
| Workspace Config | workspace 下的 lume.yaml | workspace |
| User Settings | UI 偏好、默认模型、供应商 | settings.json/db |
| Thread Settings | 当前线程模型、模式 | thread meta |
| Run Metadata | 临时工具策略、自动化上下文 | run input |

### 10.2 冲突规则

```text
高优先级覆盖低优先级
Run Metadata 不持久化为长期偏好
Thread Settings 可持久化
Workspace Config 只影响该 workspace
System Config 作为全局默认
```

---

## 11. 目录结构建议

### 11.1 Sidecar

```text
apps/sidecar/src/
  rpc/
    agent-handlers.ts
    system-handlers.ts
    ...
  orchestrator/
    runtime-orchestrator.ts
    session-orchestrator.ts
    service-orchestrator.ts
  services/
    agent-runtime/
      loop/
      context/
      message-shaping/
      tools/
      plan/
      task-run/
      runner/
      trace/
      post-run/
    memory/
    automation/
    system/
    infra/
```

如果不想新建 `orchestrator/` 顶层，也可以放到：

```text
apps/sidecar/src/services/agent-runtime/runtime-orchestrator.ts
```

### 11.2 Web

```text
apps/web/src/features/agent/
  api/
  store/
  projections/
    message-projection.ts
    tool-projection.ts
    plan-projection.ts
    task-projection.ts
    trace-projection.ts
  components/
```

### 11.3 Shared

```text
packages/shared/src/types/
  runtime-event.ts
  agent-loop.ts
  tool.ts
  plan.ts
  task.ts
```

---

## 12. 可观测性设计

### 12.1 Trace 面板

右侧面板新增 `Trace` tab：

```text
Run
  - Context Assembly
  - Prompt Layout
  - Memory Retrieval
  - Tool Resolution
  - LLM Stream
  - Tool Calls
  - Permissions
  - Compaction
  - Post Run Jobs
```

### 12.2 Metrics

关键埋点：

```text
app_start
sidecar_spawn_start
sidecar_spawn_ok
sidecar_ready
first_rpc_write
first_rpc_response
run_started
first_runtime_event
first_assistant_delta
first_tool_started
run_completed
post_run_started
post_run_completed
```

这些埋点可以直接定位：

- 冷启动慢。
- sidecar 慢。
- 模型首 token 慢。
- 工具执行慢。
- UI 渲染慢。
- 后台任务阻塞。

---

## 13. 可靠性设计

### 13.1 Run Checkpoint

后续支持：

```text
before_llm_call
before_tool_call
after_tool_call
after_message_persist
after_run_finalize
```

### 13.2 Resume

恢复策略：

```text
读取 run state
找到最近 checkpoint
清理 partial assistant delta
修复 orphan tool_use
重新进入 loop
```

### 13.3 Worker Isolation

短期不做。中期可以把 Agent Loop 放入 sidecar 内部 worker_threads：

```text
Sidecar Runtime Host
  -> Agent Runtime Kernel Worker
```

收益：

- Agent loop 崩溃不拖垮 sidecar。
- 长任务不阻塞 sidecar 服务。
- 多会话隔离更清楚。

代价：

- 需要 worker 消息协议。
- 大 payload 克隆成本更明显。
- 需要 checkpoint/resume 先成熟。

---

## 14. 边界优先的实施路线

### Phase 0：最终态边界

新增：

```text
docs/architecture/runtime-kernel-boundary.md
docs/architecture/agent-loop-boundary.md
docs/architecture/tool-runtime-boundary.md
docs/architecture/runtime-event-protocol.md
```

目标：

- 确认 Agent Runtime Kernel 是产品真相来源。
- 确认 Sidecar Runtime Host / Tool Runtime / Service Runtime / Adapter 的边界。
- 确认 RuntimeEvent、RunItem、Checkpoint 的协议关系。

---

### Phase 1：Host 边界

修改：

```text
apps/desktop/src-tauri/src/main.rs
apps/sidecar/src/index.ts
apps/web/src/lib/desktop-api/
```

任务：

- sidecar 预热。
- system.ready。
- sidecar status。
- healthcheck。
- crash event。
- UI 显示 Runtime 状态。
- 明确 Tauri Host 和 Sidecar Runtime Host 都不拥有 run 真相。

---

### Phase 2：Kernel 协议

新增：

```text
packages/shared/src/types/runtime-event.ts
packages/shared/src/types/agent-loop.ts
apps/sidecar/src/services/agent-runtime/event-bus.ts
apps/sidecar/src/services/agent-runtime/loop/runtime-event-projector.ts
```

任务：

- AgentLoopInput / AgentLoopResult。
- RunItem / RuntimeEvent / Checkpoint 关系。
- SDKMessage -> RunItem -> RuntimeEvent。
- Tool/Plan/Task/Usage/Interruption 事件标准化。
- UI projection 改造。

---

### Phase 3：Sidecar Runtime Host 与 agent-service facade

新增：

```text
apps/sidecar/src/services/agent-runtime/runtime-orchestrator.ts
apps/sidecar/src/services/agent/agent-dispatch-queue.ts
apps/sidecar/src/services/agent/agent-message-persistence.ts
```

修改：

```text
apps/sidecar/src/services/agent/agent-service.ts
apps/sidecar/src/rpc/agent-handlers.ts
```

目标：

- handler 变薄。
- agent-service 变 facade。
- runtime-orchestrator 只做 Host facade，不拥有 Kernel 内部状态。

---

### Phase 4：Agent Runtime Kernel

新增：

```text
apps/sidecar/src/services/agent-runtime/message-shaping/
apps/sidecar/src/services/agent-runtime/context/context-compaction/
apps/sidecar/src/services/agent-runtime/post-run/
```

任务：

- orphan tool_use 修复。
- 工具调用伴随文字不进下一轮上下文。
- 大 payload file_ref。
- context compaction。
- post-run pipeline。
- checkpoint / interruption 状态标准化。

---

### Phase 5：Tool Runtime

新增：

```text
apps/sidecar/src/services/agent-runtime/tools/tool-registry.ts
apps/sidecar/src/services/agent-runtime/tools/tool-resolver.ts
apps/sidecar/src/services/agent-runtime/tools/tool-execution-gateway.ts
```

任务：

- Tool Registry。
- Tool Resolver。
- 可见性和审批分离。
- 并发调度。
- payload policy。
- MCP fail-closed。
- ToolRuntimePort 与 Kernel 解耦。

---

### Phase 6：Service Runtime / Trace / Replay / Resume

任务：

- Post-run jobs 进入 Service Runtime。
- Trace panel。
- RuntimeEvent replay。
- checkpoint。
- interrupted run recovery。
- worker isolation 评估。

---

## 15. 验收标准

### 架构验收

- 有明确系统地图。
- 每个模块能回答“属于哪一层”。
- 每个状态能回答“谁拥有真相”。
- RPC handlers 不承载核心业务。
- UI 不依赖 SDKMessage。
- Sidecar 有 ready/health/crash 状态。
- RuntimeEvent 成为 UI 和 trace 的共同协议。
- Tool Runtime 和 Service Runtime 没有互相伪装。

### 体验验收

- 应用启动后 sidecar 后台预热。
- 首次发送消息不再承担完整冷启动。
- assistant delta 到达即渲染。
- 工具调用状态实时可见但默认低噪音。
- 取消、权限等待、用户输入等待、失败、继续执行都有明确状态。

### 可靠性验收

- active run 可持久化。
- sidecar 崩溃后能标记 interrupted。
- 大 payload 不导致 IPC 卡顿。
- Trace 能定位 prompt、工具、LLM、memory、compaction 的耗时。

### 可维护性验收

- `agent-service.ts` 明显变薄。
- `buildRuntimeCoreTools` 不再是工具治理中心。
- Context Assembly、Tool Resolution、Message Shaping、PostRunPipeline 可单测。
- 配置优先级清晰。

---

## 16. 不做事项

本轮不做：

- 不迁移 Electron。
- 不重写底层 SDK Agent Loop。
- 不立即引入 worker_threads。
- 不做服务端化。
- 不引入重型 workflow DAG。
- 不做完整事件溯源数据库。
- 不把后台服务暴露成 AI 工具。

---

## 17. 总结

Lume 当前路线是可行的，但要从：

```text
Tauri + sidecar 消息桥
```

升级为：

```text
Tauri Host + Sidecar Runtime Host + Agent Runtime Kernel + RuntimeEvent-driven UI
```

核心改造顺序：

```text
最终态边界
  -> Host lifecycle
  -> Kernel protocol
  -> RuntimeEvent
  -> Agent Loop Kernel
  -> Tool Runtime
  -> Service Runtime / Trace / Resume
```

这条路线可以保留 Tauri 的轻量优势，同时吸收 Electron/Alice 架构里对 Agent 系统最关键的分层、事件流、工具治理和可观测设计。

# Lume Tool Runtime 边界设计文档

> 目标：把工具系统定义为 Agent Runtime Kernel 的 AI 可见能力边界。最终态不是“把所有能力都塞进工具列表”，而是区分 Tool Runtime、Service Runtime 和 Adapter：模型能主动选择的能力必须进入 Tool Runtime 治理；后台自动能力属于 Service Runtime；MCP、skills、provider、filesystem 等具体接入属于 Adapter。

---

## 1. 背景与问题

Agent 系统里，工具不是简单函数列表，而是模型可见能力的边界。工具设计决定了 Agent 能做什么、什么时候做、能不能自动做、需要不要用户批准、结果如何进入上下文、如何展示给 UI。

Lume 当前已经有不错基础：

- `createRuntimeCoreSession` 会构造 base tools、TaskContractWrite、TaskReport、Lume custom tools、Subagent AgentTool、MCP servers、skills directories。
- `createLumeRuntimeTools` 会根据 workspace 和 memory policy 创建 memory tools、cron tools，并返回 custom tools 和可用工具名。
- `applyPiToolPolicies` 已支持全局、provider、session type、chat type、subagent、message metadata 多层过滤。
- `tool-metadata.ts` 已有工具元数据注册表，包含 category、riskLevel、allowedInPlanMode。
- `createCanUseToolHandler` 已有 permissionMode、plan mode、guardrail、AskUserQuestion、ToolPermissionRequest、automation interruption 等审批逻辑。
- 工具有 `isConcurrencySafe` 这类并发安全信息的基础。

当前主要问题：

1. **工具来源分散**  
   内置工具、Lume custom tools、MCP、skills、subagent、task tools 都在不同位置组装，没有统一 Tool Registry。

2. **工具可见性与工具权限混在一起**  
   可见性决定“模型能不能看到工具”，权限决定“模型调用后能不能执行”。这两者需要分开治理。

3. **工具元数据还不完整**  
   已有 category/riskLevel/allowedInPlanMode，但缺少 source、capability、sideEffects、concurrency、payloadPolicy、approvalPolicy 等产品级元信息。

4. **Plan Mode 工具策略需要更细**  
   现在 plan 模式主要靠 allowedInPlanMode 和只读工具集合。后续需要按 task phase、active skill、subagent role、automation mode 进一步过滤。

5. **工具结果缺少统一 payload 规范**  
   大文件内容、搜索结果、MCP 返回值、命令输出不应都 inline 进入 IPC 和下一轮上下文。

6. **工具执行事件需要标准化**  
   UI、trace、run state、权限面板都应该消费同一套 tool.started/tool.completed/tool.failed 事件。

7. **工具与服务边界需要固化**  
   AI 可主动触发的是工具；后台自动执行、用户不需要模型决定的是服务。记忆抽取、标题生成、Skill 改进、trace、workspace watcher 等不应暴露为工具。

---

## 2. 设计目标

### 2.1 产品目标

- 工具列表更少、更准，降低模型误用工具概率。
- 用户知道 Agent 为什么要用某个工具、风险是什么。
- 只读工具默认可低打扰执行，高风险工具明确审批。
- 工具状态展示轻量、可折叠、可追踪。
- Plan 模式真正只做规划和只读分析，不偷偷执行写入/命令。

### 2.2 工程目标

- 所有工具进入统一 Registry。
- 工具可见性、权限审批、guardrail、执行、结果治理分层。
- 支持 source/capability/risk/concurrency/payload policy。
- 支持 MCP/skills/plugin 工具的动态注册和元数据补齐。
- 大 payload 不直接走 IPC，不直接污染上下文。
- 工具执行事件统一进入 RuntimeEvent。
- 工具策略可测试、可配置、可追踪。

---

## 3. Tool Runtime 总体边界

```text
Agent Runtime Kernel
  └── ToolRuntimePort
        ├── resolveVisibleTools(input)
        ├── authorizeToolCall(call)
        ├── executeToolCall(call)
        └── normalizeToolResult(result)

Tool Runtime
  ├── Tool Sources
  │   ├── SDK base tools
  │   ├── Lume built-in tools
  │   ├── Memory tools
  │   ├── Automation tools
  │   ├── Plan/Task tools
  │   ├── Subagent tools
  │   ├── MCP tools
  │   ├── Skill tools
  │   └── Plugin tools
  │
  ├── Tool Registry
  │   ├── definition
  │   ├── metadata
  │   ├── capability tags
  │   ├── risk level
  │   ├── visibility policy
  │   ├── approval policy
  │   ├── concurrency policy
  │   └── payload policy
  │
  ├── Tool Resolver
  │   ├── collect sources
  │   ├── normalize names
  │   ├── enrich metadata
  │   ├── apply visibility policies
  │   ├── apply capability route
  │   └── return visible tools
  │
  ├── Tool Execution Gateway
  │   ├── input guardrails
  │   ├── approval policy
  │   ├── concurrency scheduler
  │   ├── execute through adapter
  │   ├── result normalization
  │   ├── payload storage/ref
  │   └── emit tool lifecycle events
  │
  └── Payload Governance
      ├── UI preview
      ├── context-safe summary
      ├── trace redaction
      └── file_ref/raw storage

Service Runtime
  └── not model-visible: title, memory extraction, watcher, trace recorder

Adapter Layer
  └── MCP / skills / fs / shell / browser / web / subagent transport
```

### 3.1 Tool Runtime 拥有的真相

| 事项 | 真相来源 |
|---|---|
| 本轮模型能看到哪些工具 | Tool Resolver |
| 工具风险等级和 side effects | Tool Registry metadata |
| 是否需要审批 | Approval Policy |
| 工具是否可并发 | Concurrency Policy |
| 工具结果如何进入 UI/trace/context | Payload Policy |
| MCP/skill/plugin 未声明元数据时如何降级 | Metadata Resolver fail-closed 默认 |

Tool Runtime 不拥有 run 状态。它通过 RuntimeEvent 和结构化结果把事实交还给 Agent Runtime Kernel。

---

## 4. 工具与服务边界

判断标准：

> 如果 AI 主动触发这个功能，是用户期望的行为吗？

如果是，做成工具。  
如果不是，做成服务。

补充规则：

- 如果能力需要模型在多种候选动作中主动选择，做成工具。
- 如果能力是系统为了维护质量、索引、记忆、标题或可观测性自动执行，做成服务。
- 如果能力只是接入外部协议或具体实现，做成 adapter。
- Service 可以调用 Adapter，但不能伪装成 Tool 进入模型可见列表。
- Tool 可以通过 Adapter 执行，但必须先经过 Tool Runtime 的 visibility / approval / payload 治理。

### 4.1 应该是工具

| 能力 | 理由 |
|---|---|
| Read / Glob / Grep / ls | 用户期望 Agent 主动读取和搜索上下文 |
| Write / Edit / NotebookEdit | 用户明确授权时可修改文件 |
| Bash | 高风险，但代码任务中需要 |
| WebSearch / WebFetch | 用户期望 Agent 可搜索信息 |
| AskUserQuestion | Agent 需要澄清问题 |
| TaskContractWrite | Plan 模式下写入待审批计划 |
| TaskReport | 执行任务后报告结果 |
| MCP tools | 外部能力，AI 可主动选择 |
| Skill tool | AI 可调用技能 |
| Task/Subagent | AI 可委派任务 |

### 4.2 应该是服务

| 能力 | 理由 |
|---|---|
| 自动标题生成 | 用户不需要模型决定是否生成标题 |
| 后台记忆提取 | 不应增加模型工具选择负担 |
| 用户画像更新 | 后台行为 |
| Skill 改进分析 | 后台质量优化 |
| Workspace watcher | 系统服务 |
| Trace 记录 | 可观测服务 |
| 自动压缩上下文 | Runtime 服务 |
| 自动备份 | 系统服务 |
| sidecar health monitor | 系统服务 |

### 4.3 应该是 Adapter

| 能力 | 理由 |
|---|---|
| Model provider SDK | 只是模型协议接入，不拥有 run 语义 |
| MCP stdio/http/sse transport | 外部工具协议接入，工具语义仍需 Tool Runtime 补齐 |
| Skill manifest loader | 提供 skill 元数据，不直接决定工具可见性 |
| Filesystem adapter | 提供读写能力，是否暴露为工具由 Tool Runtime 决定 |
| Shell adapter | 提供进程执行能力，审批和风险由 Tool Runtime 决定 |
| Browser/web adapter | 提供浏览器或网络能力，是否可见和结果治理由 Tool Runtime 决定 |
| Subagent transport | 提供委派执行通道，权限继承和事件归属由 Tool Runtime/Kernel 决定 |

---

## 5. Tool Registry 设计

### 5.1 新增目录

```text
apps/sidecar/src/services/agent-runtime/tools/
  tool-registry.ts
  tool-types.ts
  tool-source.ts
  tool-resolver.ts
  tool-execution-gateway.ts
  tool-result-normalizer.ts
  tool-payload-store.ts
  tool-event-projector.ts
  policies/
    tool-visibility-policy.ts
    tool-approval-policy.ts
    tool-concurrency-policy.ts
    tool-payload-policy.ts
```

### 5.2 ToolDescriptor

```ts
export interface LumeToolDescriptor {
  name: string;
  canonicalName: string;
  source:
    | "sdk"
    | "lume"
    | "memory"
    | "automation"
    | "plan"
    | "task"
    | "mcp"
    | "skill"
    | "plugin";

  definition: ToolDefinition;

  metadata: {
    title?: string;
    description?: string;
    category: "read" | "write" | "execute" | "control" | "network";
    capability:
      | "filesystem"
      | "shell"
      | "web"
      | "memory"
      | "automation"
      | "planning"
      | "subagent"
      | "mcp"
      | "skill";
    riskLevel: "low" | "medium" | "high";
    sideEffects: "none" | "local_read" | "local_write" | "network" | "process" | "external";
    allowedInPlanMode: boolean;
    isReadOnly: boolean;
    isConcurrencySafe: boolean;
    requiresWorkspace?: boolean;
    requiresNetwork?: boolean;
    requiresApprovalByDefault?: boolean;
  };

  policies?: {
    visibility?: ToolVisibilityPolicy;
    approval?: ToolApprovalPolicy;
    concurrency?: ToolConcurrencyPolicy;
    payload?: ToolPayloadPolicy;
  };
}
```

### 5.3 Registry 接口

```ts
export class ToolRegistry {
  register(tool: LumeToolDescriptor): void;
  registerMany(tools: LumeToolDescriptor[]): void;
  list(): LumeToolDescriptor[];
  get(name: string): LumeToolDescriptor | undefined;
  resolve(input: ToolResolveInput): LumeToolDescriptor[];
}
```

---

## 6. Tool Resolver 设计

### 6.1 输入

```ts
export interface ToolResolveInput {
  threadId: string;
  runId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  provider?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  activeSkillIds?: string[];
  subagentRole?: string;
  messageMetadata?: Record<string, unknown>;
  taskPhase?: "idle" | "planning" | "awaiting_approval" | "executing";
  capabilityRoute?: string;
}
```

### 6.2 处理流程

```text
collect tool sources
  -> normalize tool names
  -> enrich metadata
  -> remove duplicates
  -> apply source availability
  -> apply plan mode policy
  -> apply skill whitelist
  -> apply subagent policy
  -> apply user disabled policy
  -> apply runtime tool policy
  -> apply metadata toolPolicy
  -> return visible tools
```

### 6.3 可见性与审批分离

可见性：

```text
模型能不能看到这个工具
```

审批：

```text
模型调用这个工具后，是否需要用户允许
```

两者不能混淆。

示例：

```text
Bash:
  visible in execution mode
  hidden in plan mode
  requires approval unless bypassPermissions

Read:
  visible in plan and execution
  usually no approval

Write:
  hidden in plan mode
  visible in execution mode
  approval depends on permissionMode

memory.search:
  visible when workspaceSlug exists
  usually no approval

memory.remember:
  visible only when memory tool policy allows
  may require approval or be service-driven instead
```

---

## 7. 权限与审批策略

### 7.1 当前可复用能力

Lume 当前已有：

- `tool-metadata.ts` 注册 category/riskLevel/allowedInPlanMode。
- `applyPiToolPolicies` 支持多层 allow/deny。
- `createCanUseToolHandler` 里有 plan mode 限制、guardrail、approval、AskUserQuestion、automation pause。
- `evaluateToolApprovalPolicy` 负责判断是否 requires approval。
- `builtinToolInputGuardrails` 负责输入风险拦截。

这些保留，但需要统一挂到 Tool Execution Gateway。

### 7.2 Approval Policy

```ts
export interface ToolApprovalPolicy {
  mode: "never" | "on_risk" | "always" | "inherit";
  riskThreshold?: "medium" | "high";
  allowAlwaysOption?: boolean;
  automationBehavior?: "pause" | "deny" | "allow";
}
```

### 7.3 决策顺序

```text
1. visibility filter
2. input guardrail
3. plan mode hard deny
4. user/session allow always
5. permissionMode
6. risk level
7. automation behavior
8. user approval
9. execute
```

---

## 8. 并发安全策略

原文工具设计里强调按并发安全性分批执行。Lume 现在部分工具已有 `isConcurrencySafe`，但需要产品化。

### 8.1 分类

```ts
export type ToolConcurrencyGroup =
  | "read"
  | "write"
  | "shell"
  | "network"
  | "memory"
  | "automation"
  | "exclusive";
```

### 8.2 规则

| 工具类型 | 并发策略 |
|---|---|
| Read / Glob / Grep / ls | 可并发 |
| WebSearch / WebFetch | 可并发，但限流 |
| memory.search/read | 可并发 |
| Write / Edit | 同文件串行，不同文件可选并行 |
| Bash | 默认串行 |
| automation_set | 串行 |
| Task/Subagent | 可并发，但限制最大数量 |
| MCP tools | 默认串行，除非声明 safe |

### 8.3 Scheduler

```ts
export class ToolExecutionScheduler {
  executeBatch(calls: ToolCall[]): Promise<ToolCallResult[]>;
}
```

先做轻量版本：

```text
read-only 并发
write/execute 串行
subagent 限制最多 N 个
```

---

## 9. 工具结果治理

### 9.1 问题

工具结果可能非常大：

- 读取大文件。
- grep 大量结果。
- WebFetch 返回长网页。
- Bash 输出大量日志。
- MCP 返回大 JSON。
- 子 Agent 输出长报告。

这些不应该全部：

```text
进入下一轮 LLM context
进入 stdout IPC
进入 UI state
进入 trace 完整 payload
```

### 9.2 Payload Policy

```ts
export interface ToolPayloadPolicy {
  inlineLimitBytes: number;
  previewLimitBytes: number;
  contextLimitBytes: number;
  storeFullResult: boolean;
}
```

默认：

```text
inlineLimitBytes: 64KB
previewLimitBytes: 8KB
contextLimitBytes: 16KB
storeFullResult: true
```

### 9.3 ToolResultPayload

```ts
export type ToolResultPayload =
  | {
      kind: "inline";
      content: string;
    }
  | {
      kind: "file_ref";
      path: string;
      preview: string;
      size: number;
      mimeType?: string;
    };
```

### 9.4 上下文写回策略

```text
UI:
  preview + 可展开完整内容

Trace:
  preview + ref

LLM context:
  context-safe summary 或 preview

Disk:
  full raw result
```

---

## 10. 工具事件协议

工具执行要统一发 RuntimeEvent。

```ts
export type ToolRuntimeEvent =
  | ToolStartedEvent
  | ToolApprovalRequestedEvent
  | ToolInputRejectedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolResultStoredEvent;

export interface ToolStartedEvent {
  type: "tool.started";
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  source: string;
  riskLevel: "low" | "medium" | "high";
  inputPreview?: unknown;
}

export interface ToolCompletedEvent {
  type: "tool.completed";
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  durationMs: number;
  resultPreview?: string;
  resultRef?: {
    kind: "file";
    path: string;
    size: number;
  };
}

export interface ToolFailedEvent {
  type: "tool.failed";
  threadId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  error: {
    code: string;
    message: string;
  };
}
```

---

## 11. Plan Mode 工具策略

### 11.1 目标

Plan 模式只允许：

- 读文件。
- 搜索 workspace。
- Web search/fetch。
- 读取 memory。
- AskUserQuestion。
- TaskContractWrite。
- TodoWrite。
- 其他明确声明为 plan-safe 的工具。

禁止：

- Write/Edit。
- Bash。
- automation_set。
- memory.promoteGlobal / rejectGlobalCandidate。
- 任何有不可逆副作用的 MCP tool。
- 未声明 plan-safe 的 plugin tool。

### 11.2 MCP 工具处理

MCP tool 默认：

```text
allowedInPlanMode: false
riskLevel: medium
isConcurrencySafe: false
sideEffects: external
requiresApprovalByDefault: true
```

除非用户或 MCP manifest 显式声明：

```json
{
  "lume": {
    "category": "read",
    "riskLevel": "low",
    "allowedInPlanMode": true,
    "isConcurrencySafe": true
  }
}
```

---

## 12. Subagent 工具策略

### 12.1 目标

子 Agent 默认降权，避免父 Agent 把危险能力绕过权限交给子 Agent。

### 12.2 策略

```text
subagent 默认只继承最小工具集
父 Agent 的 permissionMode 不自动提升子 Agent
子 Agent 不允许 bypassPermissions
子 Agent 使用工具仍然走 approval / guardrail
子 Agent 工具事件要带 subagentRunId 和 parentToolCallId
```

### 12.3 可见性

```text
subagent:
  allow: read/search/memory.search/web_search/web_fetch/AskUserQuestion
  deny: bash/write/edit/automation_set unless explicitly allowed
```

---

## 13. Memory 工具策略

### 13.1 当前问题

Lume 既有 memory tools，也有后台 memory flush/extraction。需要边界清楚。

### 13.2 建议

工具：

```text
memory.search
memory.read
```

默认可见。

谨慎工具：

```text
memory.remember
memory.writeEpisode
memory.flush
```

需要策略控制。

服务：

```text
post-run memory extraction
profile update
memory distillation
workspace indexing
global memory candidate promotion workflow
```

默认不让 AI 自己决定。

---

## 14. Automation 工具策略

### 14.1 工具分类

```text
automation_read: read, low, plan-safe
automation_query: read, low, plan-safe
automation_set: write/control, high, not plan-safe
```

### 14.2 自动化执行中的工具审批

当前已有 automation execution 会持久化 interruption，并暂停等待用户确认。这个方向保留。

建议标准化事件：

```ts
{
  type: "tool.approval_requested",
  interruptionType: "automation_approval",
  automationJobId,
  automationTrigger
}
```

---

## 15. MCP 工具策略

### 15.1 MCP 默认 fail-closed

对于未知 MCP 工具：

```text
category: control
riskLevel: medium
allowedInPlanMode: false
isConcurrencySafe: false
requiresApprovalByDefault: true
payloadPolicy: conservative
```

### 15.2 MCP 元数据补齐

新增：

```text
apps/sidecar/src/services/agent-runtime/tools/mcp-tool-metadata-resolver.ts
```

来源优先级：

```text
MCP manifest lume metadata
  > workspace config override
  > user tool policy
  > name inference
  > fail-closed default
```

---

## 16. Skill 工具策略

### 16.1 Skill 白名单

Skill 可以声明：

```yaml
tools:
  allow:
    - Read
    - Grep
    - WebSearch
  deny:
    - Bash
```

Tool Resolver 在 active skill 存在时应用 skill whitelist。

### 16.2 Skill 改进分析

不做工具，做服务：

```text
post-run skill improvement analysis
```

原因：

- 用户不关心模型是否主动调用“改进技能”。
- 避免主循环工具选择负担。
- 避免模型为了改进 skill 打断当前任务。

---

## 17. 文件级实施计划

### Phase 1：类型和 Registry

新增：

```text
apps/sidecar/src/services/agent-runtime/tools/tool-types.ts
apps/sidecar/src/services/agent-runtime/tools/tool-registry.ts
apps/sidecar/src/services/agent-runtime/tools/tool-source.ts
```

迁移/保留：

```text
apps/sidecar/src/services/agent-runtime/tools/permissions/tool-metadata.ts
```

目标：

- 现有 `ToolMetadata` 扩展为 `LumeToolDescriptor.metadata`。
- 建立统一注册入口。

### Phase 2：Tool Resolver

新增：

```text
apps/sidecar/src/services/agent-runtime/tools/tool-resolver.ts
apps/sidecar/src/services/agent-runtime/tools/policies/tool-visibility-policy.ts
```

修改：

```text
apps/sidecar/src/services/agent-runtime/runtime-core/run.ts
apps/sidecar/src/services/agent-runtime/tools/create-lume-tools.ts
apps/sidecar/src/services/agent-runtime/tools/permissions/tool-policy.ts
```

目标：

- `buildRuntimeCoreTools` 从“手工拼数组”改为调用 ToolResolver。
- 保留现有 applyPiToolPolicies，但纳入 visibility pipeline。

### Phase 3：Execution Gateway

新增：

```text
apps/sidecar/src/services/agent-runtime/tools/tool-execution-gateway.ts
apps/sidecar/src/services/agent-runtime/tools/policies/tool-approval-policy.ts
```

修改：

```text
apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts
```

目标：

- `createCanUseToolHandler` 瘦身。
- Guardrail、approval、automation interruption、AskUserQuestion 统一在 gateway 中处理。

### Phase 4：Payload 治理

新增：

```text
apps/sidecar/src/services/agent-runtime/tools/tool-result-normalizer.ts
apps/sidecar/src/services/agent-runtime/tools/tool-payload-store.ts
apps/sidecar/src/services/agent-runtime/tools/policies/tool-payload-policy.ts
```

修改：

```text
apps/sidecar/src/services/agent-runtime/runner/run-observer.ts
apps/sidecar/src/services/agent-runtime/trace/trace-redaction.ts
```

目标：

- 大 payload file_ref 化。
- trace 和 UI 只拿 preview。
- LLM context 只拿 context-safe 内容。

### Phase 5：并发调度

新增：

```text
apps/sidecar/src/services/agent-runtime/tools/tool-execution-scheduler.ts
apps/sidecar/src/services/agent-runtime/tools/policies/tool-concurrency-policy.ts
```

目标：

- read-only 并发。
- write/execute 串行。
- subagent 限流。
- MCP 默认串行。

### Phase 6：工具事件

新增：

```text
apps/sidecar/src/services/agent-runtime/tools/tool-event-projector.ts
```

修改：

```text
packages/shared/src/types/runtime-event.ts
apps/sidecar/src/services/agent-runtime/runner/run-observer.ts
```

目标：

- tool.started / completed / failed / approval_requested 标准化。
- UI 工具状态只依赖 RuntimeEvent。

---

## 18. 测试计划

### 18.1 单元测试

```text
tool-registry.test.ts
tool-resolver.test.ts
tool-visibility-policy.test.ts
tool-approval-policy.test.ts
tool-payload-policy.test.ts
tool-result-normalizer.test.ts
tool-execution-scheduler.test.ts
mcp-tool-metadata-resolver.test.ts
```

### 18.2 集成测试

场景：

1. plan mode 下看不到 Write/Edit/Bash。
2. execution mode 下可见 Write/Edit/Bash，但按权限策略审批。
3. subagent 默认看不到高风险工具。
4. metadata.toolPolicy 可以临时限制工具。
5. workspace lume.yaml toolPolicy 生效。
6. MCP 未声明元数据时默认 medium risk + requires approval。
7. 大工具结果转 file_ref。
8. Bash 输出超长不进入 IPC 完整内容。
9. automation_set 在 plan mode 不可见。
10. automation execution 触发 approval interruption。
11. memory.search 在 workspace 存在时可见。
12. memory.remember 受 memory policy 控制。

---

## 19. 验收标准

- `buildRuntimeCoreTools` 不再是主要工具治理中心，而是调用 ToolResolver。
- 所有工具都有 metadata，未知工具也会被 fail-closed 推断。
- 工具可见性和审批逻辑分离。
- Plan 模式工具列表可预测、可测试。
- Subagent 默认降权。
- MCP 工具默认保守。
- 大 payload 不直接进入 IPC / UI / trace / 下一轮 context。
- 工具事件统一进入 RuntimeEvent。
- 工具 UI 可以根据 tool.started/tool.completed/tool.failed 渲染。
- 审批面板能显示 toolName、riskLevel、reason、inputPreview。
- 工具策略可以从 global config、workspace config、provider、threadType、chatType、metadata 多层生效。

---

## 20. 不做事项

本轮不做：

- 不改写所有 SDK 内置工具实现。
- 不强制 MCP server 都支持 Lume metadata。
- 不把后台记忆提取、标题生成、Skill 改进做成 AI 工具。
- 不立即实现复杂 DAG 调度。
- 不做跨进程共享内存 payload。
- 不默认放开 subagent 的写入和命令能力。

---

## 21. 总结

Lume 当前工具系统已经具备基础能力，但需要从“动态拼工具数组 + 权限函数”升级为“工具治理系统”。

推荐路线：

```text
现有工具集合
  -> Tool Registry
  -> Tool Resolver
  -> Visibility Policy
  -> Execution Gateway
  -> Payload Governance
  -> RuntimeEvent Tool Events
```

这套设计会让 Lume 的工具系统更安全、更可观察、更可扩展，也能显著降低 Agent 主循环里的复杂度。

# Agent Event Contract Unification Design

## 背景

当前 Lume 的 Agent 事件链路已经基本切到 `pi-coding-agent createAgentSession` 主骨架，但“事件契约”和“交互状态契约”仍然分散在多层：

1. sidecar `runtime-core` 订阅上游 `AgentSessionEvent`
2. sidecar 再把它映射成 Lume `AgentEvent`
3. web 侧 `agent-atoms.ts` 仍然承担一部分事件语义修补、去重和终态兜底

这会导致两个问题：

1. 事件语义责任不清，sidecar 和前端都在补同一类问题。
2. 一旦上游事件变化，回归面会扩散到 web，而不是被限制在 sidecar 适配层。

本设计的目标是把 Agent 链路明确收敛成“两层共享契约”：

1. 一层共享事件契约
2. 一层最小共享运行时状态契约

并确保语义归一在 sidecar 单点完成。

## 目标

1. `pi-coding-agent` 事件只作为 sidecar 内部输入，不直接成为 Lume 前后端共享契约。
2. `packages/shared` 中的 `AgentEvent` 成为唯一跨层事件合同。
3. 在 `AgentEvent` 之外，补一层最小的共享运行时状态契约。
4. sidecar 负责完成事件规范化、去重、终态修补和 provider 差异吸收。
5. 前端只消费稳定的共享事件和共享状态，不再承担上游兼容和事件语义修补职责。

## 非目标

1. 不让 web 直接依赖 `@mariozechner/pi-coding-agent` 类型。
2. 不在这个阶段重写 `AgentMessage` 的整个持久化模型。
3. 不在没有真实问题时提前扩展大量 provider-specific 分支。

## 契约边界

### 1. 上游内部事件

`@mariozechner/pi-coding-agent` 的 `AgentSessionEvent` 只允许出现在 sidecar 内部，主要限于：

1. `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts`
2. `apps/sidecar/src/services/pi-agent/runtime-core/subscribe.ts`
3. `apps/sidecar/src/services/pi-agent/subscribe/map-pi-session-event.ts`

这层是“实现依赖”，不是“产品契约”。

### 2. Lume 跨层事件契约

`packages/shared/src/types/agent.ts` 里的 `AgentEvent` 继续作为唯一共享合同，sidecar/web 都只依赖这一层。

这意味着：

1. `desktop-api.ts` 只做 IPC 搬运，不做语义转换。
2. `agent-atoms.ts` 只做状态归并和渲染组织，不负责修复 runtime 事件不稳定。
3. 所有“事件是否重复、文本是否最终完成、tool result 是否覆盖旧值”这类规则，都应由 sidecar 保证。

### 3. Lume 跨层运行时状态契约

在 `AgentEvent` 之外，补充一个最小的共享运行时状态模型，暂命名为 `AgentRuntimeStatus`。

这层只承载“前端必须稳定感知、且不能靠本地猜测”的状态，例如：

1. `idle`
2. `streaming`
3. `awaiting_permission`
4. `awaiting_user_answer`
5. `compacting`
6. `completed`
7. `errored`

必要时附加最小上下文，例如：

1. 当前等待的 `requestId` / `toolUseId`
2. 当前会话是否存在未处理的 permission/question
3. 最近一次错误摘要

这层不是 UI state，不承载展开/折叠/hover/排序等前端本地状态。

## 模块职责

### sidecar

`runtime-core` 内部职责明确分三层：

1. `subscribe.ts`
   负责按事件类别分发：`lifecycle / message / tool`
2. `map-pi-session-event.ts`
   负责把可映射的上游事件转成基础 `AgentEvent`
3. `stream-wrappers.ts`
   负责流式语义归一：空文本过滤、重复完成态去重、provider quirks 吸收

同时由 sidecar 在会话边界维护共享运行时状态，并通过 IPC 提供给 web。

sidecar 是唯一允许知道“上游事件长什么样”和“前端真正需要什么语义”的地方。

### shared

`packages/shared/src/types/agent.ts` 负责：

1. 定义稳定的 `AgentEvent`
2. 定义稳定的 `AgentRuntimeStatus`
3. 定义 `AgentMessage`、`AgentAskUserQuestionRequest`、`AgentToolPermissionRequest` 等跨层合同

shared 不依赖 provider 或 runtime 实现细节。

### web

`apps/web/lib/desktop-api.ts` 负责：

1. sidecar IPC 监听与请求转发
2. 不改变事件语义
3. 提供共享运行时状态的读取/订阅入口

`apps/web/atoms/agent-atoms.ts` 负责：

1. 流式状态合并
2. timeline 渲染态组织
3. 基于共享运行时状态驱动交互显隐
4. 不再吸收 sidecar 输出不稳定的问题

## 推荐演进顺序

### 阶段 A：冻结共享事件与状态合同（已启动）

梳理 `AgentEvent` 与 `AgentRuntimeStatus` 当前实际字段和语义，明确哪些是稳定边界，哪些是 sidecar 保证项。

优先确认：

1. `text_delta` / `text_complete`
2. `tool_start` / `tool_result`
3. `usage_update`
4. `compacting` / `compact_complete`
5. `message_appended`
6. `ask-user-question`
7. `tool-permission-request`
8. `awaiting_permission / awaiting_user_answer / streaming / completed / errored`

### 阶段 B：sidecar 事件归一化单点化（进行中）

逐步把前端中承担的修补逻辑下沉到 sidecar：

1. 空文本与重复 `text_complete`
2. tool start/result 重复覆盖规则
3. intermediate/final 文本终态一致性
4. provider-specific stream quirks
5. 共享运行时状态的单点维护

这一阶段完成后，前端应该只是在消费一个已经稳定的 `AgentEvent` 流。

### 阶段 C：前端清理（进行中）

回头收敛 `agent-atoms.ts` 中的补救逻辑，把它降级成纯状态归并层。

重点清理：

1. 因 sidecar 输出不稳导致的文本去重
2. tool result/tool start 的重复修补
3. 对中间态/终态的特殊判断

## 设计决策

### 决策 1：不直接共享上游事件

原因：

1. 上游 SDK 升级频率和产品契约稳定性不是一个维度。
2. Lume 还有自己的产品语义，例如 compaction、subagent announce、permission bridge。
3. 直接把 web 绑到上游事件，会让升级影响面失控。

### 决策 2：只保留薄 wrapper，不发明第二套 runtime

sidecar 不应该重写 `pi-ai/pi-coding-agent`，但必须保留一层薄的 stream wrapper。

这层 wrapper 只处理三类问题：

1. 空事件/重复事件
2. 终态不稳定
3. 已验证存在的 provider 差异

没有真实问题的 provider，不提前加特殊分支。

### 决策 3：前端不再作为事件兼容层

前端可以继续做状态归并，但不能继续成为 sidecar 输出缺陷的兜底层，也不应继续自己推断关键交互状态。

否则后续所有事件回归都会变成“sidecar 和 web 各修一半”，很难维护。

## 风险

1. 现有前端逻辑已经默默吸收了一些 sidecar 缺陷，收回职责时可能暴露旧问题。
2. 如果 `AgentEvent` 合同本身定义得不够明确，下沉后仍会出现重复修补。
3. provider-specific 差异如果没有测试覆盖，wrapper 规则可能过度或不足。

## 验证策略

1. sidecar 单元测试
   覆盖 `subscribe.ts`、`map-pi-session-event.ts`、`stream-wrappers.ts`
2. sidecar smoke
   覆盖 `agent-new-runtime`、`compact`、`bridges`
3. 前端状态测试
   覆盖 `agent-atoms.ts` 对统一契约的消费
4. 回归准则
   相同输入事件序列应得到相同的 timeline/message 输出，相同运行时阶段应得到相同的共享状态快照

## 当前建议

当前已完成：

1. `AgentEvent + AgentRuntimeStatus` 的共享契约已经落到 `packages/shared`
2. sidecar 已维护并下发最小 runtime status
3. `bridges smoke` 已覆盖 `permission / ask-user / subagent announce / runtime status`
4. web 已开始以共享状态和共享请求载荷驱动关键控制面

下一步建议：

1. 继续缩减 web 中剩余的本地运行态推断
2. 扩大 provider-specific stream wrapper 和 provider smoke

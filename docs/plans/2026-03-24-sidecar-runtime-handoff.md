# Sidecar Runtime Refactor Handoff

最后更新：2026-03-24

## 1. 背景

本轮工作围绕两条主线推进：

1. `apps/sidecar` 的 Pi/OpenClaw runtime 对齐收尾。
2. `apps/sidecar/src/index.ts` 和 sidecar 代码结构拆分，降低入口文件和职责混杂问题。

当前状态是：runtime 对齐这条线已经推进到“可运行、可验证、但尚未提交”；入口结构拆分已继续推进，`index.ts` 不再承载具体 RPC 业务逻辑；Agent 会话消息也已收口为 transcript-only，不再保留 `compatibility.ndjson` 兼容层。

## 2. 最近一个已提交检查点

- 分支：`feat/openclaw-runtime-realignment`
- 最近已提交 commit：`2560b2d`
- commit message：`feat(sidecar): ✨ 切换 runtime-core 主链并退出 agent session JSONL 消息存储`

如果下一个会话想先从“已提交且稳定”的状态开始，可以以这个 commit 为基线理解上下文。

## 3. 这之后已完成但尚未提交的工作

以下改动已经落在工作树里，其中 runtime 对齐部分已经验证通过。

### 3.1 usage 语义修正

目标：不再把 `totalTokens` 错塞进 `inputTokens`。

已做：

- 在 [agent.ts](/E:/projects/ai-projects/lume/packages/shared/src/types/agent.ts) 的 `AgentEventUsage` 中补了 `totalTokens`。
- 新增 [usage.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/usage.ts) 和 [usage.test.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/usage.test.ts)，统一计算上下文总 token。
- 修正 [map-pi-session-event.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/subscribe/map-pi-session-event.ts) 的 usage 映射。
- 修正 [agent-service.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/agent-service.ts)、[session-state-manager.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/session-state-manager.ts)、[agent-stream-converter.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/agent-stream-converter.ts) 的消费逻辑。
- Web 侧同步改到了 `totalTokens`，涉及 [agent-atoms.ts](/E:/projects/ai-projects/lume/apps/web/atoms/agent-atoms.ts)、[AgentView.tsx](/E:/projects/ai-projects/lume/apps/web/components/agent/AgentView.tsx)、[ContextUsageBadge.tsx](/E:/projects/ai-projects/lume/apps/web/components/agent/ContextUsageBadge.tsx)。

### 3.2 native compaction 对齐

目标：删除失效的 Lume 自研 compaction 适配层，改为 runtime-core/native compaction 路线。

已做：

- 删除旧目录：
  - [compaction-service.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/compaction/compaction-service.ts)
  - [compaction-store.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/compaction/compaction-store.ts)
  - [index.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/compaction/index.ts)
- [runtime-core/subscribe.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/subscribe.ts) 已将上游 `auto_compaction_start/auto_compaction_end` 投影回 `compacting/compact_complete`。
- 新增 [smoke-agent-new-runtime-compact.mjs](/E:/projects/ai-projects/lume/apps/sidecar/scripts/smoke-agent-new-runtime-compact.mjs)，覆盖 mock compaction 的流事件 + session file 中 `compaction` entry 持久化。
- [runtime-core/attempt.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts) 补了 mock compaction 分支，仅用于 smoke 覆盖。

### 3.3 Lume custom tools 真正挂到 runtime-core 主链

目标：不再只让 `runtime-core` 用上游内建工具，Lume 自定义 tools / policy / permission gate 也必须进入 `createAgentSession(...)`。

已做：

- 新增 [pi-tool-definition-adapter.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/pi-tool-definition-adapter.ts)，把旧 `AgentTool` 适配成上游 `ToolDefinition`。
- [pi-tools.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/pi-tools.ts) 现在会构造：
  - base tools
  - Lume custom tools
  - tool policy
  - permission gate
  - memory citations 相关配置
- [run.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/run.ts) 已通过 `customTools` 把它们挂到上游 session。
- [attempt.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts) 已把运行时上下文补齐到工具链构建输入。
- [run.test.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts) 已增加断言：`sessions_list` 等 Lume tool 会出现在 active tool names 中。

### 3.4 原计划文档同步

- [openclaw-alignment-full-refactor-plan.md](/E:/projects/ai-projects/lume/docs/plans/openclaw-alignment-full-refactor-plan.md) 已同步到更接近当前事实的状态：
  - usage 语义已对齐
  - native compaction lifecycle 已接入
  - `smoke:agent-new-runtime:compact` 已补
  - tool chain 已挂上 runtime-core 主链

## 4. 已验证通过的命令

以下命令在本轮开发过程中已经跑通过。

### 4.1 代码检查与测试

- `bun run typecheck`
- `bun run --filter @lume/sidecar typecheck`
- `bun test apps/sidecar/src/services/pi-agent/usage.test.ts apps/sidecar/src/services/pi-agent/subscribe/map-pi-session-event.test.ts apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts apps/sidecar/src/services/pi-agent/runtime-core/subscribe.test.ts`
- `bun test apps/sidecar/src/services/pi-agent/runtime-core/run.test.ts apps/sidecar/src/services/pi-agent/runtime-core/subscribe.test.ts apps/sidecar/src/services/pi-agent/tools/tool-policy.test.ts apps/sidecar/src/services/pi-agent/tools/tool-permission-gate.test.ts apps/sidecar/src/services/pi-agent/tools/create-openclaw-aligned-tools.test.ts apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-e2e-flow.test.ts`

### 4.2 运行级 smoke

注意：agent smoke 依赖 `apps/sidecar/dist/index.js`，所以在执行 smoke 前需要先确保 sidecar 已 build 过一次。

已通过：

- `bun run --filter @lume/sidecar build`
- `bun run --filter @lume/sidecar smoke:agent-new-runtime`
- `bun run --filter @lume/sidecar smoke:agent-new-runtime:error`
- `bun run --filter @lume/sidecar smoke:agent-new-runtime:stop`
- `bun run --filter @lume/sidecar smoke:agent-new-runtime:compact`

额外说明：

- 我尝试过把 `apps/sidecar/package.json` 的 smoke script 改成自动先 build 再跑，但在当前环境会触发 Bun shim 的 `EPERM`/`Failed to start process`，所以已回退，没有保留这种改法。

## 5. 当前结构重组状态

这部分记录当前已经落地的入口层重组结果，以及真正还未完成的后续项。

### 5.1 目标

目标是把 [index.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/index.ts) 从巨型入口文件拆成“入口装配 + RPC handler 模块”，并理清 sidecar 的职责边界。

### 5.2 已完成的结构拆分

已新增：

- [types.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/types.ts)
- [validation.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/validation.ts)
- [schemas.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/schemas.ts)
- [chat-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/chat-handlers.ts)
- [agent-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/agent-handlers.ts)
- [channel-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/channel-handlers.ts)
- [memory-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/memory-handlers.ts)
- [automation-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/automation-handlers.ts)
- [channel-gateway-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/channel-gateway-handlers.ts)
- [system-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/system-handlers.ts)
- [create-rpc-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/create-rpc-handlers.ts)
- [create-rpc-handlers.test.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/create-rpc-handlers.test.ts)

并且：

- [index.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/index.ts) 已改为通过 `createRpcHandlers({ writeNotification })` 统一装配 handler。
- `index.ts` 现在只保留：
  - JSON-RPC request/response 写出
  - `handleRpcLine`
  - sidecar `boot` / watcher / relay / ingress / runner 生命周期
- 与本轮拆分配套，`pi-model-discovery.ts` 已顺手切到当前 SDK 的 `new AuthStorage(...)` 构造方式，避免 sidecar `typecheck` 被旧接口卡住。
- Agent 消息存储已切到 transcript-only：
  - 删除了 `compatibility.ndjson` 路径与相关读写/merge 逻辑
  - `message_metadata_overlay` 不再写入或参与读取
  - `subagent announce` 改为直接写 transcript，并在消息投影时派生回 `subagentAnnounce/runId/childSessionId/status`

### 5.3 当前停下来的点

`index.ts` 的 handler 拆分不再是阻塞项，这部分已经完成。

当前实际状态：

- handler 维度的拆分已经覆盖 `channel/chat/agent/memory/automation/channel-gateway/system`。
- `index.ts` 目前的职责边界已经符合“入口装配层”的目标。
- 已补最小注册器测试：`rpc:list-methods` 和 `healthcheck`。
- `bun test apps/sidecar/src/rpc/create-rpc-handlers.test.ts` 与 `bun run --filter @lume/sidecar typecheck` 已通过。
- transcript-only 收口也已完成，相关 `agent-session-manager` / `subagent announce` 测试通过。

换句话说：结构重组这条线已从“实现中”转入“验证与是否继续细化”的阶段。

## 6. 当前工作树的重点文件

与本轮未提交改动直接相关的主要文件：

- [index.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/index.ts)
- [create-rpc-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/create-rpc-handlers.ts)
- [system-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/system-handlers.ts)
- [channel-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/channel-handlers.ts)
- [memory-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/memory-handlers.ts)
- [automation-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/automation-handlers.ts)
- [channel-gateway-handlers.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/channel-gateway-handlers.ts)
- [create-rpc-handlers.test.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/rpc/create-rpc-handlers.test.ts)
- [package.json](/E:/projects/ai-projects/lume/apps/sidecar/package.json)
- [smoke-agent-new-runtime-error.mjs](/E:/projects/ai-projects/lume/apps/sidecar/scripts/smoke-agent-new-runtime-error.mjs)
- [smoke-agent-new-runtime-compact.mjs](/E:/projects/ai-projects/lume/apps/sidecar/scripts/smoke-agent-new-runtime-compact.mjs)
- [agent-service.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/agent-service.ts)
- [agent-stream-converter.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/agent-stream-converter.ts)
- [attempt.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts)
- [pi-tools.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/pi-tools.ts)
- [run.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/run.ts)
- [subscribe.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/runtime-core/subscribe.ts)
- [map-pi-session-event.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/pi-agent/subscribe/map-pi-session-event.ts)
- [session-state-manager.ts](/E:/projects/ai-projects/lume/apps/sidecar/src/services/session-state-manager.ts)
- [agent-atoms.ts](/E:/projects/ai-projects/lume/apps/web/atoms/agent-atoms.ts)
- [AgentView.tsx](/E:/projects/ai-projects/lume/apps/web/components/agent/AgentView.tsx)
- [ContextUsageBadge.tsx](/E:/projects/ai-projects/lume/apps/web/components/agent/ContextUsageBadge.tsx)
- [openclaw-alignment-full-refactor-plan.md](/E:/projects/ai-projects/lume/docs/plans/openclaw-alignment-full-refactor-plan.md)

另有一个无关本轮任务的本地改动：

- [project.yml](/E:/projects/ai-projects/lume/.serena/project.yml)

我没有处理这个文件，不建议在恢复任务时把它混进本轮提交。

## 7. 下一个会话建议直接做的事

推荐顺序：

1. 跑当前工作树的 sidecar 验证闭环：
   - `bun run --filter @lume/sidecar build`
   - `bun run --filter @lume/sidecar smoke:agent-new-runtime`
   - `bun run --filter @lume/sidecar smoke:agent-new-runtime:error`
   - `bun run --filter @lume/sidecar smoke:agent-new-runtime:stop`
   - `bun run --filter @lume/sidecar smoke:agent-new-runtime:compact`
2. 如果验证全绿，评估是否还要继续拆 `rpc/schemas.ts`；这已经是可选清理项，不是当前阻塞。
3. runtime 对齐主线回到真实剩余项：长会话 compaction smoke、复杂工具链/权限链 smoke、以及 transcript 投影语义的继续验证。

## 8. 开新会话时可直接使用的提示

如果要在新会话继续，可以直接说明：

`继续处理 docs/plans/2026-03-24-sidecar-runtime-handoff.md 里记录的 sidecar runtime 收尾任务。index.ts 的 RPC handler 拆分和 transcript-only 收口已经完成，优先扩大 compaction 与复杂工具链 smoke，再评估是否继续拆 rpc/schemas.ts。`

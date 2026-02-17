# Lume Pi Agent 迁移实施方案（对齐 OpenClaw）

## 1. 背景与目标

当前 Lume Agent 运行时已完成从 `@anthropic-ai/claude-agent-sdk` 到 Pi Agent 的迁移收敛。
本方案用于记录在 **不破坏现有 UI/IPC 合约** 前提下，sidecar Agent Runtime 对齐 OpenClaw 的实施过程与最终状态。

核心目标：
- 用 Pi Agent Runtime 替换 Claude SDK Runtime。
- 复用 OpenClaw 已验证模块，减少自研逻辑。
- 保持 Lume 既有能力：会话管理、流式事件、Memory/Soul/Workspace 注入、AskUserQuestion、ExitPlanMode。
- 在迁移阶段支持灰度切换，最终收敛到单一 Pi runtime。

## 2. 对齐基线（OpenClaw 参考）

以下是本次迁移直接参考的 OpenClaw 核心实现：
- `openclaw/src/agents/pi-embedded-runner/run.ts`
- `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`
- `openclaw/src/agents/pi-embedded-subscribe.handlers.ts`
- `openclaw/src/agents/pi-tools.ts`
- `openclaw/src/agents/pi-embedded-runner/system-prompt.ts`
- `openclaw/src/agents/system-prompt.ts`

关键设计点：
- Runtime 层：`runEmbeddedPiAgent` + `runEmbeddedAttempt` 负责模型、会话、工具、流式订阅、重试/补偿。
- Tool 层：`createOpenClawCodingTools` 统一组装工具并叠加策略过滤（profile/allow/deny/subagent/sandbox）。
- Prompt 层：`buildAgentSystemPrompt` 模块化拼接 + `full/minimal/none` 模式。
- Subscribe 层：事件处理器拆分 message/tool/lifecycle，统一映射为上层事件。

## 3. Lume 当前现状（迁移输入）

当前 Lume 关键入口：
- `apps/sidecar/src/services/agent-service.ts`（Claude SDK query 主流程）
- `apps/sidecar/src/services/agent-stream-converter.ts`
- `apps/sidecar/src/services/agent-stream-accumulator.ts`
- `apps/sidecar/src/services/agent-prompt-builder.ts`
- `apps/sidecar/src/services/memory-mcp-service.ts`

当前能力状态：
- 已具备 `full/minimal/none` prompt mode（Lume 侧）与 memory/soul 注入。
- 工具能力依赖 Claude SDK 内置工具 + MCP 注入，无法完全掌控执行生命周期。

## 4. 目标架构（Lume 版 Pi Agent）

### 4.1 架构分层

- `apps/sidecar/src/services/pi-agent/runner/`
  - 执行主链：run、attempt、abort、queue、session lifecycle。
- `apps/sidecar/src/services/pi-agent/tools/`
  - 工具组装、工具策略、tool schema 兼容、before/after hook。
- `apps/sidecar/src/services/pi-agent/subscribe/`
  - Pi stream event -> Lume `AgentEvent` 映射。
- `apps/sidecar/src/services/pi-agent/prompt/`
  - 复用现有 `agent-prompt-builder`，对接 Pi session `setSystemPrompt`。

### 4.2 与现有服务的边界

- `agent-service.ts` 保持 IPC 合约不变，仅替换底层 runtime 调用。
- `agent-session-manager.ts`、`agent-stream-accumulator.ts` 保留并复用。
- memory 能力沿用当前 `memory-*` 服务，不重写索引/检索核心。

## 5. 模块映射（OpenClaw -> Lume）

- `pi-embedded-runner/run.ts` -> `apps/sidecar/src/services/pi-agent/runner/run.ts`
- `pi-embedded-runner/run/attempt.ts` -> `apps/sidecar/src/services/pi-agent/runner/attempt.ts`
- `pi-embedded-subscribe.handlers.ts` -> `apps/sidecar/src/services/pi-agent/subscribe/handlers.ts`
- `pi-tools.ts` -> `apps/sidecar/src/services/pi-agent/tools/create-lume-tools.ts`
- `pi-embedded-runner/system-prompt.ts` -> `apps/sidecar/src/services/pi-agent/prompt/system-prompt.ts`

策略：**先迁移（复制+适配）再重构**，避免一次性重写。

## 6. 分阶段执行计划（可直接开工）

## Phase 0：基线与开关

目标：引入 Pi 依赖并建立 runtime 切换开关。

任务：
1. 在 `apps/sidecar/package.json` 增加依赖：
   - `@mariozechner/pi-agent-core`
   - `@mariozechner/pi-ai`
   - `@mariozechner/pi-coding-agent`
2. 增加配置开关：`LUME_AGENT_RUNTIME=claude_sdk|pi_agent`（默认 `claude_sdk`）。
3. 在 `agent-service.ts` 抽象 `runAgentRuntime()`，统一输入输出。

验收：
- 不改默认行为时，现有测试与功能不回归。

## Phase 1：Pi Runner 骨架落地

目标：让 Lume 可跑通 Pi Session（最小可运行）。

任务：
1. 新建 `pi-agent/runner/run.ts`、`pi-agent/runner/attempt.ts`。
2. 先仅支持 text prompt + 内置 coding 工具（read/write/edit/bash）。
3. 将 Pi streaming 回调转发给现有 `agent-stream-accumulator`。

验收：
- 能创建会话并流式回复。
- `agent:send-message` 主链可用（feature flag 下）。

## Phase 2：工具系统迁移（复用 OpenClaw）

目标：工具能力对齐 OpenClaw 的可控模型。

任务：
1. 迁移 `pi-tools` 相关模块，优先复用：
   - tool policy（allow/deny/profile/subagent）
   - before-tool-call/abort wrapper
   - schema normalize
2. 接入 Lume 的 `AskUserQuestion` 与 `ExitPlanMode`。
3. 将 `memory_search/memory_get/memory_save` 作为 Pi custom tool 注入（复用现有 memory service）。

验收：
- 工具列表可枚举、可过滤、可审计。
- subagent 默认工具收敛（不暴露高风险工具）。

## Phase 3：会话/事件语义对齐

目标：事件模型对齐，避免前端行为回归。

任务：
1. 实现 `subscribe` handlers（message/tool/lifecycle）。
2. 事件映射到 Lume `AgentEvent`：
   - `assistant_chunk`
   - `tool_start/tool_update/tool_result`
   - `usage_update`
   - `complete/error`
3. 补充运行中断、timeout、abort 处理。

验收：
- 前端 `AgentView` 无需改协议即可展示工具流。
- 停止运行稳定（无僵尸会话）。

## Phase 4：Prompt + Soul/Memory 深度对齐

目标：prompt 注入链路切到 Pi，同时保持我们现有对齐成果。

任务：
1. 在 Pi session 初始化时设置系统提示词（`setSystemPrompt`）。
2. 复用 `agent-prompt-builder.ts`（当前已对齐 full/minimal/none、Memory Recall、Project Context）。
3. 对 subagent 强制 `minimal`，main/group/channel 默认 `full`。

验收：
- Soul 与 Memory 读取提示词行为与当前一致。
- prompt mode 在 Pi runtime 下稳定生效。

## Phase 5：并行运行与灰度切换

目标：安全替换，不中断现网可用性。

任务：
1. 保持双 runtime（Claude SDK / Pi Agent）可切换。
2. 增加 smoke 用例：
   - create workspace
   - chat send/stream
   - agent send/stream
   - restart restore
3. 在 dev 环境先默认 Pi，回归通过后切默认值。

验收：
- Pi runtime 覆盖核心路径并稳定运行。
- 切换开关可一键回退。

## Phase 6：收尾与清理

目标：移除冗余代码，收敛架构。

任务：
1. 删除 Claude SDK 专属运行链（保留必要兼容层）。
2. 清理旧转换器里 SDK 特有分支。
3. 更新文档与运维说明。

验收：
- sidecar runtime 主链只保留 Pi Agent。
- 文档与实现一致。

## 7. 具体文件改造清单（第一批）

新增：
- `apps/sidecar/src/services/pi-agent/runner/run.ts`
- `apps/sidecar/src/services/pi-agent/runner/attempt.ts`
- `apps/sidecar/src/services/pi-agent/runner/types.ts`
- `apps/sidecar/src/services/pi-agent/tools/create-lume-tools.ts`
- `apps/sidecar/src/services/pi-agent/tools/tool-policy.ts`
- `apps/sidecar/src/services/pi-agent/subscribe/handlers.ts`
- `apps/sidecar/src/services/pi-agent/prompt/system-prompt.ts`

修改：
- `apps/sidecar/src/services/agent-service.ts`（runtime adapter + flag 切换）
- `apps/sidecar/src/services/agent-prompt-builder.ts`（继续作为统一 prompt source）
- `apps/sidecar/package.json`（新增 Pi 依赖）

## 8. 测试与验收矩阵

单测：
- prompt mode（full/minimal/none）
- tool policy（allow/deny/profile/subagent）
- memory tools 行为（search/get/save + citations）
- event mapping（tool/message/lifecycle）

冒烟：
- 会话创建 -> 发送消息 -> 工具调用 -> 流式输出 -> 完成
- AskUserQuestion 闭环
- stop 中断
- restart 恢复

失败回滚：
- 设置 `LUME_AGENT_RUNTIME=claude_sdk` 即时回退。

## 9. 风险与应对

风险 1：Pi Agent 依赖与 Bun/Node 运行时兼容问题。
- 应对：先在 sidecar 内做独立 smoke runner；保留双 runtime。

风险 2：工具 schema 与现有前端事件不一致。
- 应对：先做 adapter 层，不直接改前端协议。

风险 3：会话文件格式迁移导致历史会话不可读。
- 应对：先兼容旧格式读取，延后格式统一。

## 10. Definition of Done（本任务）

- 已建立 Pi Agent 迁移分支。
- 已产出可执行实施文档（本文件）。
- 文档包含架构方案、模块映射、分阶段步骤、验收与回滚。

## 11. 当前执行分支

- `feat-pi-agent-migration-plan`

## 12. 迁移进度清单（持续更新）

### 12.1 已完成

- `LUME_AGENT_RUNTIME` 在迁移阶段用于双运行时灰度；现已收敛为 `pi_agent` 单运行时。
- `agent-service` 已接入 Pi runtime 分发、停止控制、AskUserQuestion 回传桥接。
- Pi 基础 runner 已接入真实模型调用（Anthropic/OpenAI/Google）与 API key 解密。
- 系统提示词已复用 `agent-prompt-builder`，包含 Soul/Memory 注入与 mode 选择。
- Pi custom tools 已接入：
  - `AskUserQuestion`
  - `ExitPlanMode`
  - `memory_search/memory_get/memory_save`
- Pi 事件映射已覆盖：
  - `text_delta`
  - `tool_start/tool_result`
  - `usage_update`
  - `compacting/compact_complete`
- Pi 代码结构已按 OpenClaw 风格拆分：
  - `runner/run.ts + runner/attempt.ts`
  - `subscribe/handlers.ts`
  - `tools/create-lume-tools.ts + tools/tool-policy.ts`
- Pi 会话元数据已显式绑定 `piSessionId`，用于方案 B 下 provider/session 语义续接。
- Pi runner 已具备 attempt 重试框架（`run -> attempt`），支持基于错误类型的重试判定与 `LUME_PI_AGENT_MAX_ATTEMPTS` 配置。
- Pi runtime 主执行内核已切换到方案 B：`@mariozechner/pi-agent-core Agent`（不再依赖 `createAgentSession/SessionManager` 黑盒路径）。
- 内置 coding tools 已改为显式组装（`createReadTool/createWriteTool/...`）并与 Lume custom tools 合并注入。
- `permissionMode` 已对齐到 Pi 工具策略：`plan` 模式仅注入只读工具（`read/find/grep/ls`）。
- 方案 B 下已恢复 compaction 生命周期事件：当历史消息触发上下文裁剪时发出 `compacting/compact_complete`，并写入 assistant 事件轨迹。
- 会话状态逻辑已对齐到 Pi 路径：
  - token 更新
  - compaction 计数
  - memory flush 检查入口
  - heartbeat 启动
- Pi 完成后已支持自动标题生成（与 Claude 路径一致）。
- 关键单测与 `apps/sidecar` typecheck 通过。
- 已新增 `smoke:agent-stream` 自动化脚本，覆盖 `agent:send-message -> stream:error` 通知链路（无外网依赖）。
- 已新增 `smoke:agent-success-restore` 自动化脚本，覆盖 `agent:send-message` 成功路径（mock）与 sidecar 重启后会话/消息恢复链路。
- 已新增 `smoke:chat-stream` 自动化脚本，覆盖 `chat:send-message` 的 chunk/complete 流事件与消息落盘验证（mock）。

### 12.2 待完成（明确剩余）

- 无。

### 12.3 Phase 6 完成情况

- Agent runtime 已强制收敛到 Pi（`resolveAgentRuntime` 固定返回 `pi_agent`）。
- `agent-service` 已移除 Claude/Pi 双分支调度，`sendAgentMessage` 只走 Pi runtime。
- `agent-service` 已清理 Claude SDK 遗留死代码（SDK 路径解析、旧 MCP 拼装、旧上下文注入分支等）。
- `@anthropic-ai/claude-agent-sdk` 已从 `apps/sidecar/package.json` 依赖中移除。
- 现有 smoke（agent error/success/chat）与 typecheck 全部通过。

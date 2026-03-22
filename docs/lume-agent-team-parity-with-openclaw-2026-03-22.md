# Lume 新增 Agent Team 能力对齐方案（对齐 OpenClaw）

日期：2026-03-22
适用仓库：`/Users/cavinhuang/workspace/projects/ai-projects/Lume`
openclaw：/Users/cavinhuang/workspace/projects/test/openclaw
目标目录：`docs/`

## 1. 目标与范围

目标：在不破坏 Lume 现有 IPC/UI 合约的前提下，将 Lume 的 agent team 能力从“基础 subagent 可运行”提升到“接近 OpenClaw 当前生产实现”。

本方案覆盖：
- `sessions_spawn` 从“记录 agentId”升级为“真正多 agent 路由”。
- 建立 subagent run registry（状态机、持久化、查询）。
- 建立完成回传 announce 链路（async 子任务自动回传父会话）。
- 建立 subagent 控制面（list/kill/send/steer）。
- 建立深度/扇出/角色/工具策略约束。
- 建立线程绑定与投递目标 hook（如后续多渠道需要）。
- 前端提供 Proma 风格的 Team 可视化侧面板（`Team + Files` 双 Tab，基于工具活动回放）。

不在本轮覆盖：
- 全量复制 OpenClaw 的所有渠道插件实现。
- Proma inbox 轮询通信时间线、teammate 深度 telemetry 面板（后续在 runtime 完整后补齐）。

## 2. 对齐基线（OpenClaw -> Lume）

OpenClaw 参考点（语义基线）：
- `src/agents/subagent-spawn.ts`
- `src/agents/subagent-registry.ts`
- `src/agents/subagent-registry.store.ts`
- `src/agents/subagent-announce.ts`
- `src/agents/subagent-announce-dispatch.ts`
- `src/agents/subagent-control.ts`
- `src/agents/tools/sessions-spawn-tool.ts`
- `src/agents/tools/subagents-tool.ts`
- `src/agents/subagent-depth.ts`
- `src/agents/subagent-capabilities.ts`
- `src/agents/pi-tools.policy.ts`
- `src/routing/resolve-route.ts`

Lume 当前实现入口（改造起点）：
- `apps/sidecar/src/services/pi-agent/tools/create-openclaw-aligned-tools.ts`
- `apps/sidecar/src/services/pi-agent/run-pi-agent-message.ts`
- `apps/sidecar/src/services/agent-service.ts`
- `apps/sidecar/src/services/pi-agent/tools/tool-policy.ts`
- `apps/sidecar/src/services/agent-prompt-builder.ts`
- `packages/shared/src/types/agent.ts`

## 3. 实施原则

1. 保行为兼容：优先兼容当前 `sessions_spawn` 输入输出字段，不先破坏调用方。
2. 先 runtime，后 UI：先把状态管理、回传、控制做稳，再决定 UI 暴露。
3. 小步提交：每个 PR 独立可测、可回滚。
4. 最小可用安全：先落深度/扇出/ownership 硬限制，再放开高级能力。
5. 可观测先行：所有 run 全链路必须可追踪（runId/sessionId/parentRunId/agentId）。

## 4. 分阶段路线（P0 -> P3）

### P0（最小闭环）
- 新增 subagent registry（内存 + 文件持久化）。
- `sessions_spawn` 接入 registry，生成 `runId`，同步/异步统一。
- 子任务完成后写入 registry 终态。

### P1（可靠回传）
- 增加 announce 服务：子任务完成后向父会话发送 completion 事件。
- 支持多层父子链路。
- 异常/超时/取消都可回传。

### P2（可控治理）
- 增加 `subagents_*` 控制工具：list/kill/send/steer。
- 增加 ownership 校验与级联 kill。
- 增加深度限制与每父会话最大子任务数限制。

### P3（策略与渠道）
- 角色能力模型（main/orchestrator/leaf）。
- `tool-policy` 对 subagent 角色进行硬限制。
- 线程绑定 + 投递目标 hook（按 Lume 渠道架构接入）。

## 5. 文件级改造清单（建议）

### 5.1 新增文件

1. `apps/sidecar/src/services/pi-agent/subagents/subagent-run.types.ts`
- 定义 run 实体、状态、结果、失败原因、时间戳结构。

2. `apps/sidecar/src/services/pi-agent/subagents/subagent-run-registry.ts`
- 提供 create/get/update/list/archive API。

3. `apps/sidecar/src/services/pi-agent/subagents/subagent-run-store.ts`
- 提供原子持久化（JSON）与恢复加载。

4. `apps/sidecar/src/services/pi-agent/subagents/subagent-spawn-service.ts`
- 统一处理 spawn 参数校验、限制校验、run 创建、执行调度。

5. `apps/sidecar/src/services/pi-agent/subagents/subagent-announce-service.ts`
- 处理 completion 回传逻辑（父会话/多层父链）。

6. `apps/sidecar/src/services/pi-agent/subagents/subagent-control-service.ts`
- list/kill/send/steer 的服务层实现。

7. `apps/sidecar/src/services/pi-agent/subagents/subagent-policy.ts`
- 深度、扇出、ownership、sandbox 继承策略。

8. `apps/sidecar/src/services/pi-agent/subagents/subagent-thread-binding.ts`
- 线程绑定/解绑接口（先提供 sidecar 抽象，后续由渠道层接实现）。

9. `apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-*.test.ts`
- 覆盖 registry/spawn/announce/control/policy。

### 5.2 修改文件

1. `apps/sidecar/src/services/pi-agent/tools/create-openclaw-aligned-tools.ts`
- 将 `sessions_spawn` 改为调用 `subagent-spawn-service`。
- 新增 `subagents_*` 工具定义并接入 `subagent-control-service`。

2. `apps/sidecar/src/services/pi-agent/run-pi-agent-message.ts`
- 完成/失败/超时时触发 registry 终态更新 + announce。

3. `apps/sidecar/src/services/agent-service.ts`
- 注入 subagent 服务依赖，统一生命周期事件出口。

4. `apps/sidecar/src/services/pi-agent/tools/tool-policy.ts`
- 加入 session role/depth 限制规则，子代理默认收敛工具集。

5. `apps/sidecar/src/services/agent-prompt-builder.ts`
- 在 subagent 场景补充角色上下文（minimal prompt + role hint）。

6. `packages/shared/src/types/agent.ts`
- 扩展共享类型：session role、subagent run status、control command type。

7. `apps/sidecar/src/index.ts`
- 若需新增 IPC：补 `subagents:list|kill|send|steer` 路由与 schema。

## 6. PR 拆分方案（可直接建分支执行）

### PR-1：Subagent Run Registry 基建

目标：把“子任务运行状态”独立为可持久化实体。

涉及文件：
- Create: `apps/sidecar/src/services/pi-agent/subagents/subagent-run.types.ts`
- Create: `apps/sidecar/src/services/pi-agent/subagents/subagent-run-registry.ts`
- Create: `apps/sidecar/src/services/pi-agent/subagents/subagent-run-store.ts`
- Modify: `packages/shared/src/types/agent.ts`
- Test: `apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-run-registry.test.ts`

测试点：
- create/get/update/list 正常。
- 进程重启后可恢复。
- 写入失败时不破坏内存态。

验收：
- 任意 spawned task 都能拿到唯一 `runId` 并可查询。

### PR-2：sessions_spawn 编排升级（agentId 生效）

目标：让 `sessions_spawn` 成为真正编排入口。

涉及文件：
- Create: `apps/sidecar/src/services/pi-agent/subagents/subagent-spawn-service.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/create-openclaw-aligned-tools.ts`
- Modify: `apps/sidecar/src/services/agent-service.ts`
- Test: `apps/sidecar/src/services/pi-agent/tools/create-openclaw-aligned-tools.test.ts`
- Test: `apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-spawn-service.test.ts`

测试点：
- `agentId` 路由命中正确。
- sync（wait）和 async（accepted）输出结构稳定。
- 参数非法、agent 不可用时返回结构化错误。

验收：
- 删除“agentId 仅记录不生效”现状。

### PR-3：Completion Announce 回传链路

目标：async 子任务完成后自动通知父会话。

涉及文件：
- Create: `apps/sidecar/src/services/pi-agent/subagents/subagent-announce-service.ts`
- Modify: `apps/sidecar/src/services/pi-agent/run-pi-agent-message.ts`
- Modify: `apps/sidecar/src/services/agent-service.ts`
- Test: `apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-announce-service.test.ts`

测试点：
- success/error/timeout/abort 都会回传。
- 父链 2 层以上不丢通知。
- announce 失败有重试或降级日志。

验收：
- async spawn 不再需要人工轮询判断是否完成。

### PR-4：Subagents 控制面（list/kill/send/steer）

目标：具备最小治理能力。

涉及文件：
- Create: `apps/sidecar/src/services/pi-agent/subagents/subagent-control-service.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/create-openclaw-aligned-tools.ts`
- Modify: `apps/sidecar/src/index.ts`（若暴露 IPC）
- Test: `apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-control-service.test.ts`

测试点：
- list 可按 controller/session 过滤。
- kill 支持单 run 与子树级联。
- send/steer 仅允许 owner 操作。

验收：
- 运行中子任务可被管理，不需手工删 session 文件。

### PR-5：深度/扇出/ownership/sandbox 约束

目标：把安全治理变成硬约束。

涉及文件：
- Create: `apps/sidecar/src/services/pi-agent/subagents/subagent-policy.ts`
- Modify: `apps/sidecar/src/services/pi-agent/subagents/subagent-spawn-service.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/tool-policy.ts`
- Test: `apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-policy.test.ts`

测试点：
- 超深度拒绝。
- 超扇出拒绝。
- 非 owner 控制拒绝。
- sandbox=require 时子任务无法放宽权限。

验收：
- 风险行为默认拒绝，且错误消息可诊断。

### PR-6：角色能力模型（main/orchestrator/leaf）

目标：细化 subagent 能力边界。

涉及文件：
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `apps/sidecar/src/services/pi-agent/tools/tool-policy.ts`
- Modify: `apps/sidecar/src/services/agent-prompt-builder.ts`
- Test: `apps/sidecar/src/services/pi-agent/tools/tool-policy.test.ts`

测试点：
- leaf 默认禁 `sessions_spawn` 和子管理工具。
- main/orchestrator 按策略可控放开。
- prompt 注入角色上下文后行为稳定。

验收：
- 子代理“只做执行”边界清晰。

### PR-7：线程绑定与投递目标 Hook

目标：为多渠道准备 thread/focus/unfocus 对齐能力。

涉及文件：
- Create: `apps/sidecar/src/services/pi-agent/subagents/subagent-thread-binding.ts`
- Modify: `apps/sidecar/src/services/pi-agent/subagents/subagent-spawn-service.ts`
- Modify: `apps/sidecar/src/services/pi-agent/subagents/subagent-announce-service.ts`
- Test: `apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-thread-binding.test.ts`

测试点：
- spawn 绑定线程成功。
- 子任务完成自动解绑。
- 指定 delivery target 生效。

验收：
- 多渠道下消息落点可预测，不串线。

### PR-8：可观测性 + 稳定性收尾

目标：上线前可运营、可排障。

涉及文件：
- Modify: `apps/sidecar/src/services/pi-agent/run-pi-agent-message.ts`
- Modify: `apps/sidecar/src/services/pi-agent/subagents/*.ts`
- Modify: `apps/sidecar/src/index.ts`（若补查询接口）
- Test: `apps/sidecar/src/services/pi-agent/subagents/__tests__/subagent-e2e-flow.test.ts`
- Doc: `docs/` 新增操作手册（可单独 PR）

测试点：
- 日志字段完整（runId/parentRunId/sessionId/agentId）。
- 异常路径可定位。
- 并发 spawn 稳定性验证。

验收：
- 核心链路具备“问题可重放、可诊断”。

## 7. 详细执行清单（按任务打勾）

### 7.1 架构与类型
- [x] 定义 `SubagentRun`、`SubagentRunStatus`、`SubagentOutcome` 类型。
- [x] 定义 `SubagentControlCommand` 输入输出契约。
- [x] 为持久化结构加版本号字段（`version`）。

### 7.2 Spawn 链路
- [x] `sessions_spawn` 接入统一 subagent 编排逻辑（当前落在 tool 内实现，后续可抽 service）。
- [x] run 创建时写入 registry 并返回 `runId`。
- [x] 支持 sync/async 两种调用语义。
- [x] `agentId` 命中逻辑接入真实路由。

### 7.3 生命周期与回传
- [x] run 开始/完成/失败/取消状态完整写入。
- [x] completion announce 到父会话。
- [x] announce 失败重试策略与最大次数。
- [x] 父级不可达时保留待投递记录（在 run 上写入 announce 失败状态/次数/错误）。

### 7.4 控制面
- [x] 实现 `subagents_list`。
- [x] 实现 `subagents_kill`（含级联）。
- [x] 实现 `subagents_send`。
- [x] 实现 `subagents_steer`。

### 7.5 安全与策略
- [x] 深度限制（max depth）。
- [x] 扇出限制（max children per parent）。
- [x] ownership 校验。
- [x] sandbox 权限继承限制。
- [x] leaf 角色工具硬限制（subagent 默认禁 session/group:sessions 工具）。

### 7.6 线程与投递
- [x] 抽象 thread binding 接口。
- [x] spawn 时绑定（可选开关）。
- [x] end 时解绑。
- [x] delivery target 可重定向。

### 7.7 可观测性
- [x] 统一日志字段与日志等级。
- [x] 增加 registry 状态查询接口（内部或 IPC）。
- [x] 增加 run 级错误码映射表。

### 7.8 测试
- [x] registry 单测。
- [x] spawn 单测（sync/async/错误）。
- [x] announce 单测（多层父链）。
- [x] control 单测（owner/非 owner）。
- [x] policy 单测（深度/扇出/sandbox）。
- [x] e2e 流程测试（并发 + 失败恢复）。

### 7.9 文档与运维
- [x] 在 `docs/` 增加操作说明（如何 list/kill/查 run）。
- [x] 记录回滚开关与应急处理步骤。
- [x] 记录已知限制与后续演进路线。

## 8. 验收标准（Definition of Done）

必须全部满足：
1. `sessions_spawn` 的 `agentId` 已真实生效。
2. 每个子任务存在可查询 `runId`，可追踪到终态。
3. async 子任务完成后，父会话自动收到 completion。
4. 存在 `subagents_list` 与 `subagents_kill` 控制能力。
5. 深度/扇出/ownership/sandbox 限制已上线并有测试覆盖。
6. 子代理角色默认受限（leaf 不可继续编排）。
7. 日志能串起一次完整运行链路。
8. 关键单测和集成测试通过。

## 9. 风险与回滚

主要风险：
- 回传链路引入重复通知或漏通知。
- 并发 spawn 下 registry 写入竞争。
- 过严策略导致合法子任务被误拒。

回滚策略：
1. 保留 feature flag：`ENABLE_SUBAGENT_TEAM_V2`。
2. 发现生产问题时，切回旧 `sessions_spawn` 实现。
3. registry 文件结构升级必须兼容读取旧版本；不可读时降级为内存态并告警。

## 10. 建议执行顺序（最短路径）

1. 先做 PR-1 + PR-2：完成 run registry + spawn 编排闭环。
2. 再做 PR-3：把 async 回传打通。
3. 再做 PR-4 + PR-5：控制面与安全约束。
4. 最后做 PR-6 ~ PR-8：角色、线程、可观测收尾。

这一路径可以最早在 PR-3 达到“可用”，PR-5 达到“可控”，PR-8 达到“可运营”。

## 11. 当前进展（2026-03-22）

已完成（本轮）：
- ✅ 前端：已落 Proma 风格 `Team + Files` 侧面板与 Team 活动视图（基于 toolActivities + 历史消息回放）。
- ✅ Runtime：新增 subagent run registry（`subagent-runs.json` 持久化，支持 create/get/update/list）。
- ✅ Runtime：`sessions_spawn` 已写入并返回稳定 `runId`，同步/异步路径都会更新 run 终态。
- ✅ Runtime：`sessions_spawn.agentId` 已生效（可按目标会话的 channel/model 路由，不再仅记录）。
- ✅ Runtime：async 完成回传已打通（announce service + 重试 + run announce 状态字段）。
- ✅ Runtime：新增 sidecar -> web 消息追加通知通道（`agent:message-appended`），父会话可实时接收完成通知消息。
- ✅ 工具：`agents_list` 已返回可用于 `sessions_spawn` 的会话型 agentId（含会话列表）。
- ✅ 控制面：已实现 `subagents_list / subagents_kill / subagents_send / subagents_steer`（owner 范围，kill 支持级联）。
- ✅ 策略：已实现深度/扇出/ownership/sandbox 硬限制（含测试覆盖）。
- ✅ 线程与投递：已实现 sidecar 级 thread binding 抽象、spawn 绑定、完成解绑、`deliverySessionKey` 重定向投递。
- ✅ 可观测：新增统一 subagent 日志字段模板（run/session/agent/status/errorCode）并接入 registry + announce 链路。
- ✅ 可观测：新增 `agent:list-subagent-runs` IPC 查询接口（owner/runId/status/limit + statusSummary）。
- ✅ 稳定性：新增 `ENABLE_SUBAGENT_TEAM_V2` 回滚开关（关闭后禁用 `sessions_spawn/subagents_*`）。
- ✅ 前端：Team 面板接入 run registry 轮询数据（非流式回合同步刷新子任务状态）。
- ✅ 前端：Team Agent 卡片补 run 级 telemetry（runId/usage/errorCode/announce）。

已补测试：
- ✅ `subagent-run-registry.test.ts`（创建/更新/重启恢复）。
- ✅ `create-openclaw-aligned-tools.test.ts`（agentId 路由、生存期、control、深度/扇出限制）。
- ✅ `subagent-announce-service.test.ts`（completion 消息回传 + bus 事件）。
- ✅ `subagent-policy.test.ts`（深度/扇出/sandbox）。
- ✅ `subagent-e2e-flow.test.ts`（并发 spawn + 故障恢复 + 重启恢复）。

文档与运维：
- ✅ 新增 `docs/lume-agent-team-ops-runbook-2026-03-22.md`（list/kill/查 run、回滚开关、已知限制与演进路线）。

# Sidecar Services Modularization Next Plan

最后更新：2026-03-25（第一阶段完成）

## 1. 背景

当前 `apps/sidecar/src/services` 的 `agent` 第一阶段整理已经完成，并完成了验证闭环；`chat` 域第二阶段整理也已开始并完成首批收口。

本轮之前已经完成：

1. OpenClaw/Pi runtime 主链对齐到 `runtime-core`
2. transcript-only 收口
3. `AgentEvent + AgentRuntimeStatus` 共享契约打通
4. Agent/Chat 的 provider switch 运行级 smoke
5. 少量无引用壳文件删除

本轮已完成：

1. 把 `services` 根目录下散落的 Agent 主链文件收进 `services/agent/`
2. 修正 `rpc / memory / channel-gateway / pi-agent` 等引用链路
3. 恢复本地依赖并完成 `typecheck / build / 单测 / smoke` 验证
4. 把 `chat-service / conversation-manager / attachment-service / chat-tool-* / chat-tools-watcher` 收进 `services/chat/`
5. 完成 chat 域重组后的 `typecheck + chat 相关测试` 验证
6. 把 `system-prompt-manager / workspace-bootstrap-service / global-discovery-service / proxy-settings-manager` 收进 `services/system/`
7. 完成 system 域重组后的 `typecheck + system 相关测试` 验证
8. 把 `automation-manager / automation-runner-service` 收进 `services/automation/`
9. 把 `session-state-manager / heartbeat-service` 收进 `services/runtime/`
10. 完成 automation/runtime 重组后的 `typecheck + 相关测试` 验证

## 2. 最近已提交检查点

- 分支：`feat/openclaw-runtime-realignment`
- 最近已提交 commit：`3f5705a`
- commit message：`feat(sidecar): ✨ 打通 Agent 与 Chat 的 provider 切换链路并清理冗余服务壳文件`

如果要从“已提交且稳定”的点重新开始，可以从这个 commit 建立理解。

## 3. 当前工作树状态

### 3.1 已完成但未提交的整理

已移动到 `services/agent/`：

- `agent-stream-accumulator.ts`
- `agent-stream-accumulator.test.ts`
- `plan-state-tracker.ts`
- `plan-state-tracker.test.ts`
- `session-title-summarizer.ts`
- `session-title-summarizer.test.ts`
- `agent-session-manager.ts`
- `agent-session-manager.test.ts`
- `agent-session-manager.transcript-append.test.ts`
- `agent-workspace-manager.ts`
- `agent-files-service.ts`
- `agent-files-service.test.ts`
- `agent-runtime-status-manager.ts`
- `agent-runtime-status-manager.test.ts`
- `agent-service.ts`
- `agent-service.test.ts`

已同步 import 的主要文件：

- `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts`
- `apps/sidecar/src/rpc/agent-handlers.ts`
- `apps/sidecar/src/rpc/create-rpc-handlers.ts`
- `apps/sidecar/src/services/automation-runner-service.ts`
- `apps/sidecar/src/services/channel-gateway/gateway-service.ts`
- `apps/sidecar/src/services/memory/session-files.ts`
- `apps/sidecar/src/services/memory/session-files.test.ts`
- `apps/sidecar/src/services/index-recovery.test.ts`
- `apps/sidecar/src/services/global-discovery-service.ts`
- `apps/sidecar/src/services/chat-service.ts`
- `apps/sidecar/src/services/agent-prompt-builder.ts`

已删除的无用/壳文件：

- `apps/sidecar/src/services/agent-stream.ts`
- `apps/sidecar/src/services/agent-stream-converter.ts`
- `apps/sidecar/src/services/agent-runtime.ts`
- `apps/sidecar/src/services/agent-runtime.test.ts`

### 3.2 当前未提交文件

主要仍在变更中的文件：

- `apps/sidecar/src/rpc/agent-handlers.ts`
- `apps/sidecar/src/rpc/create-rpc-handlers.ts`
- `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts`
- `apps/sidecar/src/services/pi-agent/runtime-core/pi-model-discovery.ts`
- `apps/sidecar/src/services/pi-agent/pi-upstream-compat.test.ts`

新增但未提交：

- `apps/sidecar/src/services/agent/agent-stream-accumulator.ts`
- `apps/sidecar/src/services/agent/agent-stream-accumulator.test.ts`
- `apps/sidecar/src/services/agent/plan-state-tracker.ts`
- `apps/sidecar/src/services/agent/plan-state-tracker.test.ts`
- `apps/sidecar/src/services/agent/session-title-summarizer.ts`
- `apps/sidecar/src/services/agent/session-title-summarizer.test.ts`
- `apps/sidecar/src/services/agent/agent-session-manager.ts`
- `apps/sidecar/src/services/agent/agent-session-manager.test.ts`
- `apps/sidecar/src/services/agent/agent-session-manager.transcript-append.test.ts`
- `apps/sidecar/src/services/agent/agent-workspace-manager.ts`
- `apps/sidecar/src/services/agent/agent-files-service.ts`
- `apps/sidecar/src/services/agent/agent-files-service.test.ts`
- `apps/sidecar/src/services/agent/agent-runtime-status-manager.ts`
- `apps/sidecar/src/services/agent/agent-runtime-status-manager.test.ts`
- `apps/sidecar/src/services/agent/agent-service.ts`
- `apps/sidecar/src/services/agent/agent-service.test.ts`

### 3.3 当前状态结论

`services/agent/` 第一阶段整理已完成，并已完成验证。

换句话说：

1. `agent` 主链核心文件已全部收口到 `services/agent/`
2. 运行链路相关引用已修正
3. 当前下一步不应继续搬目录，而应进入提交收尾或下一阶段范围确认

## 4. 本阶段结果

本阶段实际完成范围仍然只覆盖 `pi-agent + agent` 主链的第一阶段整理，没有扩到整个 `services`。

### 4.1 已完成的目标目录边界

已收口到：

- `apps/sidecar/src/services/agent/`

本阶段已完成迁移：

1. `agent-session-manager.ts`
2. `agent-session-manager.test.ts`
3. `agent-session-manager.transcript-append.test.ts`
4. `agent-workspace-manager.ts`
5. `agent-files-service.ts`
6. `agent-runtime-status-manager.ts`
7. `agent-runtime-status-manager.test.ts`
8. `agent-service.ts`
9. `agent-service.test.ts`

本阶段明确未动：

1. `services/pi-agent/**`
2. `channel-manager.ts`
3. `model-selection.ts`
4. `memory/**`
5. `browser/**`
6. `channel-gateway/**`
7. `automation-*`

## 5. 实际执行顺序

### Step 1: 搬会话与工作区相关文件

优先迁移：

1. `agent-session-manager.ts`
2. `agent-session-manager.test.ts`
3. `agent-session-manager.transcript-append.test.ts`
4. `agent-workspace-manager.ts`
5. `agent-files-service.ts`

原因：

1. 它们之间依赖强，适合一起收口
2. 迁完后 `agent-service.ts` 再改 import 会更简单

### Step 2: 搬运行时状态相关文件

迁移：

1. `agent-runtime-status-manager.ts`
2. `agent-runtime-status-manager.test.ts`

原因：

1. 它已经是新的单独模块
2. 依赖面比 `agent-service.ts` 小

### Step 3: 最后迁移 `agent-service.ts`

原因：

1. 它是 Agent 主链汇聚点
2. 它依赖会话、工作区、状态机、Pi runtime
3. 放最后改 import 风险最低

## 6. 验证结果

已执行：

```bash
bun run typecheck
```

```bash
bun run build
```

```bash
bun test \
  src/services/agent/agent-stream-accumulator.test.ts \
  src/services/agent/plan-state-tracker.test.ts \
  src/services/agent/session-title-summarizer.test.ts \
  src/services/agent/agent-service.test.ts \
  src/services/agent/agent-session-manager.test.ts \
  src/services/agent/agent-session-manager.transcript-append.test.ts \
  src/services/agent/agent-files-service.test.ts \
  src/services/agent/agent-runtime-status-manager.test.ts
```

```bash
bun run smoke:agent-new-runtime
```

```bash
bun run smoke:agent-new-runtime:bridges
```

```bash
bun run smoke:agent-new-runtime:provider-switch
```

验证结果：

1. `typecheck` 通过
2. `build` 通过
3. 8 个相关测试文件共 39 个用例全部通过
4. `agent-new-runtime / bridges / provider-switch` smoke 全部通过

补充修复：

1. 依赖安装后发现 `AuthStorage` 上游 API 已改为 `AuthStorage.create(...)`
2. 已同步修正 `runtime-core/pi-model-discovery.ts` 与 `pi-upstream-compat.test.ts`

## 7. 风险与注意事项

1. `agent-session-manager.ts` 被 `channel-gateway`、`pi-agent/tools/create-openclaw-aligned-tools.ts`、`memory/session-files.ts` 等多处引用，搬迁时必须全量修 import。
2. `agent-service.ts` 仍然是连接 Pi runtime、channel/model 选择、runtime status 的汇聚点，不适合和目录清理一起做行为重构。
3. `services/pi-agent/**` 先不要动路径；当前它已经承担 `runtime-core / runner / tools / subagents / subscribe` 结构，路径变化会把风险放大。
4. 删除文件只做“确认无运行时代码引用”的安全删除，不要先删大文件再看报错。

## 8. 下一步建议

建议从以下两个方向二选一继续：

1. 继续按域收口，把 `infra(config-paths/logger)` 是否独立成基础设施目录做最终决策
2. 如继续细化，可考虑把 `memory` 域再拆为 `memory/indexing` 与 `memory/runtime`

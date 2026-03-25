# Sidecar Services Modularization Next Plan

最后更新：2026-03-25

## 1. 背景

当前 `apps/sidecar/src/services` 已经开始进行模块化整理，但还没有完成第一阶段。

本轮之前已经完成：

1. OpenClaw/Pi runtime 主链对齐到 `runtime-core`
2. transcript-only 收口
3. `AgentEvent + AgentRuntimeStatus` 共享契约打通
4. Agent/Chat 的 provider switch 运行级 smoke
5. 少量无引用壳文件删除

当前需要继续的是：

1. 把 `services` 根目录下仍然散落的 Agent 主链文件继续收进按模块分组的目录
2. 在不破坏运行链路的前提下，逐阶段清理无用文件和中转壳文件
3. 维持现有 smoke/typecheck 全绿

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

已同步 import 的主要文件：

- `apps/sidecar/src/services/agent-service.ts`
- `apps/sidecar/src/services/agent-service.test.ts`
- `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts`
- `apps/sidecar/src/rpc/agent-handlers.ts`
- `apps/sidecar/src/rpc/create-rpc-handlers.ts`

已删除的无用/壳文件：

- `apps/sidecar/src/services/agent-stream.ts`
- `apps/sidecar/src/services/agent-stream-converter.ts`
- `apps/sidecar/src/services/agent-runtime.ts`
- `apps/sidecar/src/services/agent-runtime.test.ts`

### 3.2 当前未提交文件

主要仍在变更中的文件：

- `apps/sidecar/src/rpc/agent-handlers.ts`
- `apps/sidecar/src/rpc/create-rpc-handlers.ts`
- `apps/sidecar/src/services/agent-service.ts`
- `apps/sidecar/src/services/agent-service.test.ts`
- `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts`

新增但未提交：

- `apps/sidecar/src/services/agent/agent-stream-accumulator.ts`
- `apps/sidecar/src/services/agent/agent-stream-accumulator.test.ts`
- `apps/sidecar/src/services/agent/plan-state-tracker.ts`
- `apps/sidecar/src/services/agent/plan-state-tracker.test.ts`
- `apps/sidecar/src/services/agent/session-title-summarizer.ts`
- `apps/sidecar/src/services/agent/session-title-summarizer.test.ts`

### 3.3 当前状态结论

第一阶段整理已经开始并验证通过，但还没完成。

换句话说：

1. 目录策略已经落地
2. 第一批低风险文件已经迁移
3. 接下来应继续迁移 Agent 主链核心文件，而不是再扩到 chat/memory/browser

## 4. 推荐的下一阶段范围

只做 `pi-agent + agent` 主链的第一阶段整理，不扩到整个 `services`。

### 4.1 目标目录边界

继续收口到：

- `apps/sidecar/src/services/agent/`

本阶段优先迁移：

1. `agent-session-manager.ts`
2. `agent-session-manager.test.ts`
3. `agent-session-manager.transcript-append.test.ts`
4. `agent-workspace-manager.ts`
5. `agent-files-service.ts`
6. `agent-runtime-status-manager.ts`
7. `agent-runtime-status-manager.test.ts`
8. `agent-service.ts`
9. `agent-service.test.ts`

本阶段明确不动：

1. `services/pi-agent/**`
2. `channel-manager.ts`
3. `model-selection.ts`
4. `memory/**`
5. `browser/**`
6. `channel-gateway/**`
7. `automation-*`

## 5. 推荐执行顺序

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

## 6. 每步验证命令

每完成一批搬迁后至少跑：

```bash
bun run --filter @lume/sidecar typecheck
```

第一阶段全部完成后跑：

```bash
bun test \
  apps/sidecar/src/services/agent/agent-stream-accumulator.test.ts \
  apps/sidecar/src/services/agent/plan-state-tracker.test.ts \
  apps/sidecar/src/services/agent/session-title-summarizer.test.ts \
  apps/sidecar/src/services/agent-service.test.ts \
  apps/sidecar/src/services/agent-session-manager.test.ts \
  apps/sidecar/src/services/agent-session-manager.transcript-append.test.ts
```

然后跑：

```bash
bun run --filter @lume/sidecar build
bun run --filter @lume/sidecar smoke:agent-new-runtime
bun run --filter @lume/sidecar smoke:agent-new-runtime:bridges
bun run --filter @lume/sidecar smoke:agent-new-runtime:provider-switch
```

## 7. 风险与注意事项

1. `agent-session-manager.ts` 被 `channel-gateway`、`pi-agent/tools/create-openclaw-aligned-tools.ts`、`memory/session-files.ts` 等多处引用，搬迁时必须全量修 import。
2. `agent-service.ts` 仍然是连接 Pi runtime、channel/model 选择、runtime status 的汇聚点，不适合和目录清理一起做行为重构。
3. `services/pi-agent/**` 先不要动路径；当前它已经承担 `runtime-core / runner / tools / subagents / subscribe` 结构，路径变化会把风险放大。
4. 删除文件只做“确认无运行时代码引用”的安全删除，不要先删大文件再看报错。

## 8. 开新会话可直接使用的提示

可以直接说明：

`继续处理 docs/plans/2026-03-25-sidecar-services-modularization-next-plan.md，先完成 services/agent/ 第一阶段整理，把 agent-session-manager / agent-workspace-manager / agent-files-service / agent-runtime-status-manager / agent-service 收到 agent/ 目录，并在每一批后跑 sidecar typecheck，最后跑 agent-new-runtime / bridges / provider-switch smoke。`

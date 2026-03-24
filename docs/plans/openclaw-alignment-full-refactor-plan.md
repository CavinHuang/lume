# Lume 全量对齐 OpenClaw 与抗升级重构计划（收尾版）

## 1. 目标与原则

1. 目标：把 Lume 从“`pi-agent-core Agent` 直连 + 自研会话/压缩适配”重构为“OpenClaw 同款主骨架（`pi-coding-agent createAgentSession`）+ Lume 适配层”。
2. 原则：上游能力优先复用；Lume 差异只放在 Adapter/Policy 层；禁止再改 `node_modules`；版本必须精确锁定且有守卫测试。
3. 成功标准：升级 Pi 包时仅改少量适配代码，不再重写核心运行链路。

## 2. 现状问题（必须消除）

1. 主运行链路未走 `createAgentSession/SessionManager/ModelRegistry`，升级风险高。
2. Compaction 依赖 Lume ↔ Pi 消息二次转换，语义和精度易漂移。
3. Bun 兼容依赖运行时 hack 与 postinstall patch，维护脆弱。
4. 缺少 Pi 依赖图守卫（版本漂移、override 污染）。

## 3. 目标架构

1. `runtime-core`（OpenClaw 对齐层）：`run.ts`、`run/attempt.ts`、`model.ts`、`pi-model-discovery.ts`、`pi-tools.ts`、`subscribe.ts`。
2. `runtime-adapters`（Lume 注入层）：渠道/API key、权限审批、workspace、session 工具、automation/memory。
3. `ui-projection`（展示层）：把 Pi 事件映射成 Lume `AgentEvent`，不参与核心调度。
4. 单一事实源：Pi transcript（`SessionManager`）为主，Lume JSONL 仅过渡兼容，最终退出。

## 4. 当前状态

1. `runtime-core` 已成为唯一执行主链。
2. `legacy` 独立执行实现已删除，`dual` 未落地且已放弃。
3. Bun patch / Bun runtime hack 已删除。
4. transcript 已用于 `new` 模式恢复与 JSONL 缺失回填。

## 5. 分阶段详细执行

### Phase 0：基线冻结

1. 冻结当前主干版本，记录 smoke/typecheck/关键性能指标。
2. 建立回滚分支与回滚脚本。
3. 输出基线报告（错误率、平均时延、工具调用成功率、会话恢复成功率）。

### Phase 1：依赖守卫

1. 新增 Pi 版本守卫测试，要求 `pi-agent-core/pi-ai/pi-coding-agent` 同版本精确 pin。
2. 禁止 package manager override Pi 包。
3. CI 增加阻断门禁。

### Phase 2：新骨架落地（已完成）

1. 新建 `runtime-core` 目录与模块骨架。
2. 已引入最小 runtime mode 骨架，并最终收缩为单一 `new` 主链。
3. 已完成编译通过、最小 smoke 和重启恢复验证。

### Phase 3：模型与鉴权链路对齐（已完成）

1. 实现 `discoverAuthStorage` 与 `discoverModels`。
2. 实现 `resolveModelAsync`（provider/model/baseUrl/模型候选解析）。
3. `runner/run.ts` 已只接入新模型解析主链。

### Phase 4：会话与持久化对齐（进行中）

1. `run/attempt.ts` 切换为 `createAgentSession(...)` 主链。
2. `SessionManager` 接管 transcript 读写。
3. 历史迁移工具已不再需要。
4. 当前为 transcript-first 恢复，JSONL 仍保留为兼容投影。

### Phase 5：工具链与权限链对齐

1. 基于 `codingTools` 重建 `pi-tools` 组装器。
2. 将 Lume policy/permission gate 变为中间件并统一挂载。
3. 实现 ToolDefinition 适配层，统一 execute 参数和返回规范。

### Phase 6：流式传输对齐

1. 实现统一 stream wrapper 链：sanitize/repair/provider quirks。
2. 逐 provider smoke（OpenAI/Anthropic/Google/ZAI 等）。
3. 移除 Bun patch 与 postinstall 修改路径。

### Phase 7：事件语义对齐

1. 将 subscribe 处理分层为 message/tool/lifecycle。
2. 修复 usage 语义口径，避免把 `totalTokens` 当 `inputTokens`。
3. 对齐文本回填、去重和终止事件语义。

### Phase 8：Compaction 对齐

1. 删除当前 Lume ↔ Pi 手工拼装压缩路径。
2. 切换为 transcript 原生 compaction。
3. 保证压缩摘要、保留窗口、后续续写语义一致。

### Phase 9：切流与清理（进行中）

1. 已默认切到 `new`。
2. 已删除 legacy 路径与临时 Bun 适配代码。
3. 剩余工作聚焦于 transcript-first 存储和 compaction。

## 6. 工单总表（20 张）

| ID | 工单 | 改动文件 | 预估 | 依赖 | 验收命令 | 回滚点 |
|---|---|---|---:|---|---|---|
| ARC-001 | 增加运行模式开关并最终收缩为单一 `new` | `apps/sidecar/src/services/pi-agent/run-pi-agent-message.ts`, `apps/sidecar/src/services/pi-agent/runner/run.ts` | 0.5d | 无 | `bun run --filter @lume/sidecar typecheck` | 无 |
| ARC-002 | Pi 版本守卫测试（对齐 + 禁止 override） | `apps/sidecar/src/services/pi-agent/pi-package-graph.test.ts`, `apps/sidecar/package.json` | 0.5d | 无 | `bun test apps/sidecar/src/services/pi-agent/pi-package-graph.test.ts` | 删除该测试 |
| ARC-003 | 上游接口契约测试（`createAgentSession/SessionManager`） | `apps/sidecar/src/services/pi-agent/pi-upstream-compat.test.ts` | 1d | ARC-002 | `bun test .../pi-upstream-compat.test.ts` | 关闭契约检查 |
| CORE-001 | 新建 `runtime-core` 目录与模块骨架 | `apps/sidecar/src/services/pi-agent/runtime-core/*` | 1d | ARC-001 | `bun run --filter @lume/sidecar typecheck` | 不接入调用 |
| CORE-002 | 实现 `discoverAuthStorage/discoverModels` | `.../runtime-core/pi-model-discovery.ts` | 1d | CORE-001 | 单测 + typecheck | 回退到当前 `decryptApiKey + getModel` |
| CORE-003 | 实现 `resolveModelAsync` | `.../runtime-core/model.ts`, `.../runner/provider-resolution.ts` | 1.5d | CORE-002 | 解析单测 | 走旧解析 |
| CORE-004 | `run.ts` 接入新模型解析主链 | `apps/sidecar/src/services/pi-agent/runner/run.ts` | 0.5d | CORE-003 | typecheck | 无 |
| CORE-005 | `attempt.ts` 改为 `createAgentSession` 主链 | `apps/sidecar/src/services/pi-agent/runtime-core/attempt.ts` | 2d | CORE-004 | `bun run --filter @lume/sidecar smoke:agent-new-runtime` | 无 |
| TOOL-001 | 基于 `codingTools` 重建工具组装器 | `.../runtime-core/pi-tools.ts`, `.../tools/create-core-coding-tools.ts` | 1.5d | CORE-005 | 工具单测 | 保留旧注入 |
| TOOL-002 | ToolDefinition 适配层 | `.../runtime-core/pi-tool-definition-adapter.ts` | 1d | TOOL-001 | 适配层单测 | 不启用 adapter |
| TOOL-003 | 权限闸门中间件化 | `.../tools/tool-permission-gate.ts`, `.../runtime-core/pi-tools.ts` | 1d | TOOL-001 | 权限单测 | 回退旧 wrapper |
| TOOL-004 | policy 链并入新工具管线 | `.../tools/tool-policy.ts`, `.../runtime-core/pi-tools.ts` | 1d | TOOL-003 | policy 单测 | 回退旧应用位置 |
| STREAM-001 | 统一 stream wrapper 链 | `.../runtime-core/stream-wrappers.ts`, `.../runtime-core/attempt.ts` | 2d | CORE-005 | wrapper 单测 | 关闭 wrappers |
| STREAM-002 | 移除 Bun patch 依赖 | `package.json`, `run-pi-agent-message.ts` | 1d | STREAM-001 | 全 smoke + typecheck | 无 |
| EVT-001 | 订阅处理对齐 | `.../runtime-core/subscribe.ts`, `.../subscribe/map-pi-session-event.ts` | 1.5d | CORE-005 | 事件单测 | 回旧订阅 |
| EVT-002 | 修正 usage 语义映射 | `.../subscribe/map-pi-session-event.ts`, `packages/shared/src/types/agent.ts` | 0.5d | EVT-001 | usage 单测 | 兼容旧字段 |
| DATA-001 | transcript 主存储 + JSONL 双写过渡 | `apps/sidecar/src/services/agent-session-manager.ts`, `.../runtime-core/session-store.ts` | 2d | CORE-005 | 重启恢复 smoke | 仅保留 JSONL |
| DATA-002 | 历史数据迁移脚本 | 已取消 | 0d | 无 | 无 | 无 |
| CMP-001 | compaction 切原生 transcript 流程 | `.../compaction/compaction-service.ts`, `.../runtime-core/compaction.ts`, `.../compaction/compaction-store.ts` | 2d | DATA-001, EVT-001 | 长会话 smoke | 回退旧 compaction |
| REL-001 | 双跑比较器 + 灰度门控 + 自动回退 | 已取消 | 0d | 无 | 无 | 无 |

## 7. 验收门禁（每周）

1. W1：`typecheck` + ARC/CORE 单测全绿。
2. W2：`smoke:agent-new-runtime`、`smoke:agent-new-runtime:error` 全绿。
3. W3：工具权限回归（plan/default/acceptEdits/bypassPermissions）全绿。
4. W4：长会话 compaction + 重启恢复 + subagent E2E 全绿。
5. `new` 模式多轮恢复 smoke 通过。
6. legacy 独立执行链已删除。

## 8. 灰度与回滚策略

1. 当前无外发用户，已不做灰度。
2. 当前回滚手段仅保留 git 层面回退。
3. 已不再维护 legacy/dual 运行时分支。

## 9. 风险清单与应对

1. 上游接口漂移：用 `pi-upstream-compat.test.ts` 提前失败。
2. transcript/JSONL 双源漂移：通过 transcript-first 回填逐步收敛。
3. compaction / usage 语义仍未完全对齐：继续单独收口。
4. 子任务与复杂工具链仍需继续挂载到新主链。

## 10. 本周开工顺序（建议）

1. DATA-001
2. EVT-002
3. CMP-001
4. subagent / permission 复杂链路并回
5. 删除剩余 JSONL-first 读路径

---

最后更新：2026-03-24

# Lume 全量对齐 OpenClaw 与抗升级重构计划（执行版）

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

## 4. 分阶段里程碑（6 周）

1. W1：守卫与新骨架（不切流）。
2. W2：模型/鉴权/会话主链切换到 `pi-coding-agent`。
3. W3：工具链与权限链切换。
4. W4：事件语义与 compaction 切换。
5. W5：`dual` 双跑灰度与偏差修复。
6. W6：`new` 全量切流、下线 legacy。

## 5. 分阶段详细执行

### Phase 0：基线冻结

1. 冻结当前主干版本，记录 smoke/typecheck/关键性能指标。
2. 建立回滚分支与回滚脚本。
3. 输出基线报告（错误率、平均时延、工具调用成功率、会话恢复成功率）。

### Phase 1：依赖守卫

1. 新增 Pi 版本守卫测试，要求 `pi-agent-core/pi-ai/pi-coding-agent` 同版本精确 pin。
2. 禁止 package manager override Pi 包。
3. CI 增加阻断门禁。

### Phase 2：新骨架落地（并行）

1. 新建 `runtime-core` 目录与模块骨架。
2. 引入运行模式开关：`LUME_PI_RUNTIME_MODE=legacy|dual|new`。
3. 先不切流，仅完成编译通过与空链路可启动。

### Phase 3：模型与鉴权链路对齐

1. 实现 `discoverAuthStorage` 与 `discoverModels`。
2. 实现 `resolveModelAsync`（provider/model/baseUrl/模型候选解析）。
3. 将 `runner/run.ts` 接入新模型解析，旧逻辑保留在 `legacy`。

### Phase 4：会话与持久化对齐

1. `run/attempt.ts` 切换为 `createAgentSession(...)` 主链。
2. `SessionManager` 接管 transcript 读写。
3. 实现 JSONL -> transcript 迁移工具。
4. 过渡期双写，最终切读 transcript。

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

### Phase 9：切流与清理

1. `legacy -> dual -> new` 灰度推进。
2. 达标后删除 legacy 路径与临时适配代码。
3. 清理 `patch-pi-ai-proxy.js`、Bun 兼容 hack 与废弃测试。

## 6. 工单总表（20 张）

| ID | 工单 | 改动文件 | 预估 | 依赖 | 验收命令 | 回滚点 |
|---|---|---|---:|---|---|---|
| ARC-001 | 增加运行模式开关 `LUME_PI_RUNTIME_MODE=legacy/dual/new` | `apps/sidecar/src/services/pi-agent/run-pi-agent-message.ts`, `apps/sidecar/src/services/pi-agent/runner/run.ts` | 0.5d | 无 | `bun run --filter @lume/sidecar typecheck` | 默认强制 `legacy` |
| ARC-002 | Pi 版本守卫测试（对齐 + 禁止 override） | `apps/sidecar/src/services/pi-agent/pi-package-graph.test.ts`, `apps/sidecar/package.json` | 0.5d | 无 | `bun test apps/sidecar/src/services/pi-agent/pi-package-graph.test.ts` | 删除该测试 |
| ARC-003 | 上游接口契约测试（`createAgentSession/SessionManager`） | `apps/sidecar/src/services/pi-agent/pi-upstream-compat.test.ts` | 1d | ARC-002 | `bun test .../pi-upstream-compat.test.ts` | 关闭契约检查 |
| CORE-001 | 新建 `runtime-core` 目录与模块骨架 | `apps/sidecar/src/services/pi-agent/runtime-core/*` | 1d | ARC-001 | `bun run --filter @lume/sidecar typecheck` | 不接入调用 |
| CORE-002 | 实现 `discoverAuthStorage/discoverModels` | `.../runtime-core/pi-model-discovery.ts` | 1d | CORE-001 | 单测 + typecheck | 回退到当前 `decryptApiKey + getModel` |
| CORE-003 | 实现 `resolveModelAsync` | `.../runtime-core/model.ts`, `.../runner/provider-resolution.ts` | 1.5d | CORE-002 | 解析单测 | 走旧解析 |
| CORE-004 | `run.ts` 接入新模型解析主链 | `apps/sidecar/src/services/pi-agent/runner/run.ts` | 0.5d | CORE-003 | typecheck | feature flag 回 `legacy` |
| CORE-005 | `attempt.ts` 改为 `createAgentSession` 主链 | `apps/sidecar/src/services/pi-agent/runner/attempt.ts` | 2d | CORE-004 | `bun run --filter @lume/sidecar smoke:agent-success-restore` | 回退旧分支 |
| TOOL-001 | 基于 `codingTools` 重建工具组装器 | `.../runtime-core/pi-tools.ts`, `.../tools/create-core-coding-tools.ts` | 1.5d | CORE-005 | 工具单测 | 保留旧注入 |
| TOOL-002 | ToolDefinition 适配层 | `.../runtime-core/pi-tool-definition-adapter.ts` | 1d | TOOL-001 | 适配层单测 | 不启用 adapter |
| TOOL-003 | 权限闸门中间件化 | `.../tools/tool-permission-gate.ts`, `.../runtime-core/pi-tools.ts` | 1d | TOOL-001 | 权限单测 | 回退旧 wrapper |
| TOOL-004 | policy 链并入新工具管线 | `.../tools/tool-policy.ts`, `.../runtime-core/pi-tools.ts` | 1d | TOOL-003 | policy 单测 | 回退旧应用位置 |
| STREAM-001 | 统一 stream wrapper 链 | `.../runtime-core/stream-wrappers.ts`, `.../runner/attempt.ts` | 2d | CORE-005 | wrapper 单测 | 关闭 wrappers |
| STREAM-002 | 移除 Bun patch 依赖 | `package.json`, `scripts/patch-pi-ai-proxy.js`, `run-pi-agent-message.ts` | 1d | STREAM-001 | 全 smoke + typecheck | 恢复 patch |
| EVT-001 | 订阅处理对齐 | `.../runtime-core/subscribe.ts`, `.../subscribe/handlers.ts` | 1.5d | CORE-005 | 事件单测 | 回旧订阅 |
| EVT-002 | 修正 usage 语义映射 | `.../subscribe/map-pi-session-event.ts`, `packages/shared/src/types/agent.ts` | 0.5d | EVT-001 | usage 单测 | 兼容旧字段 |
| DATA-001 | transcript 主存储 + JSONL 双写过渡 | `apps/sidecar/src/services/agent-session-manager.ts`, `.../runtime-core/session-store.ts` | 2d | CORE-005 | 重启恢复 smoke | 仅保留 JSONL |
| DATA-002 | 历史数据迁移脚本 | `apps/sidecar/scripts/migrate-agent-jsonl-to-transcript.ts` | 1.5d | DATA-001 | dry-run + 抽样校验 | 不执行迁移 |
| CMP-001 | compaction 切原生 transcript 流程 | `.../compaction/compaction-service.ts`, `.../runtime-core/compaction.ts`, `.../compaction/compaction-store.ts` | 2d | DATA-001, EVT-001 | 长会话 smoke | 回退旧 compaction |
| REL-001 | 双跑比较器 + 灰度门控 + 自动回退 | `.../runtime-core/dual-run-comparator.ts`, `.../runner/run.ts` | 2d | 核心完成 | dual 报告 + 灰度 | 强制 `legacy` |

## 7. 验收门禁（每周）

1. W1：`typecheck` + ARC/CORE 单测全绿。
2. W2：`smoke:agent-success-restore`、`smoke:agent-stream` 全绿。
3. W3：工具权限回归（plan/default/acceptEdits/bypassPermissions）全绿。
4. W4：长会话 compaction + 重启恢复 + subagent E2E 全绿。
5. W5：dual 偏差达标：文本偏差 <10%，tool 次数偏差 <=1，stopReason 一致。
6. W6：new 全量 7-14 天无 P1/P2，再删 legacy。

## 8. 灰度与回滚策略

1. 灰度顺序：internal -> 5% -> 20% -> 50% -> 100%。
2. 自动回滚条件：
   - 错误率较基线上升 > 30%
   - stopReason 不一致率 > 5%
   - 工具调用失败率上升 > 20%
3. 回滚动作：
   - 立即将 `LUME_PI_RUNTIME_MODE` 切回 `legacy`
   - 保留双跑日志用于定位

## 9. 风险清单与应对

1. 上游接口漂移：用 `pi-upstream-compat.test.ts` 提前失败。
2. 数据迁移错配：先双写一周，再切读；迁移脚本支持 dry-run。
3. 工具副作用重复执行：dual 阶段新链路默认只读模式。
4. usage 指标抖动：统一字段定义，保留兼容映射过渡。

## 10. 本周开工顺序（建议）

1. ARC-001
2. ARC-002
3. CORE-001
4. CORE-002
5. CORE-003

完成后进入 CORE-004/CORE-005。

---

最后更新：2026-03-23

# Lume Pi Runtime 回切上游主骨架 ADR

## 状态

已接受

## 日期

2026-03-24

## 背景

当前 Lume Pi runtime 主链路建立在 `@mariozechner/pi-agent-core Agent` 直连模式上：

- sidecar 自己负责模型发现、鉴权解析、工具装配、事件投影、会话续接。
- 会话持久化以 Lume JSONL 为主，Pi `transcript/SessionManager` 未成为主事实源。
- compaction 复用了 `@mariozechner/pi-coding-agent` 的纯函数，但输入仍来自 Lume 自研消息结构转换。
- Bun 兼容仍依赖运行时 hack 与 `postinstall` patch。

这条链路可以工作，但上游升级面过宽，Lume 自己承担了过多本应由上游 runtime 承担的运行时责任。

## 既有决策

`docs/plans/14-pi-agent-migration-plan.md` 曾将“方案 B：`pi-agent-core Agent` 直连”作为迁移阶段收敛结果。

该决策在“先完成可运行迁移”阶段是合理的，但不再适合作为长期架构终态。

## 新决策

Lume 将从当前 `pi-agent-core Agent` 直连主链，回切到更接近 OpenClaw 的上游主骨架：

- 优先复用 `@mariozechner/pi-coding-agent` 的 `createAgentSession/SessionManager` 主链。
- Lume 的差异化能力收敛到 adapter/policy/projection 层。
- sidecar 对 UI 继续暴露现有 `AgentEvent` / IPC 合同，避免同时重写 web 层。
- 在当前阶段不考虑历史用户数据迁移；允许内部一次性切换主存储与主运行链。

## 不变边界

以下边界在本轮重构中保持不变：

1. `Tauri desktop + Next.js web + Bun sidecar + shared packages` 总体架构不变。
2. web 端不直接接触原生 API。
3. `packages/shared` 中的共享合同仍是跨层唯一事实源。
4. UI 继续消费 sidecar 投影后的 `AgentEvent`，而不是直接消费 Pi transcript。

## 要解决的问题

1. 缩小 Pi 上游升级时 Lume 需要维护的运行时代码面积。
2. 删除 Bun 兼容 hack 和 `node_modules` patch 依赖。
3. 停止在 compaction/会话恢复路径上维护 Lume -> Pi 的手工语义转换。
4. 让上游契约、守卫测试与单一主链边界显式存在。

## 实施原则

1. 先建立最小 runtime 开关与上游契约测试，再推进主链替换。
2. 先做最小 PoC：单会话、基础文本流、只读工具、恢复链路。
3. 在没有真实用户与历史数据包袱的前提下，不为 JSONL 保留长期兼容债务。
4. 旧链路只作为短期过渡存在，验证完成后删除。

## 直接影响

1. `apps/sidecar/src/services/pi-agent` 已切换到 runtime-core 主骨架。
2. `agent-session-manager` 后续将从 JSONL 主存储转为 transcript 主存储或 transcript-first 投影。
3. 现有 `tool-policy`、`tool-permission-gate`、memory/subagent 等能力需要重新挂载到新 runtime 主链。

## 暂不处理

1. 不在本 ADR 中决定 transcript 文件格式的最终对外暴露形态。
2. 不在本 ADR 中一次性重写 web 展示层。
3. 不在本 ADR 中引入新的产品能力。

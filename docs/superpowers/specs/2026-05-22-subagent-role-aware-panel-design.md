# Subagent 角色感知执行卡片设计

> 日期: 2026-05-22
> 状态: 已确认，进入实现
> 范围: 主 Agent 消息流中的 subagent inline panel 展示增强

## 背景

Lume 已经完成内置 Agent 角色 registry、Settings 管理页和输入区推荐。用户可以在输入区选择 `designer`、`analyst` 等角色，但执行过程里的 subagent 卡片仍主要显示运行时 id，缺少角色身份感。

本轮选择方案 A：角色感知执行卡片。目标是让执行中的子 Agent 看起来像团队成员，而不是匿名工具调用。

## 目标

- `SubagentInlinePanel` 能识别内置角色 id。
- 已知角色显示中文名与职能，例如 `林澄 · 设计工程师`。
- 同时保留 runtime id，例如 `designer`，方便调试。
- 显示轻量角色标签：只读/可写、后台/前台、默认 skill。
- 未知或自定义 agent 保持现有显示，不破坏兼容性。

## 非目标

- 不修改 sidecar。
- 不修改 subagent run store。
- 不新增 RPC、desktop API 或桥接协议。
- 不改变 subagent 执行行为。
- 不引入头像图片，先做低风险文本/标签增强。

## 设计

新增 `apps/web/src/components/agent/subagent-role-display.ts`，作为本地纯函数：

- 输入 `agentType`、`requestedAgentId`、`resolvedAgentId`、`label`
- 优先按 `resolvedAgentId` 查找角色，其次 `requestedAgentId`，最后 `agentType`
- 若命中内置角色，返回：
  - `primaryLabel`: `displayName · title`
  - `runtimeId`: role id
  - `badges`: `只读/可写`、`后台/前台`、default skill
- 若未命中，返回原有 label 和 runtime id

`SubagentInlinePanel` 继续直接消费 `agentSubagentRunsAtom`，不新增包装组件。UI 只在现有 header 和 expanded detail 区域显示角色信息。

## 验证

需要覆盖：

- 已知 role id 能显示中文名、职能、runtime id 和标签。
- `resolvedAgentId` 优先于 `requestedAgentId`。
- 未知 agent 保持 fallback label。
- `SubagentInlinePanel` 类型检查通过。

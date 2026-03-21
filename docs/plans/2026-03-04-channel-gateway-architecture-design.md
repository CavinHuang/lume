# Lume Channel Gateway 架构设计（MVP -> 可扩展）

> 日期：2026-03-04  
> 目标：在不推翻现有 `Tauri + Next.js + sidecar + shared` 架构前提下，支持未来接入 Telegram/Discord/WhatsApp 等外部消息渠道。

---

## 1. 设计结论

1. 不重构现有主干，只在 `apps/sidecar` 增加 `channel-gateway` 层。  
2. 外部渠道统一走事件模型：`inbound event -> session router -> agent runtime -> outbound event`。  
3. `apps/web` 继续只做 UI，不直接对接外部渠道 SDK/Webhook。  
4. `packages/shared` 新增 channel-gateway contracts，保证跨层协议稳定。  

---

## 2. 边界与原则

1. 保持现有模块边界：  
- `apps/desktop`：壳层与桥接，不放网关逻辑。  
- `apps/web`：配置与观测 UI，不直接处理外部消息。  
- `apps/sidecar`：渠道接入、路由、编排、执行。  
- `packages/shared`：统一协议与 schema。  

2. 先做单租户本地模式，再扩展多租户/团队。  
3. 所有渠道都必须支持幂等去重与失败重试。  
4. 凭证只存 sidecar，日志默认脱敏。  

---

## 3. 目标能力

## MVP（Phase 1）

1. 接入 1 个渠道（建议 Telegram Bot）。  
2. 支持文本消息 ingress/egress。  
3. 渠道用户与 Lume Agent session 绑定。  
4. 收到消息后自动触发 Agent，并回发结果。  
5. 失败可重试，消息不重复处理。  

## Phase 2

1. 多渠道（Discord/Slack/WhatsApp）。  
2. 附件/图片消息。  
3. 线程/群组上下文路由策略。  
4. 回执状态（sent/delivered/failed）可观测。  

---

## 4. 目标架构

## 4.1 Sidecar 模块

新增目录（建议）：

```text
apps/sidecar/src/services/channel-gateway/
  gateway-service.ts
  ingress-service.ts
  egress-service.ts
  router-service.ts
  binding-manager.ts
  dedup-manager.ts
  retry-queue-manager.ts
  adapters/
    telegram-adapter.ts
    discord-adapter.ts
  types.ts
```

职责划分：

1. `ingress-service`：接收外部消息（webhook/polling）。  
2. `dedup-manager`：按 `provider + externalMessageId` 去重。  
3. `router-service`：将外部用户/会话映射到 Lume `workspaceId + sessionId`。  
4. `gateway-service`：统一编排 `ingress -> agent -> egress`。  
5. `egress-service`：发送回复并记录回执状态。  
6. `retry-queue-manager`：处理 egress 失败重试与死信。  

## 4.2 Shared Contracts

建议新增：

`packages/shared/src/types/channel-gateway.ts`

核心对象：

1. `ChannelProvider = "telegram" | "discord" | "whatsapp" | "slack"`  
2. `ChannelInboundEvent`  
3. `ChannelOutboundMessage`  
4. `ChannelSessionBinding`（external user/chat -> workspace/session）  
5. `ChannelDeliveryRecord`（发送状态）  
6. `ChannelGatewayIPCChannels`（配置/绑定/重试管理）  

---

## 5. 核心时序

## 5.1 Inbound -> Agent -> Outbound

1. Adapter 收到渠道消息并转为 `ChannelInboundEvent`。  
2. `dedup-manager` 校验是否已处理。  
3. `router-service` 查找或创建 `ChannelSessionBinding`。  
4. `gateway-service` 调用现有 `sendAgentMessage`（sidecar 内部）。  
5. 收集 assistant 最终输出，转为 `ChannelOutboundMessage`。  
6. `egress-service` 发送到渠道并记录 `ChannelDeliveryRecord`。  

## 5.2 失败处理

1. 若 Agent 执行失败：回发统一错误模板（可配置）。  
2. 若渠道发送失败：入重试队列（指数退避）。  
3. 超过阈值：进入 dead-letter，等待人工处理。  

---

## 6. 存储设计（MVP）

基于当前文件存储：

1. `~/.lume/channel-gateway/bindings.json`  
2. `~/.lume/channel-gateway/dedup.jsonl`  
3. `~/.lume/channel-gateway/delivery.jsonl`  
4. `~/.lume/channel-gateway/retry-queue.json`  

要求：

1. 原子写或可恢复。  
2. 含 `version` 字段。  
3. 记录最少必要字段，日志脱敏。  

---

## 7. 安全与权限

1. 渠道凭证统一通过 sidecar secret 存储，不落明文日志。  
2. webhook 必须做签名校验（若渠道支持）。  
3. 对外入口做限流和大小限制。  
4. 默认禁止外部消息直接执行高风险工具。  
5. 通过 `messageMetadata` 标记 `source=channel_gateway`，用于 tool policy 差异化控制。  

---

## 8. 与现有 Lume 的改造点

## 8.1 需要新增

1. `channel-gateway` 服务层与 adapter 层。  
2. shared contracts 与 IPC。  
3. 设置页新增渠道配置与绑定管理 UI。  

## 8.2 可复用

1. 现有 `agent-session-manager`、`sendAgentMessage`、`channel-manager`。  
2. 现有工具策略系统（`tool-policy` / `permission-gate`）。  
3. 现有日志与会话持久化。  

---

## 9. 分阶段实施计划

## Phase A（1-2 周）：骨架

1. 新增 shared channel-gateway types。  
2. sidecar 新增 `binding-manager`、`dedup-manager`、`gateway-service` 空实现。  
3. 打通内部模拟入口（不接外部渠道）。  

验收：可用本地模拟 inbound 触发 agent 并产生 outbound 记录。

## Phase B（1-2 周）：Telegram MVP

1. 实现 `telegram-adapter`（polling 或 webhook 二选一）。  
2. 打通真实 ingress/egress。  
3. 增加重试与死信。  

验收：真实 Telegram 对话可收发并关联到 Lume session。

## Phase C（2 周）：产品化与治理

1. 设置页：渠道配置、绑定、重试队列、死信观测。  
2. 指标：成功率、重试率、平均回复延迟。  
3. 安全加固：签名校验、限流、脱敏审计。  

---

## 10. 第一批可直接开工任务

1. 新建 `packages/shared/src/types/channel-gateway.ts`。  
2. 新建 `apps/sidecar/src/services/channel-gateway/binding-manager.ts`。  
3. 新建 `apps/sidecar/src/services/channel-gateway/dedup-manager.ts`。  
4. 新建 `apps/sidecar/src/services/channel-gateway/gateway-service.ts` 并接 `sendAgentMessage`。  
5. 新增 sidecar RPC：模拟 `channel-gateway:ingress`。  
6. 补 3 条测试：去重、绑定路由、失败重试入队。  

---

## 11. 风险与决策

1. 风险：渠道回调抖动导致重复执行。  
决策：`dedup` 作为硬前置，未通过不进 agent。

2. 风险：渠道发信失败导致用户无感知。  
决策：`delivery record + retry queue + dead-letter` 三段式。

3. 风险：外部消息触发高危工具。  
决策：`source=channel_gateway` 下应用更严格 tool policy。


# Lume 对齐 Proma：Agent 消息列表加载与渲染能力

日期：2026-03-22
范围：仅覆盖 Agent 消息列表相关能力（分页、虚拟滚动、渲染优化）

## 1. 对齐目标

将 Lume 在 Agent 消息列表这一段能力与 Proma 当前行为对齐，优先保证“行为一致、风险可控、可回滚”。

对齐基线（Proma 当前行为）：
- 不做分页加载（一次读取会话全部消息）
- 不做虚拟滚动（消息全量 `map` 渲染）
- 有轻量渲染优化（`content-visibility` + `contain-intrinsic-size`）

## 2. Proma 现状（基线）

### 2.1 数据加载链路
- 全量读取消息：`getAgentSessionMessages(id)` 读取整个 JSONL
  - `apps/electron/src/main/lib/agent-session-manager.ts:129`
- IPC `GET_MESSAGES` 直接返回全量消息
  - `apps/electron/src/main/ipc.ts:620`
- preload 接口仅暴露全量读取签名
  - `apps/electron/src/preload/index.ts:277`
- 前端会话切换/刷新使用全量接口
  - `apps/electron/src/renderer/components/agent/AgentView.tsx:191`

### 2.2 渲染链路
- 消息列表全量 `messages.map(...)`
  - `apps/electron/src/renderer/components/agent/AgentMessages.tsx:630`
- 每条消息包裹 `data-message-id`
  - `apps/electron/src/renderer/components/agent/AgentMessages.tsx:631`
- 启用轻量渲染优化：
  - `.cv-ready [data-message-id] { content-visibility: auto; contain-intrinsic-size: auto 200px; }`
  - `apps/electron/src/renderer/styles/globals.css:132`

结论：Proma 无分页、无虚拟滚动，但有 CSS 级别的屏幕外渲染优化。

## 3. Lume 现状

### 3.1 数据加载链路
- 已实现“最近 N 条”接口：`getRecentAgentMessages(id, limit)`，返回 `{ messages, total, hasMore }`
  - `apps/sidecar/src/services/agent-session-manager.ts:140`
- IPC 已开放 `GET_RECENT_MESSAGES`
  - `apps/sidecar/src/index.ts:1074`
- 输入 schema 支持 `limit`（1~2000）
  - `apps/sidecar/src/index.ts:450`
- Web API 同时有全量和 recent 两套：
  - 全量：`apps/web/lib/desktop-api.ts:649`
  - recent：`apps/web/lib/desktop-api.ts:653`
- AgentView 目前固定拉 recent 200（多处）
  - `apps/web/components/agent/AgentView.tsx:639`
  - `apps/web/components/agent/AgentView.tsx:841`
  - `apps/web/components/agent/AgentView.tsx:903`
  - `apps/web/components/agent/AgentView.tsx:1409`
- 调用处只取 `messages`，未消费 `total/hasMore`
  - `apps/web/components/agent/AgentView.tsx:640`

### 3.2 渲染链路
- 消息列表也是全量 `messages.map(...)`
  - `apps/web/components/agent/AgentMessages.tsx:410`
- 无 `data-message-id` 容器与 `cv-ready` 机制
  - `apps/web/components/agent/AgentMessages.tsx:398`
- 无 `content-visibility` 相关全局样式
  - `apps/web/globals.css`（当前无对应规则）
- 对话容器为普通滚动容器，不是虚拟列表
  - `apps/web/components/ai-elements/conversation.tsx:27`

结论：Lume 当前是“尾部限量拉取 + 非虚拟全量渲染”，且缺少 Proma 的 CSS 级渲染优化。

## 4. 差异清单（Lume vs Proma）

1. 历史覆盖范围
- Proma：全量消息
- Lume：默认 recent 200（会话很长时，前面消息在当前视图不可见）

2. 分页能力与产品形态
- Proma：无分页能力（接口与 UI 都没有）
- Lume：后端有 recent 能力，但前端没有“加载更早消息”入口；属于“半分页”状态

3. 虚拟滚动
- 两边都没有

4. 轻量渲染优化
- Proma：有 `content-visibility`
- Lume：无对应优化

## 5. 对齐方案与取舍

## 方案 A：严格对齐 Proma（推荐）

目标：行为与 Proma 一致，减少“只看到最近 200 条”造成的认知偏差。

实施项：
1. AgentView 改为全量读取
- 将 4 处 `getRecentAgentSessionMessages(sessionId, 200)` 改为 `getAgentSessionMessages(sessionId)`
- 位置：
  - `apps/web/components/agent/AgentView.tsx:639`
  - `apps/web/components/agent/AgentView.tsx:841`
  - `apps/web/components/agent/AgentView.tsx:903`
  - `apps/web/components/agent/AgentView.tsx:1409`

2. 保留 recent API 但暂不用于 Agent 主路径
- 降低改动面，保留以后做真正“向前翻页”时复用
- 位置：
  - `apps/web/lib/desktop-api.ts:653`
  - `apps/sidecar/src/index.ts:1074`
  - `apps/sidecar/src/services/agent-session-manager.ts:140`

3. 引入 Proma 同款轻量渲染优化
- 在 AgentMessages 渲染项外包 `data-message-id`
- 引入 `cv-ready` 逻辑并在非 streaming 时启用
- 在 `apps/web/globals.css` 增加：
  - `.cv-ready [data-message-id] { content-visibility: auto; contain-intrinsic-size: auto 200px; }`

取舍：
- 优点：与 Proma 体验一致，减少历史消息缺失问题；实现成本低
- 缺点：超长会话下单次拉取与内存压力会增加

## 方案 B：保持 recent 200，但补“加载更早消息”UI（不严格对齐）

目标：保留 Lume 当前性能策略，补齐可用性缺口。

实施项：
- 使用 `total/hasMore` 展示“加载更早消息”按钮
- 增加 offset/cursor API（当前 recent 仅支持尾部切片）
- 渲染层采用 prepend + 锚点保持

取舍：
- 优点：大会话性能更稳
- 缺点：实现复杂，且与 Proma 当前行为不一致

## 方案 C：直接上虚拟滚动（超出 Proma 基线）

目标：在超大消息量场景最优性能。

取舍：
- 优点：长期性能上限最好
- 缺点：复杂度最高，消息高度不稳定（时间线、代码块、工具事件）会带来滚动锚点与测量问题；不属于“对齐 Proma 当前能力”

## 6. 推荐决策

推荐先执行方案 A（严格对齐 Proma），再根据真实会话体量决定是否演进到方案 B/C。

原因：
- 你当前目标是“Lume 对齐 Proma 这部分能力”，方案 A 最直接
- 改动可控且可快速验证
- 若后续要做更强分页/虚拟滚动，可在 A 稳定后增量推进

## 7. 验收标准

1. 功能一致性
- 长会话（>200 条）切换会话后仍可看到完整历史
- stream complete/error 后刷新消息不再截断到 200 条

2. 渲染行为
- 非 streaming 场景启用 `cv-ready` 后，长列表滚动更平滑
- 无明显闪烁/跳动回归

3. 回归项
- 删除消息、编辑重发、保存任务等消息级操作不受影响
- `isCompacting`、tool timeline、streaming 气泡不受影响

## 8. 回滚策略

- 若全量读取导致性能明显退化：
  1. 回退 AgentView 四处调用到 `getRecentAgentSessionMessages(..., 200)`
  2. 暂时保留 `cv-ready` 优化
  3. 进入方案 B（显式“加载更早消息”）

## 9. 变更范围预估（方案 A）

- `apps/web/components/agent/AgentView.tsx`（调用链切换）
- `apps/web/components/agent/AgentMessages.tsx`（`cv-ready` / `data-message-id`）
- `apps/web/globals.css`（渲染优化样式）
- 可选：文档注释更新（标记 recent API 当前未用于 Agent 主路径）

---

如果你确认按方案 A 执行，我可以直接给出一版最小改动 PR 清单（含逐文件改动点和验证步骤）。

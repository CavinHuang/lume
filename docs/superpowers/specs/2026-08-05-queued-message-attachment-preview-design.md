# 队列项附件行内预览 — 设计（Codex 对齐 follow-up）

> 日期：2026-08-05
> 起点：`worktree-input-queue-ui-parity`（PR7 + 输入队列 UI 对齐）
> 目标：队列行附件预览对齐 Codex（`[size-6 缩略图]` + 多类型计数文本）
> 关联：`docs/superpowers/specs/2026-08-04-input-queue-ui-codex-parity-design.md` §8 follow-up

## 0. TL;DR

`summarizeQueuedMessage` 改多类型联合计数（对齐 Codex `J` 函数）；队列行加 `size-6` 首图缩略图（对齐 Codex `imagePreviewSrc`）。`previewUrl` 是 renderer 瞬态（objectURL），用 **renderer 本地 map** 维护（不进 sidecar 持久化，不被 snapshot 推送覆盖）。

## 1. 现状

- `AgentQueuedMessage` 附件：`messageAttachments`（文件，图片含 `isImageAttachment`）/ `commentAttachments`（代码评论 `path:Lline`+body）/ `browserAttachments`（浏览器注释，含 `screenshot.ref`）
- `summarizeQueuedMessage` 只取**第一个**非空类型文本降级，丢弃其他类型 + filename/缩略
- `AgentMessageAttachmentInput` **无 `previewUrl`**（提交时从 `PendingMessageAttachment.previewUrl` 转换丢弃）
- sidecar snapshot 推送（`MESSAGE_QUEUE_CHANGED`）会把 `messageAttachments` 回传，覆盖 renderer

## 2. 设计

### 2.1 `summarizeQueuedMessage` 多类型联合（对齐 Codex `J` 函数）
- `text` 非空 → `text`
- `text` 空 → 多类型联合（仅 >0 项，` · ` 连接）：`{fileCount} 文件 · {commentCount} 评论 · {browserCount} 浏览器注释`
- 全空 → `（空消息）`

### 2.2 首图缩略图：renderer 本地 `previewUrl` map
**核心约束**：`previewUrl` 是 renderer 本地 objectURL，**不进 sidecar**（sidecar schema 仍 strip / 不持久化），不被 snapshot 推送覆盖。

- `apps/web/src/atoms/agent-atoms.ts`（或同域）新增 `queuedAttachmentPreviewUrlAtom: Record<string, string>`（key = messageAttachment.id，value = objectURL）
- 提交时（`AgentInput` `handleSend`，构造 `messageAttachments` 处）：对每个 pending image attachment，`setQueuedAttachmentPreviewUrl` 填 `attachment.id → previewUrl`
- 队列行渲染：`useAtomValue(queuedAttachmentPreviewUrlFamily?)` 或直读 map，取首图附件 id 的 previewUrl
- 队列项删除时：清对应 map entries（避免 objectURL 泄漏）；线程清理时整体 revoke

### 2.3 `QueuedMessageRow` 行内 `size-6` 缩略图
- 取首个 `isImageAttachment` 的 `messageAttachment`，previewUrl 来自 2.2 的 map
- 行布局：`[手柄][⚠][首图 size-6]?文本[重试][引导][删][更多]`
- `<img class="size-6 shrink-0 rounded border border-token-border-heavy object-cover">`（对齐 Codex `composer-attachment-surface`）
- 无 previewUrl / 非图 / 加载失败 → 不渲染缩略

### 2.4 刷新降级 + browserAttachments 截图 defer
- 刷新后 renderer map 丢失 → previewUrl undefined → 不显示缩略（**文本联合仍可用**，因不依赖 previewUrl）
- `browserAttachments` 截图（`screenshot.ref`）需 ref→URL 加载基建，**本期 defer**（文本联合含 `browserCount` 计数）

## 3. 范围

| 文件 | 改动 |
|---|---|
| `apps/web/src/components/agent/agent-message-queue-summary.ts` | 多类型联合 |
| `apps/web/src/atoms/agent-atoms.ts` | +`queuedAttachmentPreviewUrlAtom` |
| `apps/web/src/components/agent/AgentInput.tsx` | 提交时填 previewUrl map；队列项删除时清 map |
| `apps/web/src/components/agent/AgentMessageQueueList.tsx` | `QueuedMessageRow` 首图 size-6 缩略 |
| `packages/shared/src/types/agent.ts` | **不改**（previewUrl 不进 AgentMessageAttachmentInput，renderer 瞬态 map） |
| sidecar schema | **不改**（previewUrl 不持久化） |
| 测试 | `agent-message-queue-summary.test.ts` 多类型用例；`AgentMessageQueueList.contract.test.tsx` 首图渲染 |

## 4. 取舍

- **previewUrl 是 renderer 瞬态**：同会话有效，刷新失效 → 刷新后队列项无缩略（文本联合仍可用）。完整持久化缩略需 ref 加载基建（defer）。
- **只 messageAttachments 图片首图**：browserAttachments 截图 defer（ref 加载）。
- **objectURL 生命周期**：删除队列项时 revoke 对应 objectURL（防泄漏）。

## 5. 验收
- 队列项有图片附件时，行内 size-6 缩略图（同会话）
- 无 text 时，多附件类型联合计数
- 删除队列项 → 对应 objectURL revoke（无泄漏）
- 刷新后降级（无缩略，文本联合仍可用）
- `summarizeQueuedMessage` 多类型测试 + 契约测试过

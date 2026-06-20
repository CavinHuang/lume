# `/clear` 斜杠命令接入真实行为 + 二次确认 设计

## 概述

Agent 对话输入框 `/` 斜杠菜单中的 `/clear`（副标题「清空当前对话上下文」）当前为**纯占位、未接入真实行为**：选中后仅把 `/clear` 当 mention 文本插回编辑器，发送时也不拦截，最终作为普通消息发给 agent。

本设计将其改造为：**选中即执行**（不再插入编辑器文本）——选中 `/clear` 弹出二次确认弹窗，确认后清空当前会话的所有消息与运行记录（保留 thread 本身，可在同一窗口继续对话）。顺带把 `/reload-plugins` 一并改为相同的「选中即执行」模式，并保留对「手打命令文本回车」的兜底拦截。

## 交互流程

### 选中即执行（主路径）

```
[命令列表模式] --选中/clear-->  [弹二次确认弹窗]
[弹二次确认弹窗] --确认--> [清空当前会话：先 stop(若运行中) → CLEAR_THREAD → 重置 atom → toast 成功]
[弹二次确认弹窗] --取消/ESC/点击外部--> [关闭弹窗，什么都不做]
[命令列表模式] --选中/reload-plugins--> [直接重载插件 → toast 成功]   ← 非破坏性，无确认
[命令列表模式] --选中其他命令(/compact,/mcp,...) --> [保持现状]
```

关键变化：`/clear`、`/reload-plugins` 选中后**不再调用 tiptap 的 `command({id,label})` 把文本插回编辑器**，而是直接触发各自的真实操作。

### 手打兜底（次要路径）

用户不走菜单、直接键盘输入 `/clear` 或 `/reload-plugins` 文本并回车时，`AgentInput.handleSend` 保留对这两个命令的文本拦截，走与「选中」完全相同的确认/执行流程（不发给 agent）。

## 实现方案：扩展现有 selectItem 分发 + 复用 ConfirmDialog

### 选择理由

- `MentionList.selectItem` 已有「命令分发」的先例（`/mcp` 走 `setPanelMode('mcp-status')` 特殊分支），`/clear`、`/reload-plugins` 沿用同一处分发，改动集中、风格一致。
- 二次确认直接复用项目既有 `ConfirmDialog`（`apps/web/src/components/ui/confirm-dialog.tsx`）与 `confirmState` 常驻弹窗范式（样例：`ArchiveSettings.tsx`、`LeftSidebar.tsx`），不自造命令式 wrapper。
- 后端清空走专用 `CLEAR_THREAD` IPC，语义清晰、可独立测试，不扭曲 `TRUNCATE_THREAD_MESSAGES_FROM` 的语义。

## 组件架构

### 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `packages/shared/src/types/agent.ts` | `AGENT_IPC_CHANNELS` 新增 `CLEAR_THREAD = 'agent:clear-thread'` |
| `apps/sidecar`（thread/agent 服务） | 新增 `CLEAR_THREAD` handler：先 stop（若运行中）→ 删该 thread 全部消息+运行记录 → 保留 thread 本身 → 返回 `{ok:true}` |
| `apps/web/src/components/agent/slash-command-state.ts` | `/clear`、`/reload-plugins` 项加 `executeOnSelect: true` 标记 |
| `apps/web/src/components/agent/MentionList.tsx` | `selectItem`：`executeOnSelect` 命令不调 `command()`，改调 props 新增的 `onCommandExecute(id)` |
| `apps/web/src/components/agent/AgentInput.tsx` | 传 `onCommandExecute` 回调（按 id 分发 clear→确认弹窗、reload-plugins→直接重载）；新增 `doClear`；常驻 `<ConfirmDialog>`；`handleSend` 保留 `/clear`、`/reload-plugins` 文本兜底拦截 |

### 复用但不需要修改

- `apps/web/src/components/ui/confirm-dialog.tsx` — 直接用 `ConfirmDialog`
- `apps/web/src/atoms/agent-atoms.ts` — 复用 `agentRuntimeEventsAtom`、`agentStreamingStatesAtom`、`agentMessageQueueAtom`（重置对应 threadId）
- sonner `toast` — 已在 `App.tsx` 挂载
- 现有 thread stop 能力（`STOP_THREAD`）— clear 前停掉运行中的 thread

## 后端：CLEAR_THREAD

入参：`{ threadId: string }`

行为：
1. 校验 threadId 存在；不存在 → 返回错误
2. thread 若处于运行/流式状态 → 先调用现有 stop 能力停止，避免 runtime 继续向已清空的 thread 写入
3. 删除该 thread 的全部持久化消息与运行记录
4. **保留 thread 本身**（meta 留存，同一会话窗口可继续输入）
5. 空 thread（本就无消息）→ 幂等返回 `{ok:true}`
6. 返回 `{ ok: true }`

实现层注记：优先复用 thread store 现有「删消息」方法；若没有 `clearAllMessages` 之类能力，在 writing-plans 阶段新增（本 spec 不深挖存储细节）。

## 数据流（前端 doClear）

```
onCommandExecute('clear')
  → setConfirmState({ title:'清空当前对话',
                      description:'将删除当前会话「{threadTitle}」的所有消息，此操作不可撤销。',
                      confirmLabel:'清空', destructive:true,
                      onConfirm: doClear })
  → 用户点「清空」
  → doClear:
      sidecarCall(AGENT_IPC_CHANNELS.CLEAR_THREAD, { threadId })
        → 成功:
            重置 agentRuntimeEventsAtom[threadId] = []
            重置 agentStreamingStatesAtom[threadId] 为非运行态
            清空 agentMessageQueueAtom[threadId]
            toast.success('已清空对话')
        → 失败:
            toast.error('清空失败')
```

`/reload-plugins`：`onCommandExecute('reload-plugins')` → 挪用现有 `handleSend` 中的 `sidecarCall(RELOAD_PLUGINS)` + `toast.success('插件已重新加载')`。

## 边界与安全

- **运行中 clear**：`doClear` 内由后端先 stop 再清空（前端不重复 stop，单一职责在后端）。
- **空会话**：clear 幂等无害。
- **弹窗打开期间**：编辑器仍可输入；点取消/ESC/外部 → 什么都不做，不清空。
- **手打命令文本**：`handleSend` 对 `rawText === '/clear'`、`rawText === '/reload-plugins'` 兜底拦截，走同一流程，不发给 agent。
- **旧拦截处理**：`handleSend` 原本只拦截 `/reload-plugins`；改造后该拦截**保留为兜底**，并新增 `/clear` 兜底。两条路径（选中执行、手打兜底）共用同一份 `doClear` / 重载逻辑，避免实现重复。

## 文案

| 位置 | 文案 |
|------|------|
| 弹窗标题 | 清空当前对话 |
| 弹窗描述 | 将删除当前会话「{threadTitle}」的所有消息，此操作不可撤销。 |
| 确认按钮 | 清空（destructive 红色） |
| 取消按钮 | 取消（ConfirmDialog 默认） |
| 成功 toast | 已清空对话 |
| 失败 toast | 清空失败 |

## 测试

- **sidecar**：`CLEAR_THREAD` handler 单测——
  - 有消息 → 删除全部消息且保留 thread
  - 运行中 → 先 stop 再清空
  - 空 thread → 幂等返回 ok
- **前端**：组件交互手动验证（选中 `/clear` → 弹窗 → 确认 → 消息清空、thread 保留、toast 成功；取消则不动；手打 `/clear` 回车走同样流程）。
- 现有测试不回归（`typecheck` + `test:web`）。

## 不做（YAGNI）

- 不在 AgentHeader / 工具栏新增「清空」按钮（仅保留 `/clear` 入口）。
- 不做「保留最近 N 条」「清空后自动新建会话」等可配置项。
- 不抽 `useConfirmDialog` hook（保持现有各组件 `confirmState` 范式一致即可，不在本次扩展）。
- 不改其它斜杠命令（`/compact`、`/mcp` 等）行为。

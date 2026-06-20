# `/compact` 斜杠命令接通真实后端业务 设计

## 概述

Agent 对话输入框 `/` 斜杠菜单中的 `/compact`（副标题「压缩当前对话历史，减少上下文占用」）当前未真正接通：选中后插入 slashMention node，其 `getText()` 输出 label `compact`（无 `/`），而后端 `agent-service.ts:643` 精确匹配字符串 `'/compact'`（带斜杠）→ 不命中 → 不压缩；即便命中，UX 也与 `/clear` 不一致（需手动回车）。

**关键事实**：后端「压缩对话历史」能力**已完整存在并端到端打通**——SDK `engine.ts` 的 `isManualCompactPrompt` 识别 `/compact` → `runCompaction('manual')`，用 LLM 把历史总结成摘要、以「摘要 + assistant 确认」2 条消息替换原历史；sidecar `context-controller.ts` 已接入；runtime 事件 `context.compaction.started/progress/completed` 已定义且前端 `runtime-event-message-projection.ts` 已将其投影成对话内的 system 消息。

因此本设计**不新建任何后端能力、不补 UI**，仅复用 `/clear` 已建立的「选中即执行」前端模式，把 `/compact` 接到现有压缩链路。

## 交互流程

```
[命令列表模式] --选中/compact--> [直接触发压缩，不弹确认]
  → 清空编辑器（不留 /compact 文本）
  → agentSend({ userMessage: '/compact', ... })
  → 后端识别 '/compact'（精确匹配）
    → 不落可见用户消息（hiddenFromChat: true, manualCommand: 'compact'）
    → SDK runCompaction('manual')：LLM 总结历史 → [摘要 + assistant 确认] 替换原历史
    → 发 context.compaction.started/progress/completed 事件
  → 前端 projection 把 compaction 事件 → system 消息（variant context_compaction）
  → 对话中显示「压缩进行中 → 完成」
[命令列表模式] --选中其他命令--> 保持现状
```

手打兜底：用户不走菜单、直接键盘输入 `/compact` 回车时，`handleSend` 拦截该文本，走与「选中」相同的 `handleSlashCommandExecute('compact')` 分支。

## 实现方案：复用 /clear 的 executeOnSelect 模式

### 选择理由

- `/clear` 已建立完整的「选中即执行」链路：`executeOnSelect` 标记 → `MentionList.selectItem` 分支 → `onCommandExecute` 透传 → `AgentInput.handleSlashCommandExecute` 分发。`/compact` 直接挂入同一分发器，加一个 `compact` 分支即可。
- 后端无需改动：`/compact` 字符串已是 SDK/sidecar 的既定触发器，`agentSend({ userMessage: '/compact' })` 即可命中。
- 压缩进度反馈无需新增：`runtime-event-message-projection.ts` 已把 `context.compaction.*` 投影成对话内 system 消息。

## 改动清单（仅 3 处前端，零后端、零 UI）

### 1. `apps/web/src/components/agent/slash-command-state.ts`

`COMMON_SLASH_COMMANDS` 的 `compact` 项加一行 `executeOnSelect: true,`（与 `clear`、`reload-plugins` 并列）。`MentionItem.executeOnSelect` 字段与 `CommonSlashCommand` 的 Pick 已在 `/clear` 任务中定义，无需改类型。

### 2. `apps/web/src/components/agent/AgentInput.tsx` —— `handleSlashCommandExecute` 加 `compact` 分支

在现有 `reload-plugins` 分支之后追加：

```typescript
    if (id === 'compact') {
      editor.commands.clearContent()
      setEditorText('')
      void (async () => {
        try {
          await agentSend({
            userMessage: '/compact',
            // 其余参数（threadId / workspaceId / permissionMode 等）与现有 handleSend 的 agentSend 调用一致
          })
          // 不 toast 成功：压缩进度由 compaction system 消息在对话中反馈
        } catch (error) {
          console.error('[AgentInput] 压缩对话失败:', error)
          toast.error('压缩失败')
        }
      })()
      return
    }
```

> `agentSend` 已 import（AgentInput.tsx:10）；参数集参照现有 `:562` 的 `agentSend({ ... })` 调用（threadId/workspaceId/permissionMode 等），在 plan 阶段对齐确切字段。后端 `agent-service.ts:643` 收到 `userMessage === '/compact'` 即触发 `runCompaction('manual')`，无需额外字段。

### 3. `apps/web/src/components/agent/AgentInput.tsx` —— `handleSend` 兜底

把现有兜底条件扩展，加入 `/compact`：

```typescript
    if (rawText === '/reload-plugins' || rawText === '/clear' || rawText === '/compact') {
      handleSlashCommandExecute(rawText.replace(/^\//, ''))
      return
    }
```

## 数据流

```
handleSlashCommandExecute('compact')
  → editor.commands.clearContent() + setEditorText('')
  → agentSend({ userMessage: '/compact', threadId, workspaceId, ... })
  → sidecar agent-service.ts: userMessage.trim() === '/compact' ✅
    → shouldAppendUserMessage = false（不落可见用户消息）
    → metadata { hiddenFromChat: true, manualCommand: 'compact' }
    → SDK engine: isManualCompactPrompt → runCompaction('manual')
        → compactMessages: provider.createMessage 用 summarizer system prompt 生成摘要
        → this.messages = [摘要 user + assistant 确认]（替换原历史）
        → contextController.onCompactionBoundary
    → 发 context.compaction.started / progress / completed（带 preTokens/postTokens/summary）
  → 前端 runtime-event-message-projection.ts:
      compaction 事件 → RuntimeMessageView { type:'system', variant:'context_compaction', status: active|completed }
  → 对话消息列表渲染压缩 system 消息（进行中 → 完成）
```

## 边界与安全

- **运行中 compact**：若 thread 正在流式输出，`agentSend('/compact')` 走正常发送路径，后端按既有逻辑排队/处理（与普通消息一致）；压缩在 SDK 层执行时自带 started/progress/completed 事件流，不会静默。
- **失败路径**：`agentSend` 抛错 → `toast.error('压缩失败')`；后端压缩本身的失败由 SDK 的 compaction 事件 / 运行时错误事件反馈，不在本分支额外处理。
- **弹窗**：无二次确认（已确认直接触发）。
- **编辑器**：选中即清空，不留 `/compact` 文本（与 `/clear`、`/reload-plugins` 一致）。
- **旧拦截**：`handleSend` 原本只兜底 `/reload-plugins`、`/clear`；本次仅扩展条件加入 `/compact`，不改既有逻辑。

## 测试

- **`slash-command-state.test.ts`**：在既有 `executeOnSelect 标记` describe 内追加断言——`compact` 的 `executeOnSelect === true`（与 clear/reload-plugins 同组）。
- **手动验证**：选中 `/compact` → 编辑器清空 → 对话出现压缩 system 消息（进行中→完成）→ 历史被摘要替换、token 占用下降；手打 `/compact` 回车同样触发；运行中触发不崩溃。
- 现有测试不回归（`typecheck` + `bun test` 相关文件）。

## 不做（YAGNI）

- 不新建后端 IPC/service（压缩能力已存在）。
- 不补压缩状态 UI（compaction system 消息已实现投影与渲染）。
- 不切换轻量模型（用当前线程主模型，与现状一致；按 `callerKind:'compaction'` 切模型是独立优化项，不在本次范围）。
- 不加二次确认（已确认直接触发）。
- 不改其它斜杠命令行为。

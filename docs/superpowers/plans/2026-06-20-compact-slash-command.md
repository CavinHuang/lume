# `/compact` 斜杠命令接通后端压缩 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 输入框 `/` 菜单中的 `/compact` 选中即触发后端真实压缩（LLM 总结历史成摘要替换原历史），并在对话中显示压缩进度——复用 `/clear` 已建立的「选中即执行」模式，零后端、零 UI 改动。

**Architecture:** 后端压缩链路（SDK `runCompaction`/`compactConversation` + sidecar `contextController` + `agent-service.ts:643` 识别 `'/compact'` 字符串 + `context.compaction.*` 事件 → 前端 `runtime-event-message-projection` 投影成 system 消息）已完整存在。前端只需把 `/compact` 挂入 `/clear` 已建的 `executeOnSelect` → `onCommandExecute` → `handleSlashCommandExecute` 分发链，compact 分支直接 `agentSend({ userMessage: '/compact' })` 命中后端识别器。

**Tech Stack:** TypeScript · React 18 + jotai + tiptap（web）· bun:test

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `apps/web/src/components/agent/slash-command-state.ts` | 斜杠命令元数据 | `compact` 项加 `executeOnSelect: true` |
| `apps/web/src/components/agent/slash-command-state.test.ts` | 元数据单测 | 调整 executeOnSelect 断言（compact 改为 true，falsy 用 mcp） |
| `apps/web/src/components/agent/AgentInput.tsx` | 输入框主组件 | `handleSlashCommandExecute` 加 `compact` 分支；`handleSend` 兜底加 `/compact` |

**复用、不修改：** `MentionItem.executeOnSelect` 字段、`MentionList.selectItem` 分支、`editor-mention-suggestions.createSuggestionRenderer` 透传、`ConfirmDialog`、后端全部压缩链路、compaction system 消息投影——均已在 `/clear` 任务中就绪。

---

## Task 1: `slash-command-state` 给 compact 加 `executeOnSelect`（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/slash-command-state.ts`（compact 项约 :37-45）
- Modify: `apps/web/src/components/agent/slash-command-state.test.ts`（executeOnSelect 块 :49-63）

- [ ] **Step 1: 改测试（先调成 compact 期望 true）**

把 `slash-command-state.test.ts` 的 `executeOnSelect 标记` describe（:49-63）整体替换为：

```typescript
describe('executeOnSelect 标记', () => {
  test('/clear /compact /reload-plugins 标记为选中即执行', () => {
    const items = getCommonSlashSuggestionItems()
    const clear = items.find((i) => i.id === 'clear')
    const compact = items.find((i) => i.id === 'compact')
    const reload = items.find((i) => i.id === 'reload-plugins')
    expect(clear?.executeOnSelect).toBe(true)
    expect(compact?.executeOnSelect).toBe(true)
    expect(reload?.executeOnSelect).toBe(true)
  })

  test('其它命令不带 executeOnSelect', () => {
    const items = getCommonSlashSuggestionItems()
    const mcp = items.find((i) => i.id === 'mcp')
    expect(mcp?.executeOnSelect).toBeFalsy()
  })
})
```

> 原 `:58-62` 用 compact 验证 falsy，compact 加标记后会冲突，故改为用 mcp 验证 falsy。

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test apps/web/src/components/agent/slash-command-state.test.ts`（加 `dangerouslyDisableSandbox: true`）
Expected: FAIL——`/clear /compact /reload-plugins` test 中 `expect(compact?.executeOnSelect).toBe(true)` 失败（compact 尚未标记）。其它 test 仍 pass。

- [ ] **Step 3: 给 compact 加标记**

在 `slash-command-state.ts` 的 `compact` 项（约 :37-45）加一行 `executeOnSelect: true,`：

```typescript
  {
    id: 'compact',
    label: 'compact',
    type: 'command',
    title: '/compact',
    subtitle: '压缩当前对话历史，减少上下文占用',
    section: 'capability',
    keywords: ['compact', 'compress', 'history', '压缩', '历史'],
    executeOnSelect: true,
  },
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test apps/web/src/components/agent/slash-command-state.test.ts`
Expected: PASS（全部 test 通过）

- [ ] **Step 5: Commit**

```bash
git -C /Users/cavinhuang/workspace/projects/ai-projects/Lume add apps/web/src/components/agent/slash-command-state.ts apps/web/src/components/agent/slash-command-state.test.ts
git -C /Users/cavinhuang/workspace/projects/ai-projects/Lume commit -m "✨ feat(web): /compact 标记为选中即执行"
```

---

## Task 2: `AgentInput` 加 compact 分支 + handleSend 兜底

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

- [ ] **Step 1: `handleSlashCommandExecute` 加 compact 分支**

在 `handleSlashCommandExecute`（约 :482-515）的 `reload-plugins` 分支 `return`（约 :512）之后、闭合 `}` 之前插入 compact 分支：

```typescript
    if (id === 'compact') {
      editor.commands.clearContent()
      setEditorText('')
      void (async () => {
        try {
          await agentSend({
            threadId,
            userMessage: '/compact',
            ...(workspaceIdRef.current ? { workspaceId: workspaceIdRef.current } : {}),
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

> `agentSend`（:10 import）、`threadId`、`workspaceIdRef`（:211）、`setEditorText`（:221）、`toast`（:6）均在作用域内。`handleSlashCommandExecute` 现有依赖数组 `[editor, threadId, threads, doClear]` 无需改动（compact 分支只用 threadId/workspaceIdRef/setEditorText/agentSend/toast，其中 threadId 已在 deps，其余为稳定 ref/setter/import）。

> **若 typecheck 报错** `agentSend` 缺少必填字段：参照现有调用（:562-569）补 `thinkingLevel`、`permissionMode`。compact 是命令、后端按字符串识别，这些字段对压缩无语义影响，但如类型必填则补齐（补齐后依赖数组加 `thinkingLevel, permissionMode`）。

- [ ] **Step 2: `handleSend` 兜底加 `/compact`**

把现有兜底条件（约 :522-526）：

```typescript
    if (rawText === '/reload-plugins' || rawText === '/clear') {
      handleSlashCommandExecute(rawText.replace(/^\//, ''))
      return
    }
```

改为：

```typescript
    if (rawText === '/reload-plugins' || rawText === '/clear' || rawText === '/compact') {
      handleSlashCommandExecute(rawText.replace(/^\//, ''))
      return
    }
```

- [ ] **Step 3: typecheck 验证**

Run: `bun run typecheck`（加 `dangerouslyDisableSandbox: true`）
Expected: PASS（5 包 exit 0；忽略 2 个预存无关失败 agent-settings-state.test / DefaultModelStrategyPanel.test）

- [ ] **Step 4: Commit**

```bash
git -C /Users/cavinhuang/workspace/projects/ai-projects/Lume add apps/web/src/components/agent/AgentInput.tsx
git -C /Users/cavinhuang/workspace/projects/ai-projects/Lume commit -m "✨ feat(web): /compact 选中即触发后端压缩"
```

---

## Task 3: 端到端验证

- [ ] **Step 1: 自动化验证**

Run（仓库根，加 `dangerouslyDisableSandbox: true`）:
```
bun run typecheck && bun test apps/web/src/components/agent/slash-command-state.test.ts
```
Expected: typecheck 5 包 exit 0；测试全 PASS。

- [ ] **Step 2: 手动验证（dev 启动）**

Run: `bun run dev`

逐项验证：

1. 选中 `/compact`：输入 `/`，选中 `/compact` → 编辑器**不出现** `/compact` 文本（选中即执行）。
2. 压缩触发：对话中应出现压缩 system 消息（「压缩进行中 → 完成」），历史被摘要替换、上下文 token 占用下降。
3. 失败反馈：断网或无可用模型时 → toast「压缩失败」（或后端 compaction 错误事件）。
4. 手打兜底：手动输入 `/compact` 回车 → 走同样压缩流程。
5. 运行中触发：thread 流式输出中选中 `/compact` → 不崩溃（后端按既有逻辑处理）。
6. 回归：`/clear`、`/reload-plugins`、`/mcp`、`/技能` 等其它命令行为不受影响。

- [ ] **Step 3: 通过后无额外提交（实现已随各 Task 提交）**

---

## Self-Review

**1. Spec coverage（对照 spec 各节）：**
- 选中即执行（compact）→ Task 1（executeOnSelect 标记，复用 /clear 的 selectItem 分支与 onCommandExecute 透传）+ Task 2（compact 分支）✓
- 直接 `agentSend('/compact')` 触发后端压缩 → Task 2 Step 1 ✓
- 对话显示压缩消息 → 后端 compaction 事件 + 前端 projection 已存在（spec 已述），无需新增代码；Task 3 Step 2 验证 ✓
- 手打兜底 → Task 2 Step 2 ✓
- 无二次确认 → Task 2 compact 分支直接执行（无 ConfirmDialog）✓
- 测试（executeOnSelect 断言）→ Task 1（TDD）✓

**2. Placeholder scan：** 无 TBD/TODO；compact 分支代码完整；唯一兜底说明（agentSend 缺字段时按 :562 补）是 typecheck 驱动的明确指令，非占位。✓

**3. Type consistency：**
- `executeOnSelect?: boolean` — Task 1（compact 加 true）、Task 1 测试（expect true）一致 ✓
- compact 分支 `agentSend({ threadId, userMessage: '/compact', workspaceId? })` — 与现有 :562 调用同源（精简掉命令无关字段）✓
- handleSlashCommandExecute 分发 `clear|reload-plugins|compact` — Task 2 Step 2 兜底 `rawText.replace(/^\//,'')` 把 `/compact`→`compact` 正确命中分支 ✓

# Subagent 内联展示面板设计

> 日期: 2026-04-18
> 状态: 已批准
> 分支: feat/new-ui

## 概述

重新设计 subagent 在对话流中的展示方式，替换当前简陋的 `SubagentCard` 组件。新方案采用收缩/展开双态的 `SubagentInlinePanel`，收缩态显示实时进度摘要，展开态显示完整的工具+文本内联对话流。嵌套 subagent 通过缩进+竖线表示层级关系。

## 背景

当前痛点：
1. **信息量不足** — 只有任务名和状态图标，看不到正在执行的工具和中间进度
2. **面板重复** — SubagentCard 在对话区和底部同时出现，混乱
3. **嵌套不清晰** — depth 字段存在但未可视化
4. **结果难追溯** — 完成后只有纯文本输出，无工具调用上下文

## 数据流架构

### 现有能力

Subagent 事件已经通过父线程的流式通道转发。SDK 的 `Agent` tool 在执行时通过 `annotateSubagentStreamingEvent()` 给每条消息打上 `subagent_run_id` 标记，然后将消息写入父线程的 event stream。前端在 `agent:stream:event` 中已经收到这些消息，只是当前没有按 runId 分组。

### 路由策略

在 `useGlobalAgentListeners.ts` 的 `agent:stream:event` handler 中：

```
收到 SDKMessage msg
  ├── msg.subagent_run_id 存在?
  │   ├── YES → agentSubagentMessagesAtom[threadId][runId].push(msg)
  │   │         (stream_event 也按 runId 累积到 synthetic streaming message)
  │   └── NO  → agentSDKMessagesAtom[threadId] (保持现有逻辑)
  └── done
```

### 渲染挂载点

`SDKContentBlock.tsx` 中 `ToolUseBlock` 渲染 `tool_use` 时：
- 当 `block.name === 'Agent'` 时，查找 `SubagentRunRecord`（通过 `parentToolUseId === block.id`）
- 渲染 `<SubagentInlinePanel runId={...} />` 替代原有逻辑
- `tool_result` 不再单独渲染（subagent 的 tool_result 在展开态内联显示）

## 状态管理

### 新增 Atom

```typescript
// atoms/agent-atoms.ts
export const agentSubagentMessagesAtom = atom<
  Record<string, Record<string, SDKMessage[]>>
>({})
// 结构: { [threadId]: { [runId]: SDKMessage[] } }
```

### 保留现有 Atom

- `agentSubagentRunsAtom` — 继续用于追踪 run 级别的元数据（status, startedAt, depth, label）
- `agentSDKMessagesAtom` — 主线程消息，不再混入 subagent 消息

## 组件设计

### SubagentInlinePanel（入口组件）

**文件**: `apps/web/src/components/agent/SubagentInlinePanel.tsx`

**Props**:
```typescript
interface SubagentInlinePanelProps {
  runId: string
  threadId: string
  label?: string
  status?: SubagentRunStatus
  startedAt?: number
  depth?: number  // 嵌套层级，用于计算缩进
}
```

**职责**:
- 从 `agentSubagentMessagesAtom` 读取对应 runId 的消息
- 从 `agentSubagentRunsAtom` 读取 run 元数据
- 管理收缩/展开状态
- 根据 depth 渲染缩进边框

**状态逻辑**:
```typescript
const isRunning = status === 'running' || status === 'accepted'
const isDone = status === 'completed'
const isError = status === 'errored' || status === 'timed_out' || status === 'aborted'
const elapsed = useElapsedTime(startedAt, !isDone && !isError)  // 运行中持续计时
```

### SubagentHeader（状态栏）

**渲染内容**:
- 状态图标: ● 运行中 / ✓ 完成 / ✗ 错误
- 任务名: `run.label ?? run.task`，truncate
- 状态标签: 蓝色/绿色/红色 pill
- 用时: `elapsed` 格式化为 `12.3s`
- 工具数: `🔧 N` 从消息中统计 tool_use blocks

**交互**: 点击整个 header 切换展开/收缩

### SubagentCollapsedPreview（收缩态预览）

**渲染内容**:
- 最后文本片段: 从最后一条 assistant 消息的 text block 提取，2行截断
- 工具标签: 从所有 assistant 消息的 tool_use blocks 提取，显示为 pill 标签
  - 已完成(有对应 tool_result): 绿色 `Glob ✓`
  - 运行中: 蓝色 `Bash ⏳`
  - 未知状态: 灰色
- 运行中时，文本末尾显示闪烁光标

**派生数据函数**:
```typescript
function deriveCollapsedData(messages: SDKMessage[]) {
  const toolCalls = messages
    .filter(m => m.type === 'assistant')
    .flatMap(m => (m.message?.content ?? []).filter(b => b.type === 'tool_use'))

  const toolResultIds = new Set(
    messages.filter(m => m.type === 'tool_result').map(m => m.result.tool_use_id)
  )

  const lastText = messages
    .filter(m => m.type === 'assistant')
    .flatMap(m => (m.message?.content ?? []).filter(b => b.type === 'text'))
    .at(-1)?.text ?? ''

  return {
    tools: toolCalls.map(tc => ({
      name: tc.name,
      done: toolResultIds.has(tc.id),
    })),
    lastText,
  }
}
```

### SubagentExpandedContent（展开态内容）

**渲染逻辑**:
- 直接复用 `SDKContentBlock` 渲染 subagent 的每条消息
- 消息按时间顺序排列，形成文本+工具的内联对话流
- `stream_event` 在展开态也需要处理：运行中的 subagent 展开后，实时显示 streaming 文本
- 遇到 `tool_use: Agent` 时递归渲染 `SubagentInlinePanel`，depth + 1

**嵌套渲染**:
```tsx
<div style={{ marginLeft: depth > 0 ? 16 : 0, borderLeft: depth > 0 ? '2px solid var(--border)' : 'none', paddingLeft: depth > 0 ? 16 : 0 }}>
  <SubagentInlinePanel runId={childRunId} depth={depth + 1} />
</div>
```

## useGlobalAgentListeners.ts 修改

### agent:stream:event handler 改动

```typescript
case 'agent:stream:event': {
  const e = params as AgentStreamEvent
  const msg = e.message
  const streamKey = e.threadId
  const runId = (msg as { subagent_run_id?: string }).subagent_run_id

  if (runId) {
    // === Subagent 消息路由 ===
    if (msg.type === 'stream_event') {
      // 累积到 subagent 的 synthetic streaming message
      // 复用 streamingRef 逻辑，但 key 改为 runId
      const subStreamKey = `${streamKey}:${runId}`
      // ... text_delta / thinking_delta 处理
      setSubagentMessages(prev => upsertSubagentStreaming(prev, streamKey, runId, ref))
    } else if (msg.type === 'assistant') {
      // 替换 synthetic streaming message
      setSubagentMessages(prev => replaceSubagentStreaming(prev, streamKey, runId, msg))
    } else if (msg.type === 'tool_result') {
      // 追加
      setSubagentMessages(prev => appendSubagentMessage(prev, streamKey, runId, msg))
    }
    // partial_message 跳过
    if (msg.type === 'partial_message') break
    break
  }

  // === 主线程消息 (无 subagent_run_id) ===
  // 保持现有逻辑不变
  // ...
}
```

### streamingRef 扩展

现有 `streamingRef` 的 key 需要区分主线程和 subagent：
- 主线程: `streamKey`（threadId）
- Subagent: `${streamKey}:${runId}`

## SDKContentBlock.tsx 修改

### ToolUseBlock 改动

在 `ToolUseBlock` 组件中，当 `block.name === 'Agent'` 时：

```tsx
if (block.name === 'Agent') {
  const run = findSubagentRun(toolUseId: block.id)
  if (run) {
    return <SubagentInlinePanel runId={run.runId} threadId={currentThreadId} ... />
  }
  // fallback: 等待 run 数据到达
  return <SubagentLoadingPill label={block.input.description ?? block.input.prompt} />
}
```

需要传入 `allMessages` 或 `threadId` 以便查找对应的 SubagentRunRecord。

### 移除旧逻辑

- 移除 `AgentMessages.tsx` 中基于 `parentToolUseId` 的 `SubagentCard` 渲染
- 移除底部 orphan runs 渲染
- 保留 `agent:list-subagent-runs` 的初始加载用于获取 run 元数据

## 边界情况

1. **Subagent 消息到达但 run 元数据未到**: 显示 loading pill，等 run 数据到达后替换
2. **嵌套层级过深**: depth >= 3 时不再缩进，改为平铺 + 标签显示层级
3. **大量工具调用**: 收缩态最多显示 8 个工具标签，超出显示 `+N more`
4. **运行中展开**: 展开后实时 streaming，auto-scroll 到最新内容
5. **历史对话加载**: 已完成 subagent 的消息通过 `getThreadSDKMessages(childThreadId)` 从持久化加载，或从 `agentSubagentMessagesAtom` 中的 runId 索引获取

## 明确不做

- **Subagent 独立面板**（侧边栏/底部停靠栏）— 内联方案已覆盖所有需求，独立面板会导致重复展示问题
- Subagent 手动停止/取消操作
- Subagent 的 token 使用量/成本展示
- team_name 分组视图

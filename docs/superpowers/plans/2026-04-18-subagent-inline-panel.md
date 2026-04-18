# Subagent 内联展示面板 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 subagent 从简陋的独立卡片替换为内联对话流中的双态面板（收缩/展开），实时显示进度和输出。

**Architecture:** 新增 `agentSubagentMessagesAtom` 按 `threadId → runId → SDKMessage[]` 存储 subagent 消息。在 `useGlobalAgentListeners` 中按 `subagent_run_id` 路由消息。`SDKContentBlock` 渲染 `Agent` tool_use 时挂载 `SubagentInlinePanel`，内部复用 `SDKContentBlock` 递归渲染嵌套。

**Tech Stack:** React, Jotai, TypeScript, Tailwind CSS, lucide-react

---

## File Structure

### 新建
- `apps/web/src/components/agent/SubagentInlinePanel.tsx` — 入口组件 + SubagentHeader + SubagentCollapsedPreview + SubagentExpandedContent
- `apps/web/src/hooks/useElapsedTime.ts` — 运行中持续计时 hook

### 修改
- `apps/web/src/atoms/agent-atoms.ts` — 新增 `agentSubagentMessagesAtom`
- `apps/web/src/hooks/useGlobalAgentListeners.ts` — 路由 subagent 消息到新 atom
- `apps/web/src/components/agent/SDKContentBlock.tsx` — ToolUseBlock 中 Agent 类型渲染 SubagentInlinePanel
- `apps/web/src/components/agent/AgentMessages.tsx` — 移除旧 SubagentCard 渲染逻辑

### 删除（最后统一清理）
- `apps/web/src/components/agent/SubagentCard.tsx` — 被 SubagentInlinePanel 完全替代

---

### Task 1: 新增 agentSubagentMessagesAtom + useElapsedTime hook

**Files:**
- Modify: `apps/web/src/atoms/agent-atoms.ts`
- Create: `apps/web/src/hooks/useElapsedTime.ts`

- [ ] **Step 1: 在 agent-atoms.ts 中添加新 atom**

在 `agentSubagentRunsAtom` 之后添加：

```typescript
export const agentSubagentMessagesAtom = atom<Record<string, Record<string, SDKMessage[]>>>({})
```

完整的 agent-atoms.ts 末尾应为：

```typescript
export const agentSubagentMessagesAtom = atom<Record<string, Record<string, SDKMessage[]>>({})
```

- [ ] **Step 2: 创建 useElapsedTime hook**

创建 `apps/web/src/hooks/useElapsedTime.ts`：

```typescript
import { useState, useEffect, useRef } from 'react'

export function useElapsedTime(startedAt: number | undefined, active: boolean): number {
  const [elapsed, setElapsed] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    if (!active || !startedAt) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (startedAt) setElapsed(Date.now() - startedAt)
      return
    }
    setElapsed(Date.now() - startedAt)
    intervalRef.current = setInterval(() => setElapsed(Date.now() - startedAt), 200)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [startedAt, active])

  return elapsed
}

export function formatElapsed(ms: number): string {
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const rem = (sec % 60).toFixed(0)
  return `${min}m${rem}s`
}
```

- [ ] **Step 3: 验证编译**

Run: `cd D:/workspace/projects/ai-projects/lume && npx --package=typescript tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep -E "agent-atoms|useElapsedTime"`

Expected: 无错误输出（仅有预存的其他文件错误）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/atoms/agent-atoms.ts apps/web/src/hooks/useElapsedTime.ts
git commit -m "feat(web): add subagent messages atom and useElapsedTime hook"
```

---

### Task 2: 扩展 useGlobalAgentListeners — 路由 subagent 消息

**Files:**
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`

这是最关键的改动。在 `agent:stream:event` handler 中检测 `subagent_run_id`，将带标记的消息路由到 `agentSubagentMessagesAtom`。

- [ ] **Step 1: 添加 import 和 helper 函数**

在文件顶部 import 中添加 `agentSubagentMessagesAtom`：

```typescript
import {
  agentSDKMessagesAtom,
  agentStreamingStatesAtom,
  agentRuntimeStatusAtom,
  agentPendingInteractiveAtom,
  agentSubagentRunsAtom,
  agentSubagentMessagesAtom,
  agentPlanStateAtom,
  agentThreadsAtom,
  agentErrorMessagesAtom,
} from '@/atoms'
```

在 `upsertStreamingMessage` 函数之后添加三个 subagent 消息操作 helper：

```typescript
function appendSubagentMessage(
  prev: Record<string, Record<string, SDKMessage[]>>,
  threadId: string,
  runId: string,
  msg: SDKMessage,
): Record<string, Record<string, SDKMessage[]>> {
  const threadMap = prev[threadId] ?? {}
  const messages = threadMap[runId] ?? []
  return {
    ...prev,
    [threadId]: { ...threadMap, [runId]: [...messages, msg] },
  }
}

function upsertSubagentStreaming(
  prev: Record<string, Record<string, SDKMessage[]>>,
  threadId: string,
  runId: string,
  ref: StreamingRef,
): Record<string, Record<string, SDKMessage[]>> {
  const syntheticMsg = {
    type: 'assistant',
    uuid: ref.uuid,
    message: {
      role: 'assistant',
      content: [
        ...(ref.thinking ? [{ type: 'thinking', thinking: ref.thinking }] : []),
        ...(ref.text ? [{ type: 'text', text: ref.text }] : []),
      ],
    },
  } as unknown as SDKMessage
  const threadMap = prev[threadId] ?? {}
  const messages = threadMap[runId] ?? []
  const idx = messages.findIndex((m) => (m as { uuid?: string }).uuid === ref.uuid)
  if (idx >= 0) {
    const updated = [...messages]
    updated[idx] = syntheticMsg
    return { ...prev, [threadId]: { ...threadMap, [runId]: updated } }
  }
  return { ...prev, [threadId]: { ...threadMap, [runId]: [...messages, syntheticMsg] } }
}

function replaceSubagentStreaming(
  prev: Record<string, Record<string, SDKMessage[]>>,
  threadId: string,
  runId: string,
  ref: StreamingRef | undefined,
  msg: SDKMessage,
): Record<string, Record<string, SDKMessage[]>> {
  const threadMap = prev[threadId] ?? {}
  const messages = threadMap[runId] ?? []
  if (ref) {
    const idx = messages.findIndex((m) => (m as { uuid?: string }).uuid === ref.uuid)
    if (idx >= 0) {
      const updated = [...messages]
      updated[idx] = msg
      return { ...prev, [threadId]: { ...threadMap, [runId]: updated } }
    }
  }
  return { ...prev, [threadId]: { ...threadMap, [runId]: [...messages, msg] } }
}
```

- [ ] **Step 2: 在 hook 内添加 setSubagentMessages 和 subagentStreamingRef**

在 `useGlobalAgentListeners()` 函数内，`const streamingRef = ...` 之前添加：

```typescript
const setSubagentMessages = useSetAtom(agentSubagentMessagesAtom)
```

在 `const streamingRef = useRef<Record<string, StreamingRef>>({})` 之后添加：

```typescript
const subagentStreamingRef = useRef<Record<string, StreamingRef>>({})
```

- [ ] **Step 3: 修改 agent:stream:event handler**

将整个 `case 'agent:stream:event'` 块替换为以下内容。逻辑：先检测 `subagent_run_id`，有则路由到 subagent atom，无则保持原逻辑不变。

```typescript
case 'agent:stream:event': {
  const e = params as AgentStreamEvent
  const msg = e.message
  const streamKey = e.threadId
  const runId = (msg as { subagent_run_id?: string }).subagent_run_id

  // === Subagent 消息路由 ===
  if (runId) {
    const subStreamKey = `${streamKey}:${runId}`

    if (msg.type === 'stream_event') {
      const event = (msg as unknown as Record<string, unknown>).event as Record<string, unknown> | undefined
      const delta = event?.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        const ref = subagentStreamingRef.current[subStreamKey] ?? { uuid: `sub-streaming:${subStreamKey}:${Date.now()}`, text: '', thinking: '' }
        ref.text += delta.text as string
        subagentStreamingRef.current[subStreamKey] = ref
        setSubagentMessages((prev) => upsertSubagentStreaming(prev, streamKey, runId, ref))
      }
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        const ref = subagentStreamingRef.current[subStreamKey] ?? { uuid: `sub-streaming:${subStreamKey}:${Date.now()}`, text: '', thinking: '' }
        ref.thinking += delta.thinking as string
        subagentStreamingRef.current[subStreamKey] = ref
        setSubagentMessages((prev) => upsertSubagentStreaming(prev, streamKey, runId, ref))
      }
      setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
      break
    }

    if (msg.type === 'assistant') {
      const ref = subagentStreamingRef.current[subStreamKey]
      setSubagentMessages((prev) => replaceSubagentStreaming(prev, streamKey, runId, ref, msg))
      delete subagentStreamingRef.current[subStreamKey]
      setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
      break
    }

    if (msg.type === 'tool_result') {
      setSubagentMessages((prev) => appendSubagentMessage(prev, streamKey, runId, msg))
      setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
      break
    }

    // partial_message and other types → skip for subagent
    break
  }

  // === 主线程消息 (无 subagent_run_id) ===

  // Streaming text/thinking deltas → accumulate into synthetic assistant message
  if (msg.type === 'stream_event') {
    const event = (msg as unknown as Record<string, unknown>).event as Record<string, unknown> | undefined
    const delta = event?.delta as Record<string, unknown> | undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      const ref = streamingRef.current[streamKey] ?? { uuid: `streaming:${streamKey}:${Date.now()}`, text: '', thinking: '' }
      ref.text += delta.text as string
      streamingRef.current[streamKey] = ref
      setSDKMessages((prev) => upsertStreamingMessage(prev, streamKey, ref))
    }
    if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      const ref = streamingRef.current[streamKey] ?? { uuid: `streaming:${streamKey}:${Date.now()}`, text: '', thinking: '' }
      ref.thinking += delta.thinking as string
      streamingRef.current[streamKey] = ref
      setSDKMessages((prev) => upsertStreamingMessage(prev, streamKey, ref))
    }
    setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
    break
  }

  // Full assistant message → replace synthetic streaming message
  if (msg.type === 'assistant') {
    const ref = streamingRef.current[streamKey]
    if (ref) {
      setSDKMessages((prev) => {
        const existing = prev[streamKey] ?? []
        const idx = existing.findIndex((m) => (m as { uuid?: string }).uuid === ref.uuid)
        if (idx >= 0) {
          const updated = [...existing]
          updated[idx] = msg
          return { ...prev, [streamKey]: updated }
        }
        return { ...prev, [streamKey]: [...existing, msg] }
      })
      delete streamingRef.current[streamKey]
    } else {
      setSDKMessages((prev) => ({
        ...prev,
        [streamKey]: [...(prev[streamKey] ?? []), msg],
      }))
    }
    setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
    break
  }

  // Skip partial_message
  if (msg.type === 'partial_message') {
    break
  }

  // Other message types → append
  setSDKMessages((prev) => ({
    ...prev,
    [streamKey]: [...(prev[streamKey] ?? []), msg],
  }))
  setStreamingStates((prev) => ({ ...prev, [streamKey]: 'streaming' }))
  break
}
```

- [ ] **Step 4: 更新 useEffect 依赖数组**

在 useEffect 的依赖数组中添加 `setSubagentMessages`：

```typescript
}, [setSDKMessages, setStreamingStates, setRuntimeStatus, setPendingInteractive, setSubagentRuns, setSubagentMessages, setPlanState, setThreads, setErrorMessages])
```

- [ ] **Step 5: 在 agent:stream:complete 中清理 subagent streamingRef**

在 `case 'agent:stream:complete'` 块中，在 `delete streamingRef.current[threadId]` 之后添加：

```typescript
// 清理该线程下所有 subagent streaming refs
for (const key of Object.keys(subagentStreamingRef.current)) {
  if (key.startsWith(`${threadId}:`)) {
    delete subagentStreamingRef.current[key]
  }
}
```

- [ ] **Step 6: 验证编译**

Run: `cd D:/workspace/projects/ai-projects/lume && npx --package=typescript tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep useGlobalAgentListeners`

Expected: 无错误输出

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/hooks/useGlobalAgentListeners.ts
git commit -m "feat(web): route subagent messages by subagent_run_id to separate atom"
```

---

### Task 3: 创建 SubagentInlinePanel 组件

**Files:**
- Create: `apps/web/src/components/agent/SubagentInlinePanel.tsx`

这个组件包含四个内部组件：`SubagentInlinePanel`（入口）、`SubagentHeader`、`SubagentCollapsedPreview`、`SubagentExpandedContent`。

- [ ] **Step 1: 创建 SubagentInlinePanel.tsx**

创建 `apps/web/src/components/agent/SubagentInlinePanel.tsx`：

```tsx
import { useState, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, CheckCircle, XCircle, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentSubagentMessagesAtom, agentSubagentRunsAtom } from '@/atoms'
import { SDKContentBlock } from './SDKContentBlock'
import { useElapsedTime, formatElapsed } from '@/hooks/useElapsedTime'
import type { SubagentRunStatus, SDKMessage } from '@lume/shared'

interface SubagentInlinePanelProps {
  runId: string
  threadId: string
  label?: string
  status?: SubagentRunStatus
  startedAt?: number
  depth?: number
}

const MAX_VISIBLE_TOOLS = 8

interface ToolPill {
  name: string
  done: boolean
}

function deriveCollapsedData(messages: SDKMessage[]) {
  const toolCalls: Array<{ name: string; id: string }> = []
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray((m as { message?: { content?: unknown[] } }).message?.content)) {
      const content = (m as { message: { content: unknown[] } }).message.content as Array<{ type: string; name?: string; id?: string }>
      for (const block of content) {
        if (block.type === 'tool_use' && block.name && block.id) {
          toolCalls.push({ name: block.name, id: block.id })
        }
      }
    }
  }

  const toolResultIds = new Set<string>()
  for (const m of messages) {
    if (m.type === 'tool_result') {
      const result = (m as { result?: { tool_use_id?: string } }).result
      if (result?.tool_use_id) toolResultIds.add(result.tool_use_id)
    }
  }

  const tools: ToolPill[] = toolCalls.map(tc => ({
    name: tc.name,
    done: toolResultIds.has(tc.id),
  }))

  let lastText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.type === 'assistant' && Array.isArray((m as { message?: { content?: unknown[] } }).message?.content)) {
      const content = (m as { message: { content: unknown[] } }).message.content as Array<{ type: string; text?: string }>
      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j].type === 'text' && content[j].text) {
          lastText = content[j].text
          break
        }
      }
      if (lastText) break
    }
  }

  return { tools, lastText }
}

function countToolUses(messages: SDKMessage[]): number {
  let count = 0
  for (const m of messages) {
    if (m.type === 'assistant' && Array.isArray((m as { message?: { content?: unknown[] } }).message?.content)) {
      const content = (m as { message: { content: unknown[] } }).message.content as Array<{ type: string }>
      for (const block of content) {
        if (block.type === 'tool_use') count++
      }
    }
  }
  return count
}

export function SubagentInlinePanel({ runId, threadId, label, status, startedAt, depth = 0 }: SubagentInlinePanelProps) {
  const [expanded, setExpanded] = useState(false)
  const subagentMessagesMap = useAtomValue(agentSubagentMessagesAtom)
  const subagentRunsMap = useAtomValue(agentSubagentRunsAtom)

  // 如果外部没传 status/label，从 runs atom 补充
  const runRecord = subagentRunsMap[threadId]?.find(r => r.runId === runId)
  const effectiveLabel = label ?? runRecord?.label ?? runRecord?.task ?? 'Subagent'
  const effectiveStatus = status ?? runRecord?.status
  const effectiveStartedAt = startedAt ?? runRecord?.startedAt ?? runRecord?.createdAt

  const messages = subagentMessagesMap[threadId]?.[runId] ?? []
  const isRunning = effectiveStatus === 'running' || effectiveStatus === 'accepted'
  const isError = effectiveStatus === 'errored' || effectiveStatus === 'timed_out' || effectiveStatus === 'aborted'
  const isDone = effectiveStatus === 'completed'
  const elapsed = useElapsedTime(effectiveStartedAt, isRunning)
  const toolCount = useMemo(() => countToolUses(messages), [messages])

  const indent = depth > 0

  return (
    <div
      className={cn(
        'rounded-xl border overflow-hidden',
        indent ? 'border-l-2 border-l-foreground/20' : '',
        isRunning ? 'border-blue-500/30 bg-blue-500/5' :
        isError ? 'border-destructive/30 bg-destructive/5' :
        'border-border/50 bg-muted/20',
      )}
    >
      <SubagentHeader
        label={effectiveLabel}
        isRunning={isRunning}
        isDone={isDone}
        isError={isError}
        elapsed={elapsed}
        toolCount={toolCount}
        expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      />
      {!expanded && messages.length > 0 && (
        <SubagentCollapsedPreview
          messages={messages}
          isRunning={isRunning}
        />
      )}
      {expanded && (
        <SubagentExpandedContent
          messages={messages}
          threadId={threadId}
          depth={depth}
          isRunning={isRunning}
        />
      )}
    </div>
  )
}

function SubagentHeader({
  label, isRunning, isDone, isError, elapsed, toolCount, expanded, onClick,
}: {
  label: string
  isRunning: boolean
  isDone: boolean
  isError: boolean
  elapsed: number
  toolCount: number
  expanded: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/30 transition-colors text-left"
    >
      <ChevronDown size={12} className={cn('text-foreground/40 transition-transform flex-shrink-0', expanded && 'rotate-180')} />
      {isRunning && <Loader2 size={12} className="animate-spin text-blue-500 flex-shrink-0" />}
      {isDone && <CheckCircle size={12} className="text-green-500 flex-shrink-0" />}
      {isError && <XCircle size={12} className="text-destructive flex-shrink-0" />}
      <span className="flex-1 text-[13px] text-foreground/80 truncate font-medium">{label}</span>
      <span className={cn(
        'text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0',
        isRunning && 'bg-blue-500/15 text-blue-500',
        isDone && 'bg-green-500/15 text-green-500',
        isError && 'bg-destructive/15 text-destructive',
        !isRunning && !isDone && !isError && 'bg-muted text-muted-foreground',
      )}>
        {isRunning ? '运行中' : isDone ? '完成' : isError ? '错误' : '等待'}
      </span>
      <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">{formatElapsed(elapsed)}</span>
      {toolCount > 0 && (
        <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">🔧 {toolCount}</span>
      )}
    </button>
  )
}

function SubagentCollapsedPreview({ messages, isRunning }: { messages: SDKMessage[]; isRunning: boolean }) {
  const { tools, lastText } = useMemo(() => deriveCollapsedData(messages), [messages])
  const visibleTools = tools.slice(0, MAX_VISIBLE_TOOLS)
  const extraCount = tools.length - visibleTools.length

  if (!lastText && tools.length === 0) return null

  return (
    <div className="px-3 pb-2 space-y-1.5">
      {lastText && (
        <p className="text-[12px] text-foreground/60 leading-relaxed line-clamp-2 whitespace-pre-wrap">
          {lastText}
          {isRunning && <span className="inline-block w-[2px] h-[14px] bg-blue-500 animate-pulse ml-0.5 align-middle" />}
        </p>
      )}
      {visibleTools.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {visibleTools.map((t, i) => (
            <span
              key={`${t.name}-${i}`}
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded',
                t.done ? 'bg-green-500/15 text-green-600 dark:text-green-400' :
                isRunning ? 'bg-blue-500/15 text-blue-500' :
                'bg-muted text-muted-foreground',
              )}
            >
              {t.name} {t.done ? '✓' : isRunning ? '⏳' : ''}
            </span>
          ))}
          {extraCount > 0 && (
            <span className="text-[10px] text-muted-foreground/50">+{extraCount}</span>
          )}
        </div>
      )}
    </div>
  )
}

function SubagentExpandedContent({
  messages, threadId, depth, isRunning,
}: {
  messages: SDKMessage[]
  threadId: string
  depth: number
  isRunning: boolean
}) {
  if (messages.length === 0) {
    return (
      <div className="px-3 pb-2">
        <p className="text-[12px] text-muted-foreground/50">等待 subagent 输出...</p>
      </div>
    )
  }

  return (
    <div className={cn('border-t border-border/30 p-3 space-y-2', depth > 0 && depth < 3 && 'ml-3 border-l-2 border-l-foreground/15 pl-3')}>
      {messages.map((msg, i) => (
        <SDKContentBlock
          key={(msg as { uuid?: string }).uuid ?? `sub-${i}`}
          message={msg}
          index={i}
          animate={isRunning && i === messages.length - 1}
          allMessages={messages}
          isStreaming={isRunning}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 2: 验证编译**

Run: `cd D:/workspace/projects/ai-projects/lume && npx --package=typescript tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep SubagentInlinePanel`

Expected: 无错误输出

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/agent/SubagentInlinePanel.tsx
git commit -m "feat(web): add SubagentInlinePanel component with collapsed/expanded states"
```

---

### Task 4: 修改 SDKContentBlock — Agent tool_use 渲染 SubagentInlinePanel

**Files:**
- Modify: `apps/web/src/components/agent/SDKContentBlock.tsx`

- [ ] **Step 1: 添加 imports**

在文件顶部添加：

```typescript
import { SubagentInlinePanel } from './SubagentInlinePanel'
import { useAtomValue } from 'jotai'
import { agentSubagentRunsAtom } from '@/atoms'
```

- [ ] **Step 2: 修改 ToolUseBlock 组件签名和内部逻辑**

将 `ToolUseBlock` 组件修改为接收额外的 `threadId` prop，并在 `block.name === 'Agent'` 时渲染 `SubagentInlinePanel`。

替换整个 `ToolUseBlock` 函数（从 `function ToolUseBlock(` 到它对应的闭合 `}`）：

```tsx
function ToolUseBlock({
  block, hasResult, resultData, threadId,
}: {
  block: { id: string; name: string; input: Record<string, unknown> }
  hasResult: boolean
  resultData: unknown
  threadId?: string
}) {
  const [collapsed, setCollapsed] = useState(true)
  const startedAtRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)
  const subagentRunsMap = useAtomValue(agentSubagentRunsAtom)

  useEffect(() => {
    if (hasResult) return
    const id = setInterval(() => setElapsed(Date.now() - startedAtRef.current), 200)
    return () => clearInterval(id)
  }, [hasResult])

  // Agent tool_use → SubagentInlinePanel
  if (block.name === 'Agent' && threadId) {
    const runs = subagentRunsMap[threadId] ?? []
    const run = runs.find(r => r.parentToolUseId === block.id)
    if (run) {
      return <SubagentInlinePanel runId={run.runId} threadId={threadId} />
    }
    // Fallback: run 数据未到，显示简短 loading
    const description = (block.input.description ?? block.input.prompt ?? '') as string
    return (
      <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2 flex items-center gap-2">
        <Loader2 size={12} className="animate-spin text-blue-500" />
        <span className="text-[12px] text-foreground/60 truncate">{description || '启动 subagent...'}</span>
      </div>
    )
  }

  const ToolIcon = TOOL_ICONS[block.name] ?? Wrench
  const elapsedSec = (elapsed / 1000).toFixed(1)

  return (
    <div className="rounded-xl border border-border/50 overflow-hidden bg-muted/20">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-foreground/60 hover:bg-muted/30 transition-colors"
      >
        <ChevronRight size={12} className={cn('transition-transform', !collapsed && 'rotate-90')} />
        <ToolIcon size={12} className="text-foreground/50 shrink-0" />
        <span className="font-mono font-medium text-foreground/70">{block.name}</span>
        {hasResult ? (
          <span className="ml-auto text-[10px] text-muted-foreground/50">{elapsedSec}s</span>
        ) : (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-blue-500/80">
            <Loader2 size={10} className="animate-spin" />
            {elapsedSec}s
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="border-t border-border/30 p-3">
          <ToolResultRenderer toolName={block.name} input={block.input} result={resultData} />
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 修改 ContentBlockItem 传递 threadId**

在 `ContentBlockItem` 组件中，将 `threadId` 透传到 `ToolUseBlock`。

修改 `ContentBlockItem` 的 props 接口，添加 `threadId`:

```tsx
function ContentBlockItem({
  block,
  toolResultMap,
  isStreaming,
  threadId,
}: {
  block: ContentBlockType
  toolResultMap: Map<string, { output: string; toolName: string }>
  isStreaming?: boolean
  threadId?: string
}) {
```

修改 `ContentBlockItem` 内部渲染 `ToolUseBlock` 的地方：

```tsx
if (block.type === 'tool_use') {
  const toolResult = toolResultMap.get(block.id)
  let resultData: unknown = undefined
  if (toolResult) {
    try { resultData = JSON.parse(toolResult.output) }
    catch { resultData = toolResult.output }
  }
  return (
    <ToolUseBlock
      block={block}
      hasResult={toolResult !== undefined}
      resultData={resultData}
      threadId={threadId}
    />
  )
}
```

- [ ] **Step 4: 修改 SDKContentBlock 传递 threadId**

修改 `SDKContentBlockProps` 接口，添加 `threadId`:

```tsx
interface SDKContentBlockProps {
  message: SDKMessage
  index: number
  animate?: boolean
  allMessages?: SDKMessage[]
  isStreaming?: boolean
  threadId?: string
}
```

修改 `SDKContentBlock` 函数签名：

```tsx
export function SDKContentBlock({ message, index, animate, allMessages, isStreaming, threadId }: SDKContentBlockProps) {
```

修改 `SDKContentBlock` 内部渲染 `ContentBlockItem` 的地方，传入 `threadId`：

```tsx
<ContentBlockItem
  key={`${block.type}-${i}`}
  block={block}
  toolResultMap={toolResultMap}
  isStreaming={animate && isStreaming}
  threadId={threadId}
/>
```

- [ ] **Step 5: 验证编译**

Run: `cd D:/workspace/projects/ai-projects/lume && npx --package=typescript tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep SDKContentBlock`

Expected: 无错误输出

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agent/SDKContentBlock.tsx
git commit -m "feat(web): render SubagentInlinePanel for Agent tool_use in SDKContentBlock"
```

---

### Task 5: 修改 AgentMessages — 传入 threadId 并移除旧 SubagentCard 逻辑

**Files:**
- Modify: `apps/web/src/components/agent/AgentMessages.tsx`

- [ ] **Step 1: 传入 threadId 给 SDKContentBlock**

在 `AgentMessages` 的渲染循环中，给 `SDKContentBlock` 添加 `threadId` prop：

```tsx
items.push(
  <SDKContentBlock
    key={(msg as { uuid?: string }).uuid ?? `msg-${i}`}
    message={msg}
    index={i}
    animate={streaming && i === sdkMessages.length - 1}
    allMessages={sdkMessages}
    isStreaming={streaming}
    threadId={threadId}
  />
)
```

- [ ] **Step 2: 移除旧的 SubagentCard 渲染逻辑**

删除以下两段代码：

1. 删除 `SDKContentBlock` 之后的 subagent card 插入逻辑（约第 127-138 行）：
```tsx
// 删除这段
if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
  for (const block of msg.message.content as Array<{ type: string; id?: string }>) {
    if (block.type === 'tool_use' && block.id) {
      const runs = subagentToolMap.get(block.id)
      if (runs) {
        for (const run of runs) {
          items.push(<SubagentCard key={`sa-${run.runId}`} run={run} />)
        }
      }
    }
  }
}
```

2. 删除底部的 orphan runs 渲染（约第 141-143 行）：
```tsx
// 删除这段
for (const run of orphanRuns) {
  items.push(<SubagentCard key={`sa-${run.runId}`} run={run} />)
}
```

- [ ] **Step 3: 清理不再使用的 import 和变量**

删除 `SubagentCard` 的 import：
```typescript
// 删除
import { SubagentCard } from './SubagentCard'
```

删除 `buildSubagentToolMap` 和 `getOrphanRuns` 函数（如果不再有引用）。

删除 `subagentToolMap` 和 `orphanRuns` 的 `useMemo` 计算。

保留 `agentSubagentRunsAtom` 的 import 和初始加载逻辑（run 元数据仍需要）。

- [ ] **Step 4: 验证编译**

Run: `cd D:/workspace/projects/ai-projects/lume && npx --package=typescript tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep AgentMessages`

Expected: 无错误输出

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/AgentMessages.tsx
git commit -m "refactor(web): remove old SubagentCard rendering, pass threadId to SDKContentBlock"
```

---

### Task 6: 删除 SubagentCard 组件 + 清理

**Files:**
- Delete: `apps/web/src/components/agent/SubagentCard.tsx`

- [ ] **Step 1: 确认没有其他文件引用 SubagentCard**

Run: `cd D:/workspace/projects/ai-projects/lume && grep -r "SubagentCard" apps/web/src/ --include="*.ts" --include="*.tsx" -l`

Expected: 无结果（或只有 SubagentCard.tsx 本身）

- [ ] **Step 2: 删除 SubagentCard.tsx**

```bash
rm apps/web/src/components/agent/SubagentCard.tsx
```

- [ ] **Step 3: 全局验证编译**

Run: `cd D:/workspace/projects/ai-projects/lume && npx --package=typescript tsc --noEmit -p apps/web/tsconfig.json 2>&1 | grep -v "node_modules" | grep -v ".test." | head -20`

Expected: 无与本次改动相关的错误

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(web): remove legacy SubagentCard component"
```

---

### Task 7: 端到端验证

**Files:** 无修改，仅测试

- [ ] **Step 1: 启动开发服务器**

```bash
cd D:/workspace/projects/ai-projects/lume && pnpm --filter web dev
```

- [ ] **Step 2: 手动验证清单**

在浏览器中测试以下场景：

1. **基本发送**: 发送一个会触发 subagent 的任务（如 "帮我分析一下项目结构"），验证：
   - 收缩态显示: 任务名 + 运行中状态 + 用时递增 + 工具标签出现
   - 点击 header 展开: 显示完整的文本+工具内联流
   - 再次点击收缩: 回到预览状态

2. **完成状态**: 等待 subagent 完成，验证：
   - 状态变为绿色"完成"
   - 用时停止递增
   - 收缩态显示输出摘要（2行截断）
   - 展开态显示完整输出

3. **历史对话**: 切换到其他线程再切回，验证：
   - 已完成的 subagent 正确显示
   - 展开/收缩状态保持

4. **主线程消息**: 确认主线程的 user/assistant 消息不受影响

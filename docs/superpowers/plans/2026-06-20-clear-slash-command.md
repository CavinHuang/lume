# `/clear` 斜杠命令接入真实行为 + 二次确认 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 输入框 `/` 菜单中的 `/clear` 选中后弹出二次确认，确认后清空当前会话所有消息与运行记录（保留 thread 本身）；顺带把 `/reload-plugins` 一并改为「选中即执行」模式，并保留手打命令文本回车的兜底。

**Architecture:** 后端新增专用 `CLEAR_THREAD` IPC（`agent:clear-thread`），handler 调用薄包装 `clearAgentThreadMessages(threadId)`——内部先 `stopAgent`（幂等）再 `replaceAgentThreadTranscript(threadId, [])` 清空 transcript、保留 thread meta。前端通过 `executeOnSelect` 标记区分「选中即执行」命令，`MentionList.selectItem` 对这类命令不插入 mention 文本、改调 `onCommandExecute(id)`；`AgentInput` 用 ref 模式把回调透传进 tiptap suggestion，弹 `ConfirmDialog`（复用现有组件）并重置 jotai atom。

**Tech Stack:** TypeScript · bun workspace · React 18 + jotai + tiptap（web）· bun:test（sidecar）· @base-ui/react Dialog / sonner toast

---

## File Structure

| 文件 | 责任 | 动作 |
|------|------|------|
| `packages/shared/src/types/agent.ts` | IPC channel 枚举 | 新增 `CLEAR_THREAD` |
| `apps/sidecar/src/services/agent/agent-thread-manager.ts` | 线程/消息存储服务 | 新增 `clearAgentThreadMessages` |
| `apps/sidecar/src/services/agent/agent-thread-manager.test.ts` | 服务单测 | 新建 |
| `apps/sidecar/src/rpc/agent-handlers.ts` | RPC handler 注册表 | 新增 `CLEAR_THREAD` handler + import |
| `apps/web/src/components/agent/slash-command-state.ts` | 斜杠命令元数据 | `MentionItem` 加 `executeOnSelect`；标记 clear/reload-plugins |
| `apps/web/src/components/agent/slash-command-state.test.ts` | 元数据单测 | 加 executeOnSelect 断言 |
| `apps/web/src/components/agent/MentionList.tsx` | `/` 浮层面板 | props 加 `onCommandExecute`；selectItem 分支 |
| `apps/web/src/components/agent/editor-mention-suggestions.ts` | tiptap suggestion 渲染器 | `createSuggestionRenderer` 透传 `onCommandExecute` |
| `apps/web/src/components/agent/AgentInput.tsx` | 输入框主组件 | handleSlashCommandExecute + doClear + confirmState + 常驻 ConfirmDialog + handleSend 兜底 + ref 透传 |

**复用、不修改：** `apps/web/src/components/ui/confirm-dialog.tsx`（`ConfirmDialog`）、`apps/web/src/atoms/agent-atoms.ts`（atoms）、sonner `toast`、`stopAgent`、`replaceAgentThreadTranscript`、`getAgentThreadMessages`、`getAgentThreadMeta`、`agentThreadIdInputSchema`。

---

## Task 1: shared — 新增 `CLEAR_THREAD` channel

**Files:**
- Modify: `packages/shared/src/types/agent.ts`（在 `STOP_THREAD` 附近，约 :1330）

- [ ] **Step 1: 加 channel 枚举**

在 `AGENT_IPC_CHANNELS` 对象中，`STOP_THREAD: 'agent:stop-thread',` 这一行之后新增：

```typescript
  CLEAR_THREAD: 'agent:clear-thread',
```

- [ ] **Step 2: typecheck 验证**

Run: `bun run typecheck`
Expected: PASS（无新增错误；现有 2 个预存失败 `agent-settings-state.test`、`DefaultModelStrategyPanel.test` 与本任务无关，忽略）

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types/agent.ts
git commit -m "✨ feat(shared): 新增 CLEAR_THREAD IPC 通道"
```

---

## Task 2: sidecar — `clearAgentThreadMessages` 纯函数（TDD）

**Files:**
- Modify: `apps/sidecar/src/services/agent/agent-thread-manager.ts`
- Test: `apps/sidecar/src/services/agent/agent-thread-manager.test.ts`（新建）

- [ ] **Step 1: 写失败测试（新建测试文件）**

创建 `apps/sidecar/src/services/agent/agent-thread-manager.test.ts`：

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentMessage } from '@lume/shared'
import {
  appendAgentTranscriptMessage,
  clearAgentThreadMessages,
  createAgentThread,
  getAgentThreadMessages,
  getAgentThreadMeta,
} from './agent-thread-manager'

describe('clearAgentThreadMessages', () => {
  let tempConfigDir = ''
  const oldConfigDir = process.env.LUME_CONFIG_DIR

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'lume-clear-thread-'))
    process.env.LUME_CONFIG_DIR = tempConfigDir
  })

  afterEach(() => {
    if (oldConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR
    } else {
      process.env.LUME_CONFIG_DIR = oldConfigDir
    }
    rmSync(tempConfigDir, { recursive: true, force: true })
  })

  const buildMessage = (role: 'user' | 'assistant', content: string): AgentMessage =>
    ({ id: `${role}-${content}`, role, content, createdAt: Date.now() }) as AgentMessage

  it('清空全部消息且保留 thread 本身', () => {
    const thread = createAgentThread('测试会话')
    appendAgentTranscriptMessage(thread.id, buildMessage('user', '你好'))
    appendAgentTranscriptMessage(thread.id, buildMessage('assistant', '你好，有什么可以帮你'))
    expect(getAgentThreadMessages(thread.id).length).toBe(2)

    const result = clearAgentThreadMessages(thread.id)

    expect(result.ok).toBe(true)
    expect(result.cleared).toBe(2)
    expect(getAgentThreadMessages(thread.id).length).toBe(0)
    expect(getAgentThreadMeta(thread.id)).toBeDefined()
  })

  it('空 thread 清空幂等无害', () => {
    const thread = createAgentThread('空会话')
    const result = clearAgentThreadMessages(thread.id)
    expect(result.ok).toBe(true)
    expect(result.cleared).toBe(0)
    expect(getAgentThreadMessages(thread.id).length).toBe(0)
    expect(getAgentThreadMeta(thread.id)).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test apps/sidecar/src/services/agent/agent-thread-manager.test.ts`
Expected: FAIL，错误为 `clearAgentThreadMessages is not defined`（或 not exported）

> 若 `appendAgentTranscriptMessage` 在 rebuild transcript 时报 `AgentMessage` 字段缺失，按报错在 `buildMessage` 补字段（`AgentMessage = AgentThreadMessage`，定义见 `packages/shared/src/types/agent.ts:196`）。

- [ ] **Step 3: 实现 `clearAgentThreadMessages`**

在 `agent-thread-manager.ts` 的 `truncateAgentMessagesFrom` 函数（约 :619）之后新增：

```typescript
/**
 * 清空指定线程的全部消息与运行记录，保留线程本身（meta 留存），可在同一会话窗口继续对话。
 * 若线程正在运行，先停止，避免 runtime 继续向已清空的线程写入。
 * stopAgent 对非运行中的线程为幂等 no-op（与 STOP_THREAD handler 行为一致）。
 */
export function clearAgentThreadMessages(threadId: string): { ok: true; cleared: number } {
  stopAgent(threadId)
  const messages = getAgentThreadMessages(threadId)
  replaceAgentThreadTranscript(threadId, [])
  console.log(`[Agent 线程] 已清空 ${threadId.slice(0, 8)} 的 ${messages.length} 条消息`)
  return { ok: true, cleared: messages.length }
}
```

> `stopAgent`、`getAgentThreadMessages`、`replaceAgentThreadTranscript` 均已在同文件定义（`stopAgent` 约 :996，其余 :231 / :664），无需新增 import。

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test apps/sidecar/src/services/agent/agent-thread-manager.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: Commit**

```bash
git add apps/sidecar/src/services/agent/agent-thread-manager.ts apps/sidecar/src/services/agent/agent-thread-manager.test.ts
git commit -m "✨ feat(sidecar): clearAgentThreadMessages 清空会话消息保留线程"
```

---

## Task 3: sidecar — 注册 `CLEAR_THREAD` handler

**Files:**
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts`

- [ ] **Step 1: 加 import**

在 `agent-thread-manager` 的 import 列表（文件顶部，约 :174 附近有 `agentTruncateThreadInputSchema` 等）中加入 `clearAgentThreadMessages`。找到现有的从 `agent-thread-manager` import 的语句，把 `clearAgentThreadMessages` 加进去（若 import 是具名列表，追加一项）。

- [ ] **Step 2: 加 handler**

在 `TRUNCATE_THREAD_MESSAGES_FROM` handler（约 :848-851）之后新增：

```typescript
    [AGENT_IPC_CHANNELS.CLEAR_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.CLEAR_THREAD);
      return clearAgentThreadMessages(input.threadId);
    },
```

> `agentThreadIdInputSchema`（`{ threadId: string }`）与 `validateInput` 已在本文件使用（如 STOP handler :1414），无需新增 import。

- [ ] **Step 3: typecheck 验证**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/sidecar/src/rpc/agent-handlers.ts
git commit -m "✨ feat(sidecar): 注册 CLEAR_THREAD RPC handler"
```

---

## Task 4: web — `slash-command-state` 加 `executeOnSelect`（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/slash-command-state.ts`
- Test: `apps/web/src/components/agent/slash-command-state.test.ts`

- [ ] **Step 1: 写失败测试**

在 `slash-command-state.test.ts` 中新增一个 describe（文件已存在并测 `buildSlashSuggestionItems`）：

```typescript
import { getCommonSlashSuggestionItems } from './slash-command-state'

describe('executeOnSelect 标记', () => {
  it('/clear 与 /reload-plugins 标记为选中即执行', () => {
    const items = getCommonSlashSuggestionItems()
    const clear = items.find((i) => i.id === 'clear')
    const reload = items.find((i) => i.id === 'reload-plugins')
    expect(clear?.executeOnSelect).toBe(true)
    expect(reload?.executeOnSelect).toBe(true)
  })

  it('其它命令不带 executeOnSelect', () => {
    const items = getCommonSlashSuggestionItems()
    const compact = items.find((i) => i.id === 'compact')
    expect(compact?.executeOnSelect).toBeFalsy()
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `bun test apps/web/src/components/agent/slash-command-state.test.ts`
Expected: FAIL（`executeOnSelect` undefined）

- [ ] **Step 3: 类型加字段 + 命令加标记**

在 `slash-command-state.ts`：

(a) `MentionItem` interface（约 :6-14）末尾加字段：

```typescript
export interface MentionItem {
  id: string
  label: string
  type: MentionItemType
  title?: string
  subtitle?: string
  section?: MentionSection
  meta?: string
  /** 选中即执行：不插入编辑器文本，直接触发 onCommandExecute(id) */
  executeOnSelect?: boolean
}
```

(b) `CommonSlashCommand` 类型（约 :16-18）也加上（使其能从源数据传递）：

```typescript
type CommonSlashCommand = Pick<MentionItem, 'id' | 'label' | 'type' | 'title' | 'subtitle' | 'section' | 'executeOnSelect'> & {
  keywords: string[]
}
```

(c) `COMMON_SLASH_COMMANDS` 中给 `clear`（约 :26-33）和 `reload-plugins`（约 :52-60）各加一行 `executeOnSelect: true,`。例如 clear 项改为：

```typescript
  {
    id: 'clear',
    label: 'clear',
    type: 'command',
    title: '/clear',
    subtitle: '清空当前对话上下文',
    section: 'capability',
    keywords: ['clear', 'context', 'history', '清空', '上下文'],
    executeOnSelect: true,
  },
```

`reload-plugins` 项同样加 `executeOnSelect: true,`。

> `getCommonSlashSuggestionItems` / `buildSlashSuggestionItems` 用 `{ keywords: _keywords, ...item }` 解构，会自动保留 `executeOnSelect`，无需改 map 逻辑。

- [ ] **Step 4: 运行测试，确认通过**

Run: `bun test apps/web/src/components/agent/slash-command-state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/agent/slash-command-state.ts apps/web/src/components/agent/slash-command-state.test.ts
git commit -m "✨ feat(web): slash 命令 executeOnSelect 标记"
```

---

## Task 5: web — `MentionList` 支持 `onCommandExecute`

**Files:**
- Modify: `apps/web/src/components/agent/MentionList.tsx`

- [ ] **Step 1: props 加字段**

`MentionListProps`（约 :8-13）改为：

```typescript
interface MentionListProps {
  items: MentionItem[]
  command: (item: { id: string; label: string }) => void
  trigger?: '@' | '/' | '#' | '$'
  getWorkspaceSlug?: () => string | null
  /** 选中即执行命令（executeOnSelect）时触发，替代插入 mention 文本 */
  onCommandExecute?: (id: string) => void
}
```

- [ ] **Step 2: 解构 + selectItem 分支**

函数签名解构（约 :20）加入 `onCommandExecute`：

```typescript
  function MentionList({ items, command, trigger = '/', getWorkspaceSlug, onCommandExecute }, ref) {
```

`selectItem`（约 :48-58）在 mcp 分支之后、`command(...)` 之前插入新分支：

```typescript
    const selectItem = useCallback((index: number) => {
      const item = displayItems[index]
      if (!item) return
      if (item.id === 'mcp' && item.type === 'command') {
        setPanelMode('mcp-status')
        setMcpSelectedIndex(0)
        fetchMcpData()
        return
      }
      if (item.executeOnSelect && onCommandExecute) {
        onCommandExecute(item.id)
        return
      }
      command({ id: item.id, label: item.label })
    }, [displayItems, command, fetchMcpData, onCommandExecute])
```

- [ ] **Step 3: typecheck 验证**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agent/MentionList.tsx
git commit -m "✨ feat(web): MentionList 支持 onCommandExecute 选中即执行"
```

---

## Task 6: web — `editor-mention-suggestions` 透传 `onCommandExecute`

**Files:**
- Modify: `apps/web/src/components/agent/editor-mention-suggestions.ts`

- [ ] **Step 1: `createSuggestionRenderer` 加参数**

签名（约 :95-101）改为：

```typescript
export function createSuggestionRenderer(
  trigger: string,
  threadId: string,
  char: string,
  getWorkspaceSlug: () => string | null,
  setSuggestionOpen: (open: boolean) => void,
  onCommandExecute?: (id: string) => void,
) {
```

- [ ] **Step 2: render 透传给 MentionList**

`new ReactRenderer(MentionList, { props: ... })`（约 :117-120）加入 `onCommandExecute`：

```typescript
          component = new ReactRenderer(MentionList, {
            props: { ...props, trigger: char as '@' | '/' | '#' | '$', getWorkspaceSlug, onCommandExecute },
            editor: props.editor,
          })
```

- [ ] **Step 3: typecheck 验证**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agent/editor-mention-suggestions.ts
git commit -m "✨ feat(web): suggestion 渲染器透传 onCommandExecute"
```

---

## Task 7: web — `AgentInput` 接入（核心）

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

- [ ] **Step 1: import ConfirmDialog**

在文件顶部 import 区（约 :63 附近有 `createSuggestionRenderer` import）加入：

```typescript
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
```

- [ ] **Step 2: 在 useEditor 之前定义 ref + 稳定回调**

在 `setMentionSuggestionOpen`（约 :360-362）之后、`const editor = useEditor({`（约 :364）之前插入：

```typescript
  const slashCommandExecuteRef = useRef<(id: string) => void>(() => {})
  const handleSlashCommandExecuteStable = useCallback((id: string) => {
    slashCommandExecuteRef.current(id)
  }, [])
```

> 用 ref 是因为 `useEditor` 的 extensions 仅在挂载时初始化，需稳定回调；`handleSlashCommandExecute`（依赖 editor）在 editor 之后定义，通过 ref.current 桥接，避免「定义前引用」。

- [ ] **Step 3: 把稳定回调传给 `/` suggestion**

`/` suggestion 配置（约 :378）改为：

```typescript
        suggestion: createSuggestionRenderer('/', threadId, '/', getWorkspaceSlug, setMentionSuggestionOpen, handleSlashCommandExecuteStable),
```

> `$` skill suggestion（:384）与 `@` suggestion 不变（技能仍走插入文本）。

- [ ] **Step 4: 定义 confirmState**

在组件 state 区（`const [editorText, setEditorText] = useState('')` 约 :221 附近）加入：

```typescript
  const [confirmState, setConfirmState] = useState<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    destructive: boolean
    onConfirm: () => void
  }>({ open: false, title: '', description: '', confirmLabel: '确认', destructive: false, onConfirm: () => {} })
```

> 顶部已 import `useState`（:8）；若同时需要 `React` 命名空间则用 `useState`，与 `ArchiveSettings.tsx` 范式一致。

- [ ] **Step 5: 定义 doClear（在 handleSend 之后，约 :560 附近）**

在 `handleSend`（:447）之后、`sendNowRef.current`（约 :557）之前或之后，加入：

```typescript
  const doClear = useCallback(async () => {
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.CLEAR_THREAD, { threadId })
      setRuntimeEvents((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      setStreamingStates((prev) => ({ ...prev, [threadId]: 'idle' }))
      setMessageQueues((prev) => {
        const next = { ...prev }
        delete next[threadId]
        return next
      })
      toast.success('已清空对话')
    } catch (error) {
      console.error('[AgentInput] 清空对话失败:', error)
      toast.error('清空失败')
    }
  }, [threadId, setRuntimeEvents, setStreamingStates, setMessageQueues])
```

> `setRuntimeEvents`（:207）、`setStreamingStates`（:208）、`setMessageQueues`（:209）已存在。`AGENT_IPC_CHANNELS`、`sidecarCall`、`toast` 已 import（:18 / :6）。

- [ ] **Step 6: 定义 handleSlashCommandExecute + 同步到 ref**

紧接 `doClear` 之后加入：

```typescript
  const handleSlashCommandExecute = useCallback((id: string) => {
    if (!editor) return
    if (id === 'clear') {
      editor.commands.clearContent()
      setEditorText('')
      const title = threads.find((t) => t.id === threadId)?.title ?? '当前会话'
      setConfirmState({
        open: true,
        title: '清空当前对话',
        description: `将删除当前会话「${title}」的所有消息，此操作不可撤销。`,
        confirmLabel: '清空',
        destructive: true,
        onConfirm: () => { void doClear() },
      })
      return
    }
    if (id === 'reload-plugins') {
      editor.commands.clearContent()
      setEditorText('')
      void (async () => {
        try {
          const result = await sidecarCall(AGENT_IPC_CHANNELS.RELOAD_PLUGINS, {})
          setInstalledPlugins(normalizeListPluginsResult(result))
          toast.success('插件已重新加载')
        } catch (error) {
          console.error('[AgentInput] 重载插件失败:', error)
          toast.error('重载插件失败')
        }
      })()
      return
    }
  }, [editor, threadId, threads, doClear])

  slashCommandExecuteRef.current = handleSlashCommandExecute
```

> `threads`（:201 useAtomValue）、`setInstalledPlugins`、`normalizeListPluginsResult` 已在用（见现有 reload 逻辑 :460）。最后一行在每次渲染把最新 handler 写入 ref（幂等），与项目现有 ref 用法一致。

- [ ] **Step 7: handleSend 兜底改为复用 handler**

把现有 `/reload-plugins` 拦截分支（约 :452-467）替换为同时覆盖 `/clear`：

```typescript
    // 兜底：手打 /clear 或 /reload-plugins 文本回车，走与「选中」相同的流程
    if (rawText === '/reload-plugins' || rawText === '/clear') {
      handleSlashCommandExecute(rawText.replace(/^\//, ''))
      return
    }
```

> 删除原 :455-467 的内联 reload 逻辑（已并入 handleSlashCommandExecute）。

- [ ] **Step 8: 常驻渲染 ConfirmDialog**

在主 return（约 :677）的根 `<div className="px-3 pb-4 pt-2">`（:678）内部、所有内容之后（闭合 `</div>` 之前）加入：

```typescript
      <ConfirmDialog
        open={confirmState.open}
        onOpenChange={(open) => setConfirmState((prev) => ({ ...prev, open }))}
        title={confirmState.title}
        description={confirmState.description}
        confirmLabel={confirmState.confirmLabel}
        destructive={confirmState.destructive}
        onConfirm={confirmState.onConfirm}
      />
```

> 即放在 `:679 <div className="w-full px-14">` 这一节之后，作为根 div 的直接子节点。

- [ ] **Step 9: typecheck 验证**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/agent/AgentInput.tsx
git commit -m "✨ feat(web): /clear 二次确认弹窗并接入清空会话真实行为"
```

---

## Task 8: 端到端验证

- [ ] **Step 1: 全量测试**

Run: `bun run typecheck && bun test apps/sidecar/src/services/agent/agent-thread-manager.test.ts && bun run test:web`
Expected: 全 PASS（忽略 2 个预存无关失败）

- [ ] **Step 2: 手动验证（dev 启动）**

Run: `bun run dev`（按项目惯例启动 web + desktop）

逐项验证：

1. `/clear` 选中即确认：在输入框输入 `/`，键盘/鼠标选中 `/clear` → 弹「清空当前对话」确认弹窗（红色「清空」按钮）；编辑器内**不出现** `/clear` 文本。
2. 确认清空：点「清空」→ 当前会话消息全部消失、thread 仍在（可继续输入）→ toast「已清空对话」。
3. 取消无害：再次选中 `/clear` → 点「取消」/ ESC → 不清空。
4. 运行中清空：发一条会触发 agent 运行的消息，运行中选中 `/clear` → 确认 → agent 停止 + 消息清空。
5. `/reload-plugins` 选中即执行：选中 `/reload-plugins` → 编辑器不出现文本 → toast「插件已重新加载」。
6. 手打兜底：手动键盘输入 `/clear` 回车 → 同样弹确认弹窗；输入 `/reload-plugins` 回车 → 同样重载。
7. 空会话：新会话直接 `/clear` → 确认 → 幂等无报错。

- [ ] **Step 3: 通过后无额外提交（实现已随各 Task 提交）**

---

## Self-Review

**1. Spec coverage（对照 spec 各节）：**
- 选中即执行（clear + reload-plugins）→ Task 4（标记）+ 5（selectItem 分支）+ 6（透传）+ 7（handler）✓
- `/clear` 二次确认 → Task 7 Step 4/6/8（confirmState + setConfirmState + ConfirmDialog）✓
- 后端 CLEAR_THREAD（先 stop、清消息、保留 thread、空幂等）→ Task 2（clearAgentThreadMessages 调 stopAgent + replaceAgentThreadTranscript([])）+ Task 3（handler）✓
- 手打兜底（/clear、/reload-plugins）→ Task 7 Step 7 ✓
- 重置 atom（runtimeEvents/streamingStates/messageQueue）→ Task 7 Step 5 ✓
- 文案（标题/描述/确认/红/destructive/toast）→ Task 7 Step 6 ✓
- 测试（sidecar 单测 + 现有不回归）→ Task 2 + Task 4 + Task 8 ✓

**2. Placeholder scan：** 无 TBD/TODO；所有代码 step 均含完整代码；两处运行时兜底（Task 2 Step 2 的 AgentMessage 字段、Task 7 Step 6 依赖已有变量）已注明验证方式，非占位。✓

**3. Type consistency：**
- `clearAgentThreadMessages(threadId): { ok: true; cleared: number }` — Task 2 定义，Task 3 handler 直接 return，Task 2 测试断言 `result.ok`/`result.cleared` ✓
- `onCommandExecute?: (id: string) => void` — Task 5（MentionList props）、Task 6（透传）、Task 7（handleSlashCommandExecuteStable）签名一致 ✓
- `executeOnSelect?: boolean` — Task 4（MentionItem + CommonSlashCommand）、Task 5（`item.executeOnSelect` 读取）一致 ✓
- `handleSlashCommandExecute(id: string)` — Task 7 Step 6 定义、Step 7（`rawText.replace(/^\//,'')` 传 id）、Step 3 经 ref 桥接 ✓

**4. 顺序依赖：** Task 1（channel）→ Task 2（service）→ Task 3（handler 引用 channel + service）→ Task 4（标记）→ Task 5/6/7（前端链路依赖 executeOnSelect + onCommandExecute）→ Task 8 验证。每 Task 自洽可提交。

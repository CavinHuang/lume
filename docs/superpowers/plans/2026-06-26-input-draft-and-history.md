# 输入草稿恢复 + 历史回溯 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 输入框按会话（thread）保存未发送草稿（切走/重启可恢复），并用上下键回溯已发送输入历史（每会话最多 100 条）。

**Architecture:** 双 localStorage key（`agent-input-draft` / `agent-input-history`），各由一个 `atomWithStorage` 承载，用现有 `createThreadSliceFamily`（只读 `selectAtom`）派生 per-thread 读切片，写入走 root atom + 纯函数（不可变更新、100 条裁剪）。AgentInput 接入：`onUpdate` 防抖存草稿、`useEffect[threadId]` 恢复草稿、卸载/切换时 flush、`handleSend` 入历史+清草稿、`handleKeyDown` 扩展上下键回溯。回溯与恢复用 `isNavigatingHistoryRef` 标志 + `setContent(json, false)`（不触发 onUpdate）保证程序填充不污染存盘草稿。

**Tech Stack:** React + Jotai（`atomWithStorage` / `atomFamily` / `selectAtom`）、TipTap（`editor.getJSON()` / `commands.setContent`）、`throttle-debounce`、bun:test。

**Spec:** `docs/superpowers/specs/2026-06-26-input-draft-and-history-design.md`

---

## 文件结构

| 文件 | 责任 | 动作 |
|------|------|------|
| `apps/web/src/lib/agent-input-draft-state.ts` | 类型 `AgentInputDraftJSON`（= `JSONContent`）+ 纯函数（`upsertDraft`/`removeDraft`/`prependHistory`/`removeHistory`/`isEmptyDraft`）+ `AGENT_INPUT_HISTORY_LIMIT`。无 React/jotai 依赖，被 atoms 与 components 共用 | 新建 |
| `apps/web/src/lib/agent-input-draft-state.test.ts` | 纯函数单测 | 新建 |
| `apps/web/src/atoms/agent-atoms.ts` | 新增 `agentInputDraftAtom`/`agentInputHistoryAtom`（atomWithStorage）+ 只读 family | 修改 |
| `apps/web/src/atoms/agent-atoms.test.ts` | family 读写单测（新增 describe 块） | 修改 |
| `apps/web/src/components/agent/AgentInput.tsx` | 接入草稿保存/恢复/flush、发送入历史、上下键回溯 | 修改 |
| `apps/web/src/components/settings/ArchiveSettings.tsx` | trash / permanentDelete 时清理该 thread 的草稿+历史（孤儿清理） | 修改 |

**分层约束**：`lib`（无依赖）← `atoms`（依赖 lib）← `components`（依赖 atoms/lib）。atoms 不 import components。

**测试约定**：bun:test；co-located `*.test.ts`。运行单文件：`bun test <path>`（仓库根执行）。TipTap UI 交互难自动化，故核心逻辑（纯函数、atom）走单测；AgentInput 接入层走 typecheck + 详细手动验证清单。

---

## Task 1: 纯函数工具 `agent-input-draft-state.ts`

**Files:**
- Create: `apps/web/src/lib/agent-input-draft-state.ts`
- Test: `apps/web/src/lib/agent-input-draft-state.test.ts`

- [ ] **Step 1: 写失败测试**

Create `apps/web/src/lib/agent-input-draft-state.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  AGENT_INPUT_HISTORY_LIMIT,
  isEmptyDraft,
  prependHistory,
  removeDraft,
  removeHistory,
  upsertDraft,
  type AgentInputDraftJSON,
} from './agent-input-draft-state'

const p = (text: string): AgentInputDraftJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined }],
})

describe('agent-input-draft-state', () => {
  test('upsertDraft 写入并保留其它 thread', () => {
    const state = upsertDraft({}, 't1', p('a'))
    expect(state.t1).toEqual(p('a'))
    const state2 = upsertDraft(state, 't2', p('b'))
    expect(state2.t1).toEqual(p('a'))
    expect(state2.t2).toEqual(p('b'))
  })

  test('removeDraft 仅删指定 thread，不存在时原样返回', () => {
    const state = upsertDraft(upsertDraft({}, 't1', p('a')), 't2', p('b'))
    const removed = removeDraft(state, 't1')
    expect(removed.t1).toBeUndefined()
    expect(removed.t2).toEqual(p('b'))
    expect(removeDraft(removed, 't1')).toBe(removed) // 不存在同引用
  })

  test('prependHistory 队首插入', () => {
    const state = prependHistory({}, 't1', p('a'))
    const state2 = prependHistory(state, 't1', p('b'))
    expect(state2.t1?.map((n) => n.content?.[0]?.content?.[0]?.text)).toEqual(['b', 'a'])
  })

  test('prependHistory 超过上限裁剪到 AGENT_INPUT_HISTORY_LIMIT', () => {
    let state: Record<string, AgentInputDraftJSON[]> = {}
    for (let i = 0; i < AGENT_INPUT_HISTORY_LIMIT + 5; i++) {
      state = prependHistory(state, 't1', p(`m${i}`))
    }
    expect(state.t1).toHaveLength(AGENT_INPUT_HISTORY_LIMIT)
    // 最新插入的在队首
    expect(state.t1[0].content?.[0]?.content?.[0]?.text).toBe(`m${AGENT_INPUT_HISTORY_LIMIT + 4}`)
  })

  test('prependHistory 不同 thread 互不影响', () => {
    const s1 = prependHistory({}, 't1', p('a'))
    const s2 = prependHistory(s1, 't2', p('b'))
    expect(s2.t1).toHaveLength(1)
    expect(s2.t2).toHaveLength(1)
  })

  test('removeHistory 仅删指定 thread', () => {
    const state = prependHistory(prependHistory({}, 't1', p('a')), 't2', p('b'))
    const removed = removeHistory(state, 't1')
    expect(removed.t1).toBeUndefined()
    expect(removed.t2).toHaveLength(1)
  })

  test('isEmptyDraft 判定空草稿', () => {
    expect(isEmptyDraft(undefined)).toBe(true)
    expect(isEmptyDraft(p(''))).toBe(true)
    expect(isEmptyDraft(p('   '))).toBe(true)
    expect(isEmptyDraft(p('hello'))).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/web/src/lib/agent-input-draft-state.test.ts`
Expected: FAIL — 模块不存在 / 导出未定义。

- [ ] **Step 3: 写实现**

Create `apps/web/src/lib/agent-input-draft-state.ts`:

```ts
import type { JSONContent } from '@tiptap/core'

/** 草稿/历史条目的富文本结构，即 editor.getJSON() 的返回类型。 */
export type AgentInputDraftJSON = JSONContent

/** 每个会话保留的输入历史条数上限。 */
export const AGENT_INPUT_HISTORY_LIMIT = 100

export function upsertDraft(
  state: Record<string, AgentInputDraftJSON>,
  threadId: string,
  json: AgentInputDraftJSON,
): Record<string, AgentInputDraftJSON> {
  return { ...state, [threadId]: json }
}

export function removeDraft(
  state: Record<string, AgentInputDraftJSON>,
  threadId: string,
): Record<string, AgentInputDraftJSON> {
  if (!(threadId in state)) return state
  const { [threadId]: _removed, ...rest } = state
  return rest
}

/** 在队首插入（index 0 = 最近一条），超过 limit 裁掉尾部。 */
export function prependHistory(
  state: Record<string, AgentInputDraftJSON[]>,
  threadId: string,
  json: AgentInputDraftJSON,
  limit: number = AGENT_INPUT_HISTORY_LIMIT,
): Record<string, AgentInputDraftJSON[]> {
  const current = state[threadId] ?? []
  const next = [json, ...current].slice(0, limit)
  return { ...state, [threadId]: next }
}

export function removeHistory(
  state: Record<string, AgentInputDraftJSON[]>,
  threadId: string,
): Record<string, AgentInputDraftJSON[]> {
  if (!(threadId in state)) return state
  const { [threadId]: _removed, ...rest } = state
  return rest
}

/** 递归提取节点纯文本，用于判定空草稿。 */
function extractText(node: JSONContent): string {
  let text = node.text ?? ''
  if (node.content) {
    for (const child of node.content) text += extractText(child)
  }
  return text
}

/** 是否为空草稿（无可见文本）。空草稿不入盘，避免存无意义空对象。 */
export function isEmptyDraft(json: AgentInputDraftJSON | undefined): boolean {
  if (!json) return true
  return extractText(json).trim().length === 0
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/web/src/lib/agent-input-draft-state.test.ts`
Expected: PASS（7 个 test 全过）。

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/lib/agent-input-draft-state.ts apps/web/src/lib/agent-input-draft-state.test.ts
git commit -m "✨ feat(web): 输入草稿/历史的纯函数工具（裁剪/清理/空判定）"
```

---

## Task 2: atoms — draft/history 的 atomWithStorage + 只读 family

**Files:**
- Modify: `apps/web/src/atoms/agent-atoms.ts`（末尾追加；`@/atoms` barrel 用 `export *`，新增 atom 自动导出）
- Test: `apps/web/src/atoms/agent-atoms.test.ts`（新增 describe 块；若文件不存在则新建）

- [ ] **Step 1: 写失败测试**

若 `apps/web/src/atoms/agent-atoms.test.ts` 已存在，在其末尾追加；否则新建并复用下面内容。新增 describe 块：

```ts
import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  agentInputDraftAtom,
  agentInputDraftFamily,
  agentInputHistoryAtom,
  agentInputHistoryFamily,
} from './agent-atoms'
import {
  prependHistory,
  upsertDraft,
  type AgentInputDraftJSON,
} from '@/lib/agent-input-draft-state'

const p = (text: string): AgentInputDraftJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

describe('agentInput draft/history families', () => {
  test('draft family 读切片，未写入时为 undefined', () => {
    const store = createStore()
    store.set(agentInputDraftAtom, {})
    expect(store.get(agentInputDraftFamily('t1'))).toBeUndefined()
    store.set(agentInputDraftAtom, upsertDraft(store.get(agentInputDraftAtom), 't1', p('a')))
    expect(store.get(agentInputDraftFamily('t1'))).toEqual(p('a'))
    expect(store.get(agentInputDraftFamily('t2'))).toBeUndefined()
  })

  test('history family 读切片，未写入时为 undefined', () => {
    const store = createStore()
    store.set(agentInputHistoryAtom, {})
    expect(store.get(agentInputHistoryFamily('t1'))).toBeUndefined()
    store.set(
      agentInputHistoryAtom,
      prependHistory(store.get(agentInputHistoryAtom), 't1', p('a')),
    )
    expect(store.get(agentInputHistoryFamily('t1'))).toHaveLength(1)
  })
})
```

> 若新建文件且仓库已有同名测试，注意不要重复 `import { describe, expect, test }` 与 `createStore`——合并到现有 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test apps/web/src/atoms/agent-atoms.test.ts`
Expected: FAIL — `agentInputDraftAtom` 等未导出。

- [ ] **Step 3: 写实现**

在 `apps/web/src/atoms/agent-atoms.ts` 顶部 import 区追加（`JSONContent` 类型从 TipTap 引入；纯函数从 lib 引入）：

```ts
import type { JSONContent } from '@tiptap/core'
import {
  prependHistory,
  removeDraft,
  removeHistory,
  upsertDraft,
  type AgentInputDraftJSON,
} from '@/lib/agent-input-draft-state'
```

> 注意：`agent-atoms.ts:1-4` 已有 jotai 与 shared 的 import，把上面两行并入同区。`AgentInputDraftJSON` 类型重导出供组件使用。

在文件末尾（`agentFileTreeOpenAtom` 之后）追加：

```ts
/**
 * 输入草稿 / 历史：按 threadId 分桶，落 localStorage。
 * - draft：每会话 1 份未发送草稿（富文本 JSON）。
 * - history：每会话已发送输入列表（最新在前，≤ AGENT_INPUT_HISTORY_LIMIT）。
 * 只读 family 用 createThreadSliceFamily（selectAtom）；写入走 root atom + lib 纯函数
 * （见 AgentInput / ArchiveSettings 调用方）。
 */
export type { AgentInputDraftJSON }

export const agentInputDraftAtom = atomWithStorage<Record<string, AgentInputDraftJSON>>(
  'agent-input-draft',
  {},
)
export const agentInputDraftFamily = createThreadSliceFamily(agentInputDraftAtom)

export const agentInputHistoryAtom = atomWithStorage<Record<string, AgentInputDraftJSON[]>>(
  'agent-input-history',
  {},
)
export const agentInputHistoryFamily = createThreadSliceFamily(agentInputHistoryAtom)
```

> `removeDraft` / `removeHistory` / `prependHistory` / `upsertDraft` 在 atoms 文件内未直接调用（写入发生在组件层），但 `AgentInputDraftJSON` 类型重导出在此。若 typecheck 报「未使用 import」，把 `removeDraft`/`removeHistory` 从该文件 import 中移除（组件层各自 import）；保留 `prependHistory`/`upsertDraft` 仅当本文件用到——实际本文件不用，故 atoms 文件只需 import `type AgentInputDraftJSON`，纯函数全部由组件层 import。**修正**：atoms 文件 import 仅保留：
> ```ts
> import type { JSONContent } from '@tiptap/core'
> import type { AgentInputDraftJSON } from '@/lib/agent-input-draft-state'
> ```
> （`JSONContent` 若仅用于 `AgentInputDraftJSON` 别名定义则在 lib 内用，atoms 直接用 `AgentInputDraftJSON`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test apps/web/src/atoms/agent-atoms.test.ts`
Expected: PASS。

- [ ] **Step 5: typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/atoms/agent-atoms.ts apps/web/src/atoms/agent-atoms.test.ts
git commit -m "✨ feat(web): 输入草稿/历史的 atomWithStorage + 只读 family"
```

---

## Task 3: AgentInput — 草稿实时保存 + 恢复 + flush

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

接入点：`onUpdate`（`AgentInput.tsx:419`）、新增恢复 `useEffect`、新增 flush `useEffect`、import 区（`AgentInput.tsx:21`）。

- [ ] **Step 1: 加 import 与 refs**

在 `AgentInput.tsx:21` 的 `@/atoms` import 中追加 `agentInputDraftAtom, agentInputDraftFamily`；新增一行 lib import：

```ts
import { isEmptyDraft, removeDraft, upsertDraft, type AgentInputDraftJSON } from '@/lib/agent-input-draft-state'
import { debounce } from 'throttle-debounce'
```

在组件内（`editorText` state 附近，`AgentInput.tsx:223` 之后）追加：

```ts
const draft = useAtomValue(agentInputDraftFamily(threadId))
const setDraftState = useSetAtom(agentInputDraftAtom)
const isNavigatingHistoryRef = useRef(false) // true = 当前编辑器内容由程序填充（恢复/回溯），不应存为草稿
const draftRef = useRef(draft)
draftRef.current = draft
```

- [ ] **Step 2: 草稿保存/清除/防抖工具**

在组件内（`applyEffectiveConfig` 之前或之后均可）追加：

```ts
const saveDraft = useCallback((json: AgentInputDraftJSON | undefined) => {
  setDraftState((prev) =>
    isEmptyDraft(json) ? removeDraft(prev, threadId) : upsertDraft(prev, threadId, json as AgentInputDraftJSON),
  )
}, [setDraftState, threadId])

const clearDraftState = useCallback(() => {
  setDraftState((prev) => removeDraft(prev, threadId))
}, [setDraftState, threadId])

// 防抖写草稿，避免每次按键写 localStorage
const debouncedSaveDraft = useMemo(
  () => debounce(400, (json: AgentInputDraftJSON | undefined) => saveDraft(json)),
  [saveDraft],
)
```

- [ ] **Step 3: onUpdate 接入防抖保存（短路程序填充）**

将 `AgentInput.tsx:419-421` 的 `onUpdate` 改为：

```ts
    onUpdate({ editor }) {
      setEditorText(editor.getText())
      // 程序填充（回溯/恢复）用 setContent(..., false)，不会进此回调；
      // 进此回调即用户真实输入：若处于回溯态则退出回溯，并实时存为草稿。
      if (isNavigatingHistoryRef.current) {
        isNavigatingHistoryRef.current = false
        // historyIndexRef 在 Task 5 引入；此处先不引用，回溯重置在 Task 5 完成
      }
      debouncedSaveDraft(editor.getJSON())
    },
```

> 说明：`setContent(json, false)` 的第二参数 `emitUpdate=false`，故程序填充不触发 `onUpdate`；此回调被触发即为真实输入，可安全存草稿。

- [ ] **Step 4: 草稿恢复 effect（mount / threadId 变化 / editor 就绪）**

在 `AgentInput.tsx:367`（`listAgentMessageQueue` 的 effect）之后追加：

```ts
  // 草稿恢复：threadId 变化或 editor 就绪时，把存盘草稿填回编辑器
  useEffect(() => {
    if (!editor) return
    isNavigatingHistoryRef.current = true
    const json = draftRef.current
    try {
      if (json && !isEmptyDraft(json)) {
        editor.commands.setContent(json, false)
      } else {
        editor.commands.clearContent()
      }
    } catch {
      editor.commands.clearContent()
    }
    setEditorText(editor.getText())
    // 下一 tick 解除标志，让后续真实输入正常存草稿
    queueMicrotask(() => {
      isNavigatingHistoryRef.current = false
    })
  }, [threadId, editor])
```

- [ ] **Step 5: flush effect（卸载 / threadId 变化时立即落盘）**

在 `AgentInput.tsx:660`（`cancelPendingDebouncedAgentInputSend` 的卸载 effect）附近追加：

```ts
  // 卸载或 threadId 变化时，把当前编辑器内容同步写入旧 threadId 草稿，避免防抖未触发而丢草稿
  useEffect(() => {
    return () => {
      ;(debouncedSaveDraft as unknown as { cancel?: () => void }).cancel?.()
      if (editor && !isNavigatingHistoryRef.current) {
        saveDraft(editor.getJSON())
      }
    }
    // 故意只依赖 threadId：仅在切换会话/卸载时 flush
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])
```

> `debouncedSaveDraft.cancel?.()` 借助 throttle-debounce 返回值带 `.cancel`；用可选链兼容类型。

- [ ] **Step 6: typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: 无错误（`historyIndexRef` 尚未定义没关系——Task 3 不引用它，注释里提到但未使用）。

> 若 typecheck 报 `historyIndexRef` 未定义：Task 3 注释里提到它但未使用，把注释改为「回溯重置在 Task 5 完成」即可，不要在此引用未定义符号。

- [ ] **Step 7: 手动验证**

启动 `bun run dev`，验证：
1. 在会话 A 输入「hello 草稿」（不发送）→ 切到会话 B → 切回 A：编辑器应恢复「hello 草稿」。
2. 在 A 输入后 <400ms 内快速切到 B 再切回：内容仍在（flush 生效）。
3. 完全退出 App 再打开 A：草稿仍在（localStorage 持久化）。
4. 浏览器 DevTools → Application → Local Storage：应见 `agent-input-draft` 键含 `{"<threadIdA>": {...}}`。
5. 清空编辑器（删除全部文字）：`agent-input-draft` 中该 threadId 键应被移除（空草稿不入盘）。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/agent/AgentInput.tsx
git commit -m "✨ feat(web): AgentInput 草稿实时保存/恢复/flush（按会话）"
```

---

## Task 4: AgentInput — 发送时入历史 + 清草稿

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

接入点：`handleSend` 的 `editor.commands.clearContent()`（`AgentInput.tsx:600`）。import 区追加 history atom。

- [ ] **Step 1: 加 history import 与 state**

`AgentInput.tsx:21` 的 `@/atoms` import 追加 `agentInputHistoryAtom, agentInputHistoryFamily`；lib import 追加 `prependHistory`。组件内（draft 相关 state 旁）追加：

```ts
const history = useAtomValue(agentInputHistoryFamily(threadId)) ?? []
const setHistoryState = useSetAtom(agentInputHistoryAtom)
const historyRef = useRef(history)
historyRef.current = history

const pushHistoryEntry = useCallback(
  (json: AgentInputDraftJSON) => {
    setHistoryState((prev) => prependHistory(prev, threadId, json))
  },
  [setHistoryState, threadId],
)
```

- [ ] **Step 2: handleSend 内入历史 + 清草稿**

定位 `AgentInput.tsx:599-601`：
```ts
    const createdAt = new Date().toISOString()
    editor.commands.clearContent()
    setEditorText('')
```
改为（在 `clearContent` **之前**取 JSON 入历史，之后清草稿）：
```ts
    const createdAt = new Date().toISOString()
    const sentJson = editor.getJSON()
    editor.commands.clearContent()
    setEditorText('')
    pushHistoryEntry(sentJson)
    clearDraftState()
    ;(debouncedSaveDraft as unknown as { cancel?: () => void }).cancel?.()
```

> 固定顺序：`getJSON 入历史` → `clearContent()` → `clearDraft()`。`debouncedSaveDraft.cancel()` 防止已排队的草稿写入在清空后又把空内容/旧内容写回。

- [ ] **Step 3: 把新依赖加入 handleSend 的依赖数组**

`AgentInput.tsx:644-657` 的 `useCallback` 依赖数组追加 `clearDraftState`、`pushHistoryEntry`：
```ts
  }, [
    editor,
    handleSlashCommandExecute,
    localSending,
    onClearPendingAttachments,
    pendingAttachments,
    permissionMode,
    setRuntimeEvents,
    setStreamingStates,
    setMessageQueues,
    streaming,
    thinkingLevel,
    threadId,
    clearDraftState,
    pushHistoryEntry,
  ])
```

- [ ] **Step 4: typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: 无错误。

- [ ] **Step 5: 手动验证**

`bun run dev`，验证：
1. 在 A 输入「第一条」→ 回车发送 → Local Storage 的 `agent-input-history` 出现 `{"<A>": [{...「第一条」}]}；`agent-input-draft` 中 A 的键被清除。
2. 再输入「第二条」→ 发送 → history[A] = [「第二条」, 「第一条」]（最新在前），长度 2。
3. 草稿在发送后清空（编辑器为空，draft 键不存在）。
4. 连续发送 >100 条：history[A] 长度始终 ≤ 100，最旧的被裁掉。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/agent/AgentInput.tsx
git commit -m "✨ feat(web): AgentInput 发送时入历史并清草稿"
```

---

## Task 5: AgentInput — 上下键历史回溯（不污染草稿）

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

接入点：`editorProps.handleKeyDown`（`AgentInput.tsx:407-414`）。回溯逻辑通过 ref 调用（避开 editorProps 闭包捕获旧值，参照 `sendNowRef` 模式 `AgentInput.tsx:238/658`）。

- [ ] **Step 1: 加 historyIndex ref 与导航 ref**

组件内（Task 3 的 `isNavigatingHistoryRef` 旁）追加：
```ts
const historyIndexRef = useRef(-1) // -1 = 未回溯（显示草稿）；0..n = 回溯到 history[index]
const navigateHistoryRef = useRef<(dir: 1 | -1) => void>(() => {})
const resetToDraftRef = useRef<() => void>(() => {})
```

- [ ] **Step 2: 实现导航逻辑（每 render 赋值 ref）**

在 `sendNowRef.current = ...`（`AgentInput.tsx:658`）附近追加：
```ts
  const applyContent = (json: AgentInputDraftJSON | undefined) => {
    if (!editor) return
    isNavigatingHistoryRef.current = true
    try {
      if (json && !isEmptyDraft(json)) {
        editor.commands.setContent(json, false)
      } else {
        editor.commands.clearContent()
      }
    } catch {
      editor.commands.clearContent()
    }
    setEditorText(editor.getText())
  }

  navigateHistoryRef.current = (dir) => {
    if (!editor) return
    const list = historyRef.current
    const nextIndex = historyIndexRef.current + dir
    if (nextIndex < 0) {
      historyIndexRef.current = -1
      applyContent(draftRef.current)
      return
    }
    if (nextIndex >= list.length) return // 超界不动
    historyIndexRef.current = nextIndex
    applyContent(list[nextIndex])
  }

  resetToDraftRef.current = () => {
    if (!editor) return
    historyIndexRef.current = -1
    applyContent(draftRef.current)
  }
```

- [ ] **Step 3: 扩展 handleKeyDown（↑↓ Esc）**

将 `AgentInput.tsx:407-414` 的 `handleKeyDown` 改为：
```ts
      handleKeyDown(_, event) {
        if (shouldSendAgentInputOnEnter(event, mentionSuggestionOpenRef.current)) {
          event.preventDefault()
          debouncedSend()
          return true
        }
        if (!editor) return false
        const atFirstLine = editor.state.selection.empty && editor.state.selection.$from.pos === 0
        // ↑：空框或光标在首行时回溯到更旧
        if (event.key === 'ArrowUp' && (editor.isEmpty || atFirstLine)) {
          if (historyRef.current.length > 0) {
            event.preventDefault()
            navigateHistoryRef.current(1)
            return true
          }
        }
        // ↓：回溯中则走向更新
        if (event.key === 'ArrowDown' && historyIndexRef.current >= 0) {
          event.preventDefault()
          navigateHistoryRef.current(-1)
          return true
        }
        // Esc：直接回草稿
        if (event.key === 'Escape' && historyIndexRef.current >= 0) {
          event.preventDefault()
          resetToDraftRef.current()
          return true
        }
        return false
      },
```
> 注意：`handleKeyDown` 在 `useEditor` 的 `editorProps` 内，闭包不捕获最新 React state，故全部经 `*Ref.current` 访问。`editor` 在此闭包内可用（`useEditor` 注入）。

- [ ] **Step 4: 用户真实输入时退出回溯（补全 onUpdate）**

把 Task 3 Step 3 的 `onUpdate` 中注释占位替换为真实重置（`historyIndexRef` 此时已定义）：
```ts
    onUpdate({ editor }) {
      setEditorText(editor.getText())
      if (isNavigatingHistoryRef.current) {
        isNavigatingHistoryRef.current = false
        historyIndexRef.current = -1 // 用户在回溯态手动输入 → 退出回溯
      }
      debouncedSaveDraft(editor.getJSON())
    },
```

- [ ] **Step 5: 切换会话时重置回溯索引**

在 Task 3 Step 4 的草稿恢复 effect 开头追加 `historyIndexRef.current = -1`（恢复草稿即退出回溯）：
```ts
  useEffect(() => {
    if (!editor) return
    isNavigatingHistoryRef.current = true
    historyIndexRef.current = -1
    const json = draftRef.current
    // ... 其余不变
```

- [ ] **Step 6: typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: 无错误。

- [ ] **Step 7: 手动验证（重点：不污染草稿）**

`bun run dev`，验证：
1. 在 A 发送过「历史1」「历史2」。清空编辑器，按 ↑：编辑器显示「历史2」（最近）；再按 ↑：显示「历史1」；按 ↑ 到底：不变（超界）。
2. 回溯显示「历史2」时，按 ↓：回到「历史2」→ 再 ↓：回到草稿（空）。
3. **不污染草稿**：输入草稿「我的草稿」→ 按 ↑ 回溯到「历史2」→ 不输入，按 ↓ 到底/Esc 回到草稿：编辑器恢复「我的草稿」（存盘草稿未被历史污染，DevTools 确认 `agent-input-draft` 仍是「我的草稿」）。
4. **基于历史编辑成新草稿**：回溯到「历史2」→ 手动追加「!!!」→ 此时已退出回溯 → 等待 400ms：`agent-input-draft` 变为「历史2!!!」。
5. 多行：输入两行，光标在第二行按 ↑ → 光标上移（不触发回溯）；光标移到首行按 ↑ → 触发回溯。
6. 回车发送当前回溯显示的内容：正常发送，且进入历史（重复条目可接受，spec 未要求去重）。

- [ ] **Step 8: 提交**

```bash
git add apps/web/src/components/agent/AgentInput.tsx
git commit -m "✨ feat(web): AgentInput 上下键回溯输入历史（保护草稿不被污染）"
```

---

## Task 6: 孤儿清理 — 会话 trash / 永久删除时清草稿+历史

**Files:**
- Modify: `apps/web/src/components/settings/ArchiveSettings.tsx`

> 草稿/历史存于**前端 localStorage**（sidecar 不知道），故孤儿清理必须在前端删除入口做。按 spec：**归档不清**，仅 trash / 永久删除 / 清空回收站清。接入点：`ArchiveSettings.tsx` 的 `handleTrash`（约 `:81-90`）、`handlePermanentDelete`（约 `:105-123`）；`handleEmptyTrash`（约 `:125-146`）循环调 `handlePermanentDelete`，若清理写在 permanentDelete 内则自动覆盖。

- [ ] **Step 1: 读文件确认行号**

Run: 读 `apps/web/src/components/settings/ArchiveSettings.tsx`，定位 `handleTrash`、`handlePermanentDelete`、`handleEmptyTrash`、import 区、组件签名（确认是函数组件、能加 hooks）。

- [ ] **Step 2: 加 import 与清理 hook**

在 import 区追加：
```ts
import { useCallback } from 'react'
import { useSetAtom } from 'jotai'
import { agentInputDraftAtom, agentInputHistoryAtom } from '@/atoms'
import { removeDraft, removeHistory } from '@/lib/agent-input-draft-state'
```

在组件内（hooks 区）追加：
```ts
const setDraftState = useSetAtom(agentInputDraftAtom)
const setHistoryState = useSetAtom(agentInputHistoryAtom)
const removeThreadInputState = useCallback(
  (threadId: string) => {
    setDraftState((prev) => removeDraft(prev, threadId))
    setHistoryState((prev) => removeHistory(prev, threadId))
  },
  [setDraftState, setHistoryState],
)
```

- [ ] **Step 3: 在删除成功后调用清理**

在 `handleTrash` 内 `await sidecarCall(AGENT_IPC_CHANNELS.TRASH_THREAD, ...)` 成功之后追加：
```ts
    removeThreadInputState(threadId)
```
在 `handlePermanentDelete` 内 `await sidecarCall(AGENT_IPC_CHANNELS.PERMANENTLY_DELETE_THREAD, ...)` 成功之后追加：
```ts
    removeThreadInputState(threadId)
```
> `handleEmptyTrash` 若循环调用 `handlePermanentDelete`，则已被覆盖，无需单独加；若它直接循环 `sidecarCall`，则在循环体内每个 id 调一次 `removeThreadInputState(id)`。

- [ ] **Step 4: typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: 无错误。

- [ ] **Step 5: 手动验证**

`bun run dev`，验证：
1. 会话 A 有草稿与历史。设置 → 归档设置 → 把 A 移入回收站（trash）：DevTools 中 `agent-input-draft` / `agent-input-history` 的 A 键被移除。
2. 回收站里永久删除 B：B 的草稿/历史键移除。
3. 清空回收站：所有被清会话的键移除。
4. **归档不清**：从侧栏归档（archive）一个有草稿的会话 C → C 的草稿键**仍在**（spec：归档不清）。

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/components/settings/ArchiveSettings.tsx
git commit -m "✨ feat(web): 会话 trash/永久删除时清理草稿与历史（孤儿清理）"
```

---

## Task 7: 端到端验证 + 收尾

**Files:** 无新文件。

- [ ] **Step 1: 全量 typecheck**

Run: `bun run --filter @lume/web typecheck`
Expected: 无错误。

- [ ] **Step 2: 跑相关单测**

Run: `bun test apps/web/src/lib/agent-input-draft-state.test.ts apps/web/src/atoms/agent-atoms.test.ts`
Expected: 全 PASS。

- [ ] **Step 3: 端到端手动验证（完整链路）**

`bun run dev`，按顺序验证：
1. 会话 A 输入草稿（未发）→ 切 B → 回 A：恢复。（草稿恢复）
2. 退出 App → 重开 A：恢复。（持久化）
3. A 中发送 3 条 → 上下键回溯 3 条，最新在前。（历史回溯）
4. 回溯态按 Esc / ↓ 到底回到草稿，存盘草稿不变。（不污染）
5. 把 A 移入回收站 → 草稿/历史键清除。（孤儿清理）
6. 多会话独立：A 的草稿/历史与 B 互不影响。（per-thread 隔离）
7. 单条历史富文本含 `@agent`：回溯后 @ 节点仍为可交互 mention（富文本 JSON 完整恢复）。

- [ ] **Step 4: smoke 测试（可选）**

Run: `bun run smoke:web`
Expected: 无回归。

- [ ] **Step 5: 更新 memory（若项目惯例要求）**

若 `docs/superpowers/plans/` 有进度 handoff 惯例，记录本次完成项。

---

## Self-Review（计划自检）

**Spec 覆盖**：
- §3 数据层（双 key + family）→ Task 1 + 2 ✓
- §4 接入（保存/恢复/清除/入历史）→ Task 3 + 4 ✓
- §5 上下键回溯 + 不污染草稿 → Task 5 ✓
- §6 清理（孤儿、发送清、裁剪）→ Task 4（发送清+裁剪）+ Task 6（孤儿）✓；裁剪在 Task 1 `prependHistory` ✓
- §7 边界（脏 JSON 由 atomWithStorage 默认值兜底、setContent try/catch、空草稿不入盘、配额 try/catch）→ Task 1 `isEmptyDraft`、Task 3/5 `try/catch` + `setContent(_, false)`；**localStorage 配额 try/catch 待补**（见下）
- §8 测试 → Task 1/2 单测 + Task 3-7 手动清单 ✓

**待补强（实现时注意）**：
1. **localStorage 配额**：极端情况下 `atomWithStorage` 写入可能抛 QuotaExceeded。jotai `atomWithStorage` 默认不吞该错。若需严格兜底，可在 `saveDraft`/`pushHistoryEntry` 外层包 try/catch（写失败静默，不阻塞输入）。本计划未单独列任务——若手动验证无问题可不做；保守起见在 Task 3 Step 2 的 `saveDraft` 内加 `try { setDraftState(...) } catch { /* 配额满，忽略 */ }`。
2. **TipTap 跨版本 JSON**：已用 `try/catch` + `clearContent` 回退（Task 3/5）。
3. **回溯发送重复入历史**：spec 未要求去重，保持现状（连续相同条目可接受）。

**类型一致性**：`AgentInputDraftJSON`、`upsertDraft`/`removeDraft`/`prependHistory`/`removeHistory`/`isEmptyDraft`、`agentInputDraftAtom`/`agentInputDraftFamily`/`agentInputHistoryAtom`/`agentInputHistoryFamily` 全文命名一致 ✓。

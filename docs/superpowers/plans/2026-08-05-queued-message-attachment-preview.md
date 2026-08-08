# 队列项附件行内预览 实施计划（Codex 对齐 follow-up）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给输入队列行加 Codex 式附件预览：`summarizeQueuedMessage` 多类型联合计数 + 行内 size-6 首图缩略图。

**Architecture:** `summarizeQueuedMessage` 改多类型联合（对齐 Codex `J` 函数）。首图缩略图用 **renderer 本地 `queuedAttachmentPreviewUrlAtom`**（`attachmentId → objectURL`）——不进 sidecar、不被 snapshot 覆盖；提交时从 `pendingAttachments.previewUrl` 填、删除队列项时 revoke+清。`QueuedMessageRow` 行内渲染首图。

**Tech Stack:** React 18.3.1、jotai、Tailwind、bun:test、bun@1.3.13

## Global Constraints

- **起点**：`origin/worktree-input-queue-ui-parity`（PR7 + UI 对齐）。**独立 worktree**（main 有 WIP）。基于干净分支续做。
- **不改 `packages/shared` types 与 sidecar schema**：`previewUrl` 是 renderer 瞬态（objectURL），不持久化、不进 IPC。
- **包管理器**：bun@1.3.13（非 pnpm）。
- **测试**：bun:test（非 vitest）。组件契约测试用 `renderToStaticMarkup`（SSR）。
- **文案/注释**：中文（与现有代码库一致）。
- **不主动 git 提交/推送**：worktree 内按 task 提交，最终合并由用户定。

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `apps/web/src/components/agent/agent-message-queue-summary.ts` | 队列项摘要纯函数 | 改 `summarizeQueuedMessage` 多类型联合 |
| `apps/web/src/components/agent/agent-message-queue-summary.test.ts` | 摘要测试 | 加多类型联合用例 |
| `apps/web/src/atoms/agent-atoms.ts` | 全局 atom | +`queuedAttachmentPreviewUrlAtom` |
| `apps/web/src/components/agent/AgentMessageQueueList.tsx` | 队列行 UI | `QueuedMessageRow` 行内首图 size-6 |
| `apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx` | 契约测试 | 多类型文本断言 |
| `apps/web/src/components/agent/AgentInput.tsx` | 输入框 | 提交时填 previewUrl map；删除队列项时 revoke+清 |

---

### Task 1: `summarizeQueuedMessage` 多类型联合（TDD）

**Files:**
- Modify: `apps/web/src/components/agent/agent-message-queue-summary.ts`
- Test: `apps/web/src/components/agent/agent-message-queue-summary.test.ts`

**Interfaces:**
- Produces: `summarizeQueuedMessage(item: AgentQueuedMessage): string` —— `text` 非空返回 `text`；空则多类型联合（`{fileCount} 文件 · {commentCount} 评论 · {browserCount} 浏览器注释`，仅 >0 项）；全空返回 `（空消息）`。

- [ ] **Step 1: 写失败的测试**

在 `agent-message-queue-summary.test.ts` 的 `describe('summarizeQueuedMessage', ...)` 内追加：
```ts
test('无文本 + 多类型附件 → 联合计数(· 连接)', () => {
  const item = base({
    messageAttachments: [{ id: 'f1' } as never, { id: 'f2' } as never],
    commentAttachments: [{ id: 'c1' } as never],
    browserAttachments: [{ id: 'b1' } as never],
  })
  expect(summarizeQueuedMessage(item)).toBe('2 文件 · 1 评论 · 1 浏览器注释')
})

test('无文本 + 仅评论 → 单类型计数', () => {
  const item = base({ commentAttachments: [{ id: 'c1' } as never, { id: 'c2' } as never] })
  expect(summarizeQueuedMessage(item)).toBe('2 评论')
})

test('有文本时忽略附件(只返回文本)', () => {
  const item = base({
    text: '改这里',
    messageAttachments: [{ id: 'f1' } as never],
    browserAttachments: [{ id: 'b1' } as never],
  })
  expect(summarizeQueuedMessage(item)).toBe('改这里')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && bun test src/components/agent/agent-message-queue-summary.test.ts`
Expected: FAIL —— 新「多类型联合」用例失败（旧实现只取第一个类型，返回 `'2 个文件附件'` 而非 `'2 文件 · 1 评论 · 1 浏览器注释'`）。

- [ ] **Step 3: 改实现为多类型联合**

整文件替换 `agent-message-queue-summary.ts` 的 `summarizeQueuedMessage`：
```ts
import type { AgentQueuedMessage } from '@lume/shared'

/**
 * 队列消息的可读摘要(对齐 Codex J 函数:有文本用文本;否则多类型附件联合计数)。
 * 仅用于 UI 单行展示,不参与发给模型的上下文。
 */
export function summarizeQueuedMessage(item: AgentQueuedMessage): string {
  const text = item.text?.trim() ?? ''
  if (text.length > 0) return text

  const parts: string[] = []
  const fileCount = item.messageAttachments?.length ?? 0
  const commentCount = item.commentAttachments?.length ?? 0
  const browserCount = item.browserAttachments?.length ?? 0
  if (fileCount > 0) parts.push(`${fileCount} 文件`)
  if (commentCount > 0) parts.push(`${commentCount} 评论`)
  if (browserCount > 0) parts.push(`${browserCount} 浏览器注释`)

  return parts.length > 0 ? parts.join(' · ') : '（空消息）'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && bun test src/components/agent/agent-message-queue-summary.test.ts`
Expected: PASS（新 3 用例 + 现有 4 用例都过）。

注意：现有用例 `'无文本 + 浏览器附件'` 断言 `toContain('2')` + `toContain('浏览器')`；新实现 `'1 浏览器注释'`/`'2 浏览器注释'` 仍含 `浏览器` 与计数 → 兼容。`'无文本 + 文件附件'` 断言 `toContain('文件')`；新 `'1 文件'` 含 `文件` → 兼容。若某现有用例用了对旧文案（如 `条浏览器注释`/`个文件附件`）的精确断言，更新它以匹配新文案。

- [ ] **Step 5: commit**

```
✨ feat(web): summarizeQueuedMessage 多类型附件联合计数

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 2: `queuedAttachmentPreviewUrlAtom` + 队列行首图 size-6

**Files:**
- Modify: `apps/web/src/atoms/agent-atoms.ts`（+atom）
- Modify: `apps/web/src/components/agent/AgentMessageQueueList.tsx`（首图渲染）
- Test: `apps/web/src/components/agent/AgentMessageQueueList.contract.test.tsx`

**Interfaces:**
- Produces: `queuedAttachmentPreviewUrlAtom`（`atom<Record<string, string>>`，key=attachmentId，value=objectURL）—— Task 3 填/清，Task 2 读。

- [ ] **Step 1: 加 atom**

在 `apps/web/src/atoms/agent-atoms.ts` 末尾追加（沿用现有 `atom<Record<string, T>>({})` 模式）：
```ts
/**
 * 队列项图片附件的预览 URL(renderer 本地 objectURL 映射)。
 * key = messageAttachment.id,value = objectURL。
 * 不进 sidecar/不持久化;提交时填、队列项删除时 revoke+清。刷新丢失 → 队列行降级为无缩略。
 */
export const queuedAttachmentPreviewUrlAtom = atom<Record<string, string>>({})
```
（无需 `createThreadSliceFamily`——key 是 attachmentId 而非 threadId。）

- [ ] **Step 2: `QueuedMessageRow` 行内首图**

在 `apps/web/src/components/agent/AgentMessageQueueList.tsx`：
1. 顶部 import 加：
```ts
import { useAtomValue } from 'jotai'
import { queuedAttachmentPreviewUrlAtom } from '@/atoms'
import { isImageAttachment } from './AgentAttachmentGrid'
```
2. `QueuedMessageRow` 函数体（`useSortable` 之后、return 之前）加：
```ts
const previewUrls = useAtomValue(queuedAttachmentPreviewUrlAtom)
const firstImage = item.messageAttachments?.find((a) =>
  isImageAttachment({ filename: a.filename, mediaType: a.mediaType }),
)
const firstImagePreviewUrl = firstImage ? previewUrls[firstImage.id] : undefined
```
3. 在 JSX 中，**blocked 警告图标块之后、文本 `<span>{summarizeQueuedMessage(item)}</span>` 之前**插入首图：
```tsx
{firstImagePreviewUrl && (
  <img
    src={firstImagePreviewUrl}
    alt=""
    draggable={false}
    className="size-6 shrink-0 rounded border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] object-cover"
  />
)}
```
（对齐 Codex `composer-attachment-surface size-6 shrink-0 rounded border object-cover`。）

- [ ] **Step 3: 契约测试加多类型文本断言**

在 `AgentMessageQueueList.contract.test.tsx` 的 describe 内追加（SSR 下 atom 默认空 → 不测首图，只测多类型文本）：
```ts
test('无文本多类型附件行渲染联合计数', () => {
  const html = renderToStaticMarkup(
    <AgentMessageQueueList
      snapshot={snapshotWith([{
        id: 'q-multi', text: '',
        messageAttachments: [{ id: 'f1' } as never, { id: 'f2' } as never],
        commentAttachments: [{ id: 'c1' } as never],
        browserAttachments: [{ id: 'b1' } as never],
      }])}
      onReorder={noopReorder} onRemove={() => undefined} onEdit={() => undefined} onPromoteToGuidance={() => undefined}
    />,
  )
  expect(html).toContain('2 文件 · 1 评论 · 1 浏览器注释')
})
```
（`snapshotWith` 已在测试文件定义。）

- [ ] **Step 4: 跑契约测试确认通过**

Run: `cd apps/web && bun test src/components/agent/AgentMessageQueueList.contract.test.tsx`
Expected: PASS（含新多类型用例 + 现有用例）。

注意：SSR（`renderToStaticMarkup`）下 `useAtomValue(queuedAttachmentPreviewUrlAtom)` 返回 atom 默认值 `{}` → `firstImagePreviewUrl` undefined → 不渲染 `<img>`。组件渲染不依赖外部 Provider（jotai 默认 store 兜底）。若 SSR 报 jotai 相关错，确认 `useAtomValue` 在无 Provider 时使用默认 store（jotai v2 行为，应无错）。

- [ ] **Step 5: 类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无错（`queuedAttachmentPreviewUrlAtom`、`isImageAttachment`、`firstImage` 类型一致）。

- [ ] **Step 6: commit**

```
✨ feat(web): 队列行首图缩略 + previewUrl atom(renderer 瞬态)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

### Task 3: `AgentInput` 提交填 previewUrl + 删除 revoke/清

**Files:**
- Modify: `apps/web/src/components/agent/AgentInput.tsx`

**Interfaces:**
- Consumes: `queuedAttachmentPreviewUrlAtom`（Task 2）、`isImageAttachment`（`./AgentAttachmentGrid`）
- Produces: 提交图片附件时 atom 填充；删除队列项时对应 objectURL revoke + atom 清理。

- [ ] **Step 1: 顶部 hooks 加 setter**

在 `AgentInput.tsx` 现有 `useSetAtom` hooks 区（与 `setMessageQueues`、`setQueueInterruptedStates` 同区）加：
```ts
const setQueuedAttachmentPreviewUrls = useSetAtom(queuedAttachmentPreviewUrlAtom)
```
并确保 import：`queuedAttachmentPreviewUrlAtom` 加入 `from '@/atoms'` 的具名 import；`isImageAttachment` 加 `from './AgentAttachmentGrid'`。

- [ ] **Step 2: 提交时填 previewUrl map**

定位提交处理（`messageAttachments = effectivePendingAttachments.map(...)` 构造块**之后**，约 line 1305、`for (const attachment of effectiveBrowserAttachments)` 之前）。插入：
```ts
// renderer 瞬态:把 pending 图片附件的 objectURL 存入 atom,供队列行首图缩略。
// 不进 sidecar(messageAttachment.id === pendingAttachment.id,见构造处 id: attachment.id)。
const pendingImagePreviews: Record<string, string> = {}
for (const pending of effectivePendingAttachments) {
  if (pending.previewUrl && isImageAttachment({ filename: pending.filename, mediaType: pending.mediaType })) {
    pendingImagePreviews[pending.id] = pending.previewUrl
  }
}
if (Object.keys(pendingImagePreviews).length > 0) {
  setQueuedAttachmentPreviewUrls((prev) => ({ ...prev, ...pendingImagePreviews }))
}
```

- [ ] **Step 3: 删除队列项时 revoke + 清**

定位 `handleRemoveQueuedMessage`（约 line 1535）。在现有 `removeQueuedAgentMessage({...})` 调用**之前**插入清理：
```ts
// revoke 被删队列项的图片附件 objectURL,防泄漏
const removedMessage = messageQueueSnapshot.queuedMessages.find((m) => m.id === queuedMessageId)
const removedAttachmentIds = removedMessage?.messageAttachments?.map((a) => a.id) ?? []
if (removedAttachmentIds.length > 0) {
  setQueuedAttachmentPreviewUrls((prev) => {
    for (const id of removedAttachmentIds) {
      const url = prev[id]
      if (url) URL.revokeObjectURL(url)
    }
    const next = { ...prev }
    for (const id of removedAttachmentIds) delete next[id]
    return next
  })
}
```
保留现有 `removeQueuedAgentMessage({...}).then(...).catch(...)` 不变。`useCallback` deps 加 `messageQueueSnapshot`（若未在；现有 `handleRemoveQueuedMessage` 已依赖 `messageQueueSnapshot.revision`，改为 `messageQueueSnapshot` 或确认 `.queuedMessages` 可访问——若 deps 只有 `.revision`，加 `messageQueueSnapshot.queuedMessages`）。

- [ ] **Step 4: 类型检查**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: 无错。

- [ ] **Step 5: 跑契约 + summary 测试确认无回归**

Run: `cd apps/web && bun test src/components/agent/AgentMessageQueueList.contract.test.tsx src/components/agent/agent-message-queue-summary.test.ts`
Expected: PASS。

- [ ] **Step 6: 手动验证（首图为视觉特性，SSR 测不到）**

启动 dev，构造场景：
- [ ] 输入框加一个图片附件 + 无文本 → 提交进队列 → 队列行显示 size-6 缩略图 + 「1 文件」
- [ ] 加图片 + 文本 → 提交 → 队列行缩略图 + 文本
- [ ] 加图片 + 代码评论 + 浏览器注释（无文本）→ 队列行缩略图 + 「1 文件 · 1 评论 · 1 浏览器注释」
- [ ] 删除有图片的队列项 → 缩略图消失（且 objectURL 已 revoke，devtools Memory 无泄漏）
- [ ] 刷新页面 → 队列行无缩略图（atom 丢失），但文本联合计数仍正常（降级）

- [ ] **Step 7: commit**

```
✨ feat(web): 队列附件 previewUrl 生命周期(提交填/删除 revoke)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

---

## Self-Review

**1. Spec coverage**：
- summarizeQueuedMessage 多类型联合 → Task 1 ✅
- queuedAttachmentPreviewUrlAtom（renderer 本地）→ Task 2 Step 1 ✅
- QueuedMessageRow 首图 size-6 → Task 2 Step 2 ✅
- 提交时填 → Task 3 Step 2 ✅
- 删除时 revoke+清 → Task 3 Step 3 ✅
- 刷新降级 → Task 3 Step 6 手动验证（atom 丢失→无缩略，文本联合仍可）✅
- 不改 packages/shared types / sidecar schema → Global Constraints + 实现（atom 仅 renderer）✅
- browserAttachments 截图 defer → 不在本计划（spec §2.4 defer）✅

**2. Placeholder scan**：所有 step 含实际代码；无 TBD/TODO。✅

**3. Type consistency**：
- `queuedAttachmentPreviewUrlAtom: WritableAtom<Record<string, string>, ...>` —— Task 2 定义、Task 3 `useSetAtom` ✅
- `messageAttachment.id === pendingAttachment.id`（AgentInput line 1295 `id: attachment.id`）—— Task 3 Step 2 用 `pending.id` 作 key 与 Task 2 `previewUrls[firstImage.id]` 一致 ✅
- `isImageAttachment({filename, mediaType})` —— Task 2/3 调用签名一致 ✅

## 风险与备注

- **SSR + jotai**：契约测试 `renderToStaticMarkup` 下 `useAtomValue` 用默认 store（atom={}）。jotai v2 在无 Provider 时用全局默认 store，SSR 不报错。若实际报错，最小修：契约测试包 `<JotaiProvider>`（但 jotai 默认 store 通常够）。
- **首图无自动测试**：SSR atom 空 → 契约测不到首图真值。靠 Task 3 Step 6 手动验证。`summarizeQueuedMessage` 多类型有自动测试。
- **objectURL 泄漏**：仅删除队列项时 revoke。其他场景（线程切换/清理、队列项被 sidecar 自动移除）未 revoke——属可接受边界（objectURL 随页面关闭回收）；完整生命周期 follow-up。
- **`handleRemoveQueuedMessage` deps**：现依赖 `messageQueueSnapshot.revision`；加访问 `.queuedMessages` 后确认 deps 覆盖（用 `messageQueueSnapshot` 整体或加 `.queuedMessages`）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-05-queued-message-attachment-preview.md`。（实施前需基于 `origin/worktree-input-queue-ui-parity` 开 worktree；plan/spec 文档复制进 worktree。）

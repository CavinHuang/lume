# 浏览器注释 DesignEditor 5a — 数据模型 + host 编排 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **依据**：`docs/superpowers/specs/2026-08-03-browser-annotation-design-editor-design.md`（Codex 实证）。这是 design-editor 三 sub-plan 的第一个（5a 数据/host；5b 基础 UI；5c scrub/locked/多选）。

**Goal:** 打通 design-editor 的数据层与 host 编排：declarations 逐属性类型（对齐 Codex A.6）、styleSnapshotDeclarations 捕获、store activeDesignChange 持久化、manager design 提交通路（design-overlay-update/delete/submit）、sync 字段扩展。为 5b（DesignEditor UI）提供数据与消息基础。

**Architecture:** 延续 Plan 1-4 并行重写——5a 新增数据类型 + manager design 消息分支 + sync 字段，**不动现有 popup/tweaks 在线功能、不切 preload**。overlay 仍休眠（design 消息由 overlay 触发，但 overlay 未挂载），5a 靠 happy-dom 单测验证 manager/store/sync 逻辑。

**Tech Stack:** TypeScript、bun:test + happy-dom。

## Global Constraints

1. **按 Codex 实证**（design-editor spec）：declarations `{property, value, previousValue, placeholderValue?}`；groupId === designChange.id（无独立 designGroups）；与 originalStyles/proposedStyles 并存（向后兼容，declarations 可选）。
2. **延续并行重写（零倒退）**：不切 preload（main.ts:1119 不动）；manager 新增 design 消息分支（不动现有 open-editor/popup/editor-* 分支）；overlay 休眠。
3. **declarations 可选 + 向后兼容**：AgentBrowserDesignChangeAttachment 的 declarations/groupId/text 是**新增可选字段**；现有 originalStyles/proposedStyles 保留；现有 schema/context-assembler/测试不破。
4. 仓库用 **bun**；测试 **bun:test + happy-dom**（非 vitest）；desktop 测试用 `scripts/test-electron-mock.ts` 共享 stub（Plan 4 引入，勿重引入 per-file electron mock）。
5. **无 commit 工作流**：subagent 只改工作区，task 末尾 verify（typecheck + test + build）替代 commit。
6. **代码注释中文**；**LF 行尾**。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `packages/shared/src/types/agent.ts` | `AgentBrowserDesignDeclaration` 新类型；attachment 加 declarations/groupId/text；snapshot 加 activeDesignChange | **改** |
| `apps/sidecar/src/rpc/schemas.ts` | design-change attachment schema 加 declarations 校验 | **改** |
| `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts` | declarations 拼装到 context | **改** |
| `apps/desktop/src/browser-guest-preload.ts` | `styleSnapshotDeclarations` 新函数（输出 declarations） | **改** |
| `apps/desktop/src/browser-annotation-session.ts` | `setActiveDesignChange`/`clearActiveDesignChange` 新方法 | **改** |
| `apps/desktop/src/browser-annotation-manager.ts` | onGuestMessage 加 design-overlay-update/delete/submit 分支 + `sanitizeDeclarations` | **改** |
| `apps/desktop/src/browser-overlay/guest-state.ts` | `sanitizeSync` 加 design 字段（isDesignModifierPressed/canUseTweaks/isOriginalViewEnabled/isTweaksEditorOpen/activeDesignChange）+ GuestState 类型 | **改** |

---

## Task 51: shared 类型 + schema/assembler declarations

**目标**：定义 `AgentBrowserDesignDeclaration`，attachment 加 declarations/groupId/text（可选），snapshot 加 activeDesignChange；sidecar schema 校验 declarations；context-assembler 拼装 declarations。全向后兼容。

**Files:**
- Modify: `packages/shared/src/types/agent.ts:1030-1039`（AgentBrowserDesignChangeAttachment）+ `:1010-1028`（BrowserAnnotationSessionSnapshot）
- Modify: `apps/sidecar/src/rpc/schemas.ts`（design-change schema）
- Modify: `apps/sidecar/src/services/agent-runtime/context/context-assembler.ts`
- Test: `apps/sidecar/src/rpc/schemas.agent-attachments.test.ts` + `apps/sidecar/src/services/agent-runtime/context/context-assembler.test.ts`

**Interfaces:**
- Produces: `AgentBrowserDesignDeclaration`、扩展的 `AgentBrowserDesignChangeAttachment`（declarations?/groupId?/text?）、扩展的 `BrowserAnnotationSessionSnapshot`（activeDesignChange?）

- [ ] **Step 1: shared 类型扩展**

在 `packages/shared/src/types/agent.ts`，`AgentBrowserDesignChangeAttachment`（L1030-1039）前加新类型 + 扩展 attachment：

```ts
export interface AgentBrowserDesignDeclaration {
  property: string
  value: string
  previousValue: string
  placeholderValue?: string
}

export interface AgentBrowserDesignChangeAttachment {
  id: string
  origin: 'browser-design-change'
  tab: AgentBrowserTabAttachment
  anchor: AgentBrowserAnchor
  originalStyles: Record<string, string>
  proposedStyles: Record<string, string>
  declarations?: AgentBrowserDesignDeclaration[]   // 新增（Codex A.6 对齐，逐属性）
  groupId?: string                                  // 新增（= id，Codex groupId === designChange.id）
  text?: { previousValue: string; value: string }   // 新增（文本节点编辑）
  body?: string
  screenshotRef?: string
}
```

`BrowserAnnotationSessionSnapshot`（L1010-1028）加 activeDesignChange（在 activeDraft 后）：

```ts
  activeDraft?: {
    id?: string
    anchor: AgentBrowserAnchor
    body: string
    purpose?: 'annotation' | 'tweaks'
  }
  activeDesignChange?: {                              // 新增
    id: string
    anchor: AgentBrowserAnchor
    declarations: AgentBrowserDesignDeclaration[]
    text?: { previousValue: string; value: string }
    comment?: string
  }
```

- [ ] **Step 2: schema declarations 校验**

在 `apps/sidecar/src/rpc/schemas.ts`，找到 design-change attachment schema（grep `browser-design-change` 或 `originalStyles`），加 declarations 可选校验：每项 `{property: string(<=128), value: string(<=4096), previousValue: string(<=4096), placeholderValue?: string(<=4096)}`，数组上限 64 项；groupId 可选 string(<=256)；text 可选 `{previousValue:string(<=4096), value:string(<=4096)}`。参照现有 originalStyles/proposedStyles 的 Record 校验模式。

- [ ] **Step 3: schema 测试**

在 `schemas.agent-attachments.test.ts`（已有 browser-design-change 用例 L107-138），加：design-change 带 declarations 通过校验；declarations 缺 property/value 被拒；declarations 超 64 项被拒。

- [ ] **Step 4: context-assembler declarations 拼装**

在 `context-assembler.ts`，找到 design-change 拼装（grep `browser-design-change` 或 `proposedStyles`，调查 L376-377），加 declarations 拼装到 context 文本（如 `declarations: color=#fff (was #000); font-size=16px (was 14px)`）。

- [ ] **Step 5: assembler 测试**

在 `context-assembler.test.ts`，加：design-change 带 declarations 的 context 输出含 declarations 摘要。

- [ ] **Step 6: verify**

Run: `cd apps/sidecar && bunx tsc --noEmit` + `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`（确认类型扩展不破）
Run: `cd apps/sidecar && bun test src/rpc/schemas.agent-attachments.test.ts src/services/agent-runtime/context/context-assembler.test.ts`
Expected: 全绿（既有 + 新 declarations 用例）

---

## Task 52: styleSnapshotDeclarations（guest-preload）

**目标**：guest-preload 新增 `styleSnapshotDeclarations`，从元素 computed style 输出 declarations 数组（previousValue 初始 = value）。复用 styleSnapshot 的 21 字段集。

**Files:**
- Modify: `apps/desktop/src/browser-guest-preload.ts`（L502-505 styleSnapshot 附近加新函数）
- Test: 新建 `apps/desktop/src/browser-guest-preload.declarations.test.ts` 或扩展既有 guest-preload 测试

**Interfaces:**
- Produces: `styleSnapshotDeclarations(element: Element, win: Window): AgentBrowserDesignDeclaration[]`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect } from 'bun:test'
await mock.module('electron', () => ({ ipcRenderer: { on() {}, off() {}, send() {} } }))
// 调用方式取决于 styleSnapshotDeclarations 是否 export；若 guest-preload 未 export，先在 Step 2 export

describe('styleSnapshotDeclarations', () => {
  test('输出 21 字段 declarations，previousValue === value', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'textContent', { value: 'hi' })
    // stub getComputedStyle
    const orig = window.getComputedStyle
    window.getComputedStyle = (() => ({ getPropertyValue: (k: string) => k === 'color' ? 'red' : '' })) as unknown as typeof window.getComputedStyle
    try {
      const decls = styleSnapshotDeclarations(el, window)
      expect(decls.length).toBeGreaterThan(0)
      const color = decls.find((d) => d.property === 'color')
      expect(color).toEqual({ property: 'color', value: 'red', previousValue: 'red' })
    } finally { window.getComputedStyle = orig }
  })
})
```

- [ ] **Step 2: 实现 + export**

在 `browser-guest-preload.ts` styleSnapshot（L502-505）后加：

```ts
export function styleSnapshotDeclarations(element: Element, win: Window): AgentBrowserDesignDeclaration[] {
  const computed = win.getComputedStyle(element)
  const keys = ['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'borderRadius', 'borderWidth', 'borderStyle', 'borderColor', 'width', 'height', 'display', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'rowGap', 'columnGap', 'padding', 'margin']
  const declarations: AgentBrowserDesignDeclaration[] = keys.map((property) => {
    const value = String(computed.getPropertyValue(property) || '').slice(0, 4096)
    return { property, value, previousValue: value }
  })
  const text = String(element.textContent ?? '').slice(0, 4096)
  if (text) declarations.push({ property: 'textContent', value: text, previousValue: text })
  return declarations
}
```

> 注：需 `import type { AgentBrowserDesignDeclaration } from '../../../packages/shared/src/types/agent'`（参照 guest-preload 既有 import 路径）。键集与 styleSnapshot 一致（textContent 单独处理）。

- [ ] **Step 3: 运行测试通过 + verify typecheck**

Run: `cd apps/desktop && bun test src/browser-guest-preload.declarations.test.ts` → PASS
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增错误

---

## Task 53: store activeDesignChange

**目标**：session store 加 `setActiveDesignChange`/`clearActiveDesignChange`，持久化 activeDesignChange（参照 setDraft/clearDraft 模式）。

**Files:**
- Modify: `apps/desktop/src/browser-annotation-session.ts:60-92`（setDraft/clearDraft 附近）
- Test: `apps/desktop/src/browser-annotation-session.test.ts`

**Interfaces:**
- Produces: `setActiveDesignChange(input): BrowserAnnotationSessionSnapshot`、`clearActiveDesignChange(threadId, tabId, url, generation): BrowserAnnotationSessionSnapshot`

- [ ] **Step 1: 写失败测试**

在 `browser-annotation-session.test.ts` 加：

```ts
describe('activeDesignChange', () => {
  test('setActiveDesignChange 写入 activeDesignChange + mode=comment', () => {
    const snap = store.setActiveDesignChange({ threadId: 't1', tabId: 'tab1', url: 'u', generation: 1, id: 'dc1', anchor: stubAnchor, declarations: [{property:'color', value:'red', previousValue:'blue'}] })
    expect(snap.activeDesignChange).toEqual({ id: 'dc1', anchor: stubAnchor, declarations: [{property:'color', value:'red', previousValue:'blue'}] })
    expect(snap.mode).toBe('comment')
  })
  test('clearActiveDesignChange 移除 activeDesignChange', () => {
    store.setActiveDesignChange({ threadId: 't1', tabId: 'tab1', url: 'u', generation: 1, id: 'dc1', anchor: stubAnchor, declarations: [] })
    const snap = store.clearActiveDesignChange('t1', 'tab1', 'u', 1)
    expect(snap.activeDesignChange).toBeUndefined()
  })
  test('get 透传 activeDesignChange', () => {
    store.setActiveDesignChange({ threadId: 't1', tabId: 'tab1', url: 'u', generation: 1, id: 'dc1', anchor: stubAnchor, declarations: [] })
    expect(store.get('t1', 'tab1', 'u', 1).activeDesignChange?.id).toBe('dc1')
  })
})
```

- [ ] **Step 2: 运行确认失败**（方法不存在）

- [ ] **Step 3: 实现**

在 `browser-annotation-session.ts` clearDraft（L86-92）后加：

```ts
  setActiveDesignChange(input: {
    threadId: string
    tabId: string
    url: string
    generation: number
    id: string
    anchor: AgentBrowserAnchor
    declarations: AgentBrowserDesignDeclaration[]
    text?: { previousValue: string; value: string }
    comment?: string
  }): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(input.threadId, input.tabId, input.url, input.generation)
    const next = {
      ...snapshot,
      mode: 'comment' as const,
      activeDesignChange: {
        id: input.id.slice(0, 256),
        anchor: input.anchor,
        declarations: input.declarations.slice(0, 64),
        ...(input.text ? { text: input.text } : {}),
        ...(input.comment ? { comment: input.comment.slice(0, MAX_BODY) } : {}),
      },
      updatedAt: new Date().toISOString(),
    }
    this.write(next)
    return next
  }

  clearActiveDesignChange(threadId: string, tabId: string, url: string, generation: number): BrowserAnnotationSessionSnapshot {
    const snapshot = this.get(threadId, tabId, url, generation)
    const { activeDesignChange: _activeDesignChange, ...without } = snapshot
    const next = { ...without, updatedAt: new Date().toISOString() }
    this.write(next)
    return next
  }
```

> 注：import `AgentBrowserDesignDeclaration` from shared types（参照既有 `AgentBrowserAnchor` import L3-7）。restore()（L182）需在重置时清 activeDesignChange（`activeDesignChange: undefined`）——参照 activeDraft 处理。

- [ ] **Step 4: 运行通过 + verify**

Run: `cd apps/desktop && bun test src/browser-annotation-session.test.ts` → PASS
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 54: manager design 提交通路 + sanitizeDeclarations

**目标**：manager onGuestMessage 加 design-overlay-update/delete/submit 分支，复用 store setActiveDesignChange/clearActiveDesignChange + 新 saveDesignChange（构造 designChange attachment with declarations，emit direct-submit/added）。加 sanitizeDeclarations 纯函数。

**Files:**
- Modify: `apps/desktop/src/browser-annotation-manager.ts`（onGuestMessage L166-189 editor 分支后加 design 分支 + sanitizeDeclarations 函数 + saveDesignChange 方法）
- Test: `apps/desktop/src/browser-annotation-manager.test.ts`

**Interfaces:**
- Produces: onGuestMessage 处理 `{type:'design-overlay-update'|'design-overlay-delete'|'design-submit'}`；`sanitizeDeclarations(raw): AgentBrowserDesignDeclaration[]`

- [ ] **Step 1: 写失败测试**

在 `browser-annotation-manager.test.ts` 加（参照 Task 43 manager 测试 mock 模式：mock electron + real store + temp configDir + recording emit）：

```ts
describe('manager design 消息', () => {
  test('design-overlay-update：store activeDesignChange + syncGuest + emitSnapshot', () => {
    manager.onGuestMessage(tab, { type: 'design-overlay-update', tabId, generation, threadId, group: { id: 'dc1', anchor, declarations: [{property:'color', value:'red', previousValue:'blue'}] } })
    expect(manager.store.get(threadId, tabId, url, gen).activeDesignChange?.id).toBe('dc1')
    // emitSnapshot 发了 browser:annotation-state
  })
  test('design-overlay-delete：clearActiveDesignChange', () => {
    manager.onGuestMessage(tab, { type: 'design-overlay-delete', tabId, generation, threadId, groupId: 'dc1' })
    expect(manager.store.get(...).activeDesignChange).toBeUndefined()
  })
  test('design-submit：saveDesignChange attachment(declarations) + emit direct-submit/added', () => {
    // 预设 activeDesignChange
    manager.onGuestMessage(tab, { type: 'design-overlay-update', ... group: { id:'dc1', anchor, declarations:[{property:'color',value:'red',previousValue:'blue'}] } })
    manager.onGuestMessage(tab, { type: 'design-submit', tabId, generation, threadId, action: 'send', body: '改色' })
    // 断言 emit 'browser:annotation-direct-submit' with attachment.declarations + body
    // activeDesignChange 清空（提交后）
  })
  test('sanitizeDeclarations：过滤非法 property/value，截断', () => {
    expect(sanitizeDeclarations([{property:'color', value:'red', previousValue:'blue'}, {property:'bad prop', value:'x', previousValue:'y'}, {property:'ok', value:'v'}])).toEqual([{property:'color', value:'red', previousValue:'blue'}])
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 sanitizeDeclarations + saveDesignChange + onGuestMessage 分支**

在 `browser-annotation-manager.ts`：

(1) sanitizeStyles（L511-514）附近加 sanitizeDeclarations：

```ts
function sanitizeDeclarations(value: unknown): AgentBrowserDesignDeclaration[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.property === 'string' && typeof item.value === 'string' && typeof item.previousValue === 'string' && /^[a-zA-Z][a-zA-Z0-9-]{0,127}$/.test(item.property))
    .slice(0, 64)
    .map((item) => ({
      property: item.property as string,
      value: (item.value as string).slice(0, 4096),
      previousValue: (item.previousValue as string).slice(0, 4096),
      ...(typeof item.placeholderValue === 'string' ? { placeholderValue: (item.placeholderValue as string).slice(0, 4096) } : {}),
    }))
}
```

(2) saveAttachment（L419-436）附近加 saveDesignChange（复用 attachment 构造模式）：

```ts
private saveDesignChange(tab: AnnotationRuntimeTab, threadId: string, groupId: string | undefined, anchor: AgentBrowserAnchor, declarations: AgentBrowserDesignDeclaration[], body: string): { attachment: AgentBrowserDesignChangeAttachment; snapshot: BrowserAnnotationSessionSnapshot } {
  const session = this.store.get(threadId, tab.tabId, tab.url, tab.generation)
  const id = groupId ?? `browser-design-change:${randomUUID()}`
  const attachment: AgentBrowserDesignChangeAttachment = {
    id,
    origin: 'browser-design-change',
    tab: { /* 同 saveAttachment L425 的 tab 构造 */ },
    anchor,
    originalStyles: Object.fromEntries(declarations.map((d) => [d.property, d.previousValue])),
    proposedStyles: Object.fromEntries(declarations.map((d) => [d.property, d.value])),
    declarations,
    groupId: id,
    ...(body ? { body: body.slice(0, 20_000) } : {}),
    ...(session.theme ? { theme: session.theme } : {}),
    createdAt: new Date().toISOString(),
  }
  const snapshot = this.store.saveComment(attachment as unknown as AgentBrowserAnnotationAttachment)
  this.store.clearActiveDesignChange(threadId, tab.tabId, tab.url, tab.generation)
  this.syncGuest(tab, snapshot)
  this.emitSnapshot(snapshot)
  return { attachment, snapshot }
}
```

> 注：saveComment 接受 AgentBrowserAnnotationAttachment；design-change 是 union 成员。可能需调整 saveComment 签名或在 saveDesignChange 内联写 store（参照 saveComment L94-105）。实施时按 store 实际签名处理（store.saveComment 当前参数 AgentBrowserAnnotationAttachment；design-change 是不同 origin——可能需 store 加 saveDesignChange 或 saveComment 泛化）。**实施时确认 store.saveComment 是否接受 design-change**，若不接受则 store 加专用方法（Task 53 已加 activeDesignChange；saveComment 可泛化为 saveAttachment）。

(3) onGuestMessage editor 分支（Plan 4 L166-189）后加 design 分支：

```ts
    if (payload.type === 'design-overlay-update') {
      const group = isRecord(payload.group) ? payload.group : undefined
      if (!group || typeof group.id !== 'string' || !isRecord(group.anchor) || !Array.isArray(group.declarations)) return
      const anchor = sanitizeAnchor(group.anchor as Record<string, unknown>, tab.url, tab.generation)
      if (!anchor) return
      const snapshot = this.store.setActiveDesignChange({ threadId: payload.threadId, tabId: tab.tabId, url: tab.url, generation: tab.generation, id: group.id, anchor, declarations: sanitizeDeclarations(group.declarations), ...(isRecord(group.text) ? { text: group.text as { previousValue: string; value: string } } : {}), ...(typeof group.comment === 'string' ? { comment: group.comment } : {}) })
      this.syncGuest(tab, snapshot)
      this.emitSnapshot(snapshot)
      return
    }
    if (payload.type === 'design-overlay-delete') {
      const snapshot = this.store.clearActiveDesignChange(payload.threadId, tab.tabId, tab.url, tab.generation)
      this.syncGuest(tab, snapshot)
      this.emitSnapshot(snapshot)
      return
    }
    if (payload.type === 'design-submit') {
      const action = payload.action === 'send' ? 'send' : 'add'
      const body = text(payload.body, 20_000)
      const session = this.store.get(payload.threadId, tab.tabId, tab.url, tab.generation)
      const draft = session.activeDesignChange
      if (!draft) return
      const saved = this.saveDesignChange(tab, payload.threadId, draft.id, draft.anchor, draft.declarations, body)
      this.options.emit(action === 'send' ? 'browser:annotation-direct-submit' : 'browser:annotation-added', { threadId: payload.threadId, tabId: tab.tabId, attachment: saved.attachment, snapshot: saved.snapshot })
      return
    }
```

> 注：AnnotationGuestPayload 类型加 `group?`/`groupId?`/`action?` 字段（参照 Plan 4 加 action? 模式）。

- [ ] **Step 4: 运行通过 + verify**

Run: `cd apps/desktop && bun test src/browser-annotation-manager.test.ts` → PASS（design 分支 + sanitizeDeclarations）
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 55: sync 字段扩展（guest-state sanitizeSync + syncGuest）

**目标**：guest-state sanitizeSync 加 design 字段（isDesignModifierPressed/canUseTweaks/isOriginalViewEnabled/isTweaksEditorOpen/activeDesignChange）+ GuestState 类型扩展；manager syncGuest 推送 activeDesignChange。

**Files:**
- Modify: `apps/desktop/src/browser-overlay/guest-state.ts`（sanitizeSync + GuestState 类型）
- Modify: `apps/desktop/src/browser-annotation-manager.ts`（syncGuest 推送 activeDesignChange）
- Test: `apps/desktop/src/browser-overlay/guest-state.test.ts`

**Interfaces:**
- Produces: GuestState 加 `isDesignModifierPressed?`/`canUseTweaks?`/`isOriginalViewEnabled?`/`isTweaksEditorOpen?`/`activeDesignChange?`；sanitizeSync 解析这些字段

- [ ] **Step 1: 写失败测试**

在 `guest-state.test.ts` 加：

```ts
describe('sanitizeSync - design 字段', () => {
  test('activeDesignChange 透传（对象）', () => {
    const r = sanitizeSync({ ...validBase, mode:'comment', activeDesignChange: { id:'dc1', anchor:{...}, declarations:[] } })
    expect(r?.activeDesignChange).toEqual({ id:'dc1', anchor:{...}, declarations:[] })
  })
  test('activeDesignChange 非 object 省略', () => {
    expect(sanitizeSync({ ...validBase, activeDesignChange: 'x' })?.activeDesignChange).toBeUndefined()
  })
  test('boolean design 字段默认/透传', () => {
    expect(sanitizeSync({ ...validBase, isDesignModifierPressed: true, canUseTweaks: true })?.isDesignModifierPressed).toBe(true)
    expect(sanitizeSync(validBase)?.isDesignModifierPressed).toBeUndefined()
    expect(sanitizeSync({ ...validBase, canUseTweaks: true })?.canUseTweaks).toBe(true)
  })
  test('isOriginalViewEnabled / isTweaksEditorOpen 透传', () => {
    expect(sanitizeSync({ ...validBase, isOriginalViewEnabled: true, isTweaksEditorOpen: false })?.isOriginalViewEnabled).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 扩展 GuestState 类型 + sanitizeSync**

在 `guest-state.ts`：

```ts
export type GuestState = {
  tabId: string
  generation: number
  threadId: string
  mode: 'browse' | 'comment'
  purpose: 'annotation' | 'tweaks'
  theme?: string
  comments: GuestComment[]
  activeDraft?: Record<string, unknown>
  // 新增 design 字段（对齐 Codex sync A.5）
  isDesignModifierPressed?: boolean
  canUseTweaks?: boolean
  isOriginalViewEnabled?: boolean
  isTweaksEditorOpen?: boolean
  activeDesignChange?: Record<string, unknown>
}
```

sanitizeSync return 加（在 activeDraft 后）：

```ts
    ...(typeof m.isDesignModifierPressed === 'boolean' ? { isDesignModifierPressed: m.isDesignModifierPressed } : {}),
    ...(typeof m.canUseTweaks === 'boolean' ? { canUseTweaks: m.canUseTweaks } : {}),
    ...(typeof m.isOriginalViewEnabled === 'boolean' ? { isOriginalViewEnabled: m.isOriginalViewEnabled } : {}),
    ...(typeof m.isTweaksEditorOpen === 'boolean' ? { isTweaksEditorOpen: m.isTweaksEditorOpen } : {}),
    ...(isRecord(m.activeDesignChange) ? { activeDesignChange: m.activeDesignChange } : {}),
```

- [ ] **Step 4: manager syncGuest 推送 activeDesignChange**

在 `browser-annotation-manager.ts` syncGuest（参照调查 L268-277），在 activeDraft 推送后加 activeDesignChange：

```ts
    ...(snapshot.activeDesignChange?.anchor.url === tab.url ? { activeDesignChange: snapshot.activeDesignChange } : {}),
```

- [ ] **Step 5: 运行通过 + verify**

Run: `cd apps/desktop && bun test src/browser-overlay/guest-state.test.ts` → PASS
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 56: 整合验证

**目标**：全量 typecheck + build + test，确认 5a 数据层 + host 编排就位，零倒退（main.ts:1119 不动、popup/editor 分支不动、既有测试绿）。

**Files:** 无新改（验证）

- [ ] **Step 1: 全量测试**

Run: `cd apps/desktop && bun test`
Expected: 全绿（browser-overlay 含新 sanitizeSync design 字段 + manager design 分支 + session activeDesignChange；既有不破；1 pre-existing electron-security fail 保留）

Run: `cd apps/sidecar && bun test src/rpc/schemas.agent-attachments.test.ts src/services/agent-runtime/context/context-assembler.test.ts`
Expected: declarations 用例绿

- [ ] **Step 2: typecheck**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` + `cd apps/sidecar && bunx tsc --noEmit`
Expected: 仅 2 pre-existing sdk baseline，无新增

- [ ] **Step 3: build**

Run: `cd apps/desktop && bun ./scripts/build.ts`
Expected: overlay preload 打包成功（bundle 与 Plan 4 持平，5a 不改 overlay 组件）

- [ ] **Step 4: 零倒退确认**

核对：main.ts:1119 仍 browser-guest-preload.cjs；manager open-editor/popup/editor-* 分支未动；overlay preload 休眠。

---

## 完成判据（5a 收尾）

1. declarations 类型（shared）+ schema/assembler 校验/拼装就位，向后兼容。
2. styleSnapshotDeclarations（guest-preload）输出 declarations。
3. store setActiveDesignChange/clearActiveDesignChange 持久化。
4. manager onGuestMessage 处理 design-overlay-update/delete/submit（复用 store，emit direct-submit/added）。
5. sync 字段扩展（sanitizeSync + syncGuest activeDesignChange）。
6. 零倒退：main.ts:1119 不动、popup/editor 分支不动、既有测试绿。
7. typecheck 干净、build 成功。
8. 无 commit；ledger 更新 5a 进度。

## Self-Review

**1. Spec 覆盖**（对照 design-editor spec §5a）：
- shared declarations + attachment + snapshot：Task 51 ✓
- schema/assembler declarations：Task 51 ✓
- styleSnapshotDeclarations：Task 52 ✓
- store activeDesignChange：Task 53 ✓
- manager design 消息（update/delete/submit）+ sanitizeDeclarations：Task 54 ✓
- sync 字段（sanitizeSync + syncGuest）：Task 55 ✓
- 未覆盖（5b/5c 范围）：scrub-changed/set-design-modifier-pressed/set-original-view-enabled 的具体交互处理（5a 仅打通 update/delete/submit 数据通路；scrub/modifier/original-view 是 5b/5c 交互层）。

**2. 占位符扫描**：Task 54 saveDesignChange 的 store.saveComment 兼容性标注"实施时确认"（store.saveComment 当前签名 AgentBrowserAnnotationAttachment，design-change 是 union 成员——可能需泛化或专用方法）。这是实施时需落实的点，非永久占位。

**3. 类型一致性**：`AgentBrowserDesignDeclaration` 在 Task 51 定义，Task 52/53/54 引用同一类型；`activeDesignChange` 在 snapshot（Task 51）+ store（Task 53）+ manager（Task 54）+ sanitizeSync（Task 55）结构一致。

**4. 向后兼容**：所有新增字段可选（declarations?/groupId?/text?/activeDesignChange?/sync design 字段），现有 originalStyles/proposedStyles/activeDraft/popup/editor 分支不动。

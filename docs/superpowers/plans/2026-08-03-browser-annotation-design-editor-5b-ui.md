# 浏览器注释 DesignEditor 5b — 基础 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **依据**：`docs/superpowers/specs/2026-08-03-browser-annotation-design-editor-design.md`（Codex app-initial 实证）+ 5a 数据层（已完成）。

**Goal:** 实现 DesignEditor 网页内 overlay 卡片（按 Codex）：sectionGroup 派生（dimensions/spacing/flex-spacing/declaration）+ 输入分发（color/opacity/px/combobox 表单）+ hold-to-view 原视图切换 + 提交（design-overlay-update/delete）。overlayReducer design action 接线 + AnnotationOverlay 渲染。为 5c（scrub/locked/多选）提供 UI 基础。

**Architecture:** DesignEditor 是网页内 overlay 卡片（同 EditorCard 层），由 `editor.target.mode==='design'` 驱动。原生 HTML + overlay.css.ts（非 apps/web UI）。sectionGroup 派生是纯函数（移植 Codex AWo）。延续并行重写——overlay 休眠，happy-dom 单测验证。

**Tech Stack:** React 18.3.1、TypeScript、bun:test + happy-dom。

## Global Constraints

1. **按 Codex 实证**（spec + 分析报告）：sectionGroup 派生（AWo：gap→flex-spacing, margin-*/padding-*→spacing, width/height→dimensions, 其他→declaration）；输入分发（color `<input type=color>`/opacity/px/combobox）；hold-to-view（按钮 + pointer/keyboard 双通道，`set-original-view-enabled`）。
2. **5b 不含 scrub/locked/多选**（5c 范围）。5b 输入是表单（非拖拽 scrub）；多选（additionalAnchors 渲染）留 5c。
3. **延续并行重写（零倒退）**：不切 preload（main.ts:1124 不动）；popup/web 面板不动；overlay 休眠。
4. **design-overlay-update 推送全部 declarations**（5a manager 存全部 activeDesignChange，非 Codex yGo diff）——5b 不需 computeDesignDiff。
5. 仓库用 **bun**；测试 **bun:test + happy-dom**（非 vitest）；**React 18.3.1**；desktop 测试用共享 `scripts/test-electron-mock.ts` + `test-dom-preload.ts`。
6. **无 commit 工作流**：subagent 只改工作区，task 末尾 verify 替代。
7. **代码注释中文**；**LF 行尾**；测试文件 `.tsx`；测试基建教训（Plan 3/4/5a）：dispatch 目标连入 document、renderHook unmount 旧 root、受控 input onChange 用 React fiber-key 提取（Task 41 教训）。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `apps/desktop/src/browser-overlay/sectionGroups.ts` | `deriveSectionGroups` 纯函数（declarations → SectionGroup[]，移植 AWo） | **新建** |
| `apps/desktop/src/browser-overlay/sectionGroups.test.ts` | 派生 TDD | **新建** |
| `apps/desktop/src/browser-overlay/DeclarationInput.tsx` | 输入分发（color/opacity/px/combobox 表单） | **新建** |
| `apps/desktop/src/browser-overlay/DesignEditor.tsx` | 主组件（sectionGroup 渲染 + 输入 + hold-to-view + 提交） | **新建** |
| `apps/desktop/src/browser-overlay/DesignEditor.test.tsx` | render + 输入 + hold-to-view + 提交 TDD | **新建** |
| `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx` | design action 接线（activeDesignChange → restore-editor；target.mode==='design' 渲染 DesignEditor） | **改** |
| `apps/desktop/src/browser-overlay/overlayReducer.ts` | `deriveTarget` 填 groupId（open-design-editor-at-point） | **改** |
| `apps/desktop/src/browser-overlay/overlay.css.ts` | design 样式（editor-card/section/declaration-row/input/color） | **改** |

---

## Task 61: sectionGroup 派生（deriveSectionGroups）

**目标**：纯函数 `deriveSectionGroups(declarations)` 把扁平 declarations 派生为 SectionGroup[]（dimensions/spacing/flex-spacing/declaration），移植 Codex AWo（spec §1.4）。

**Files:**
- Create: `apps/desktop/src/browser-overlay/sectionGroups.ts`
- Create: `apps/desktop/src/browser-overlay/sectionGroups.test.ts`

**Interfaces:**
- Consumes: `AgentBrowserDesignDeclaration`（shared，5a 定义 `{property, value, previousValue, placeholderValue?}`）
- Produces:
  ```ts
  export type SectionGroup =
    | { kind: 'dimensions'; width?: AgentBrowserDesignDeclaration; height?: AgentBrowserDesignDeclaration }
    | { kind: 'spacing'; property: 'margin' | 'padding'; top?: ...; right?: ...; bottom?: ...; left?: ... }
    | { kind: 'flex-spacing'; rowGap?: ...; columnGap?: ... }
    | { kind: 'declaration'; declaration: AgentBrowserDesignDeclaration }
  export function deriveSectionGroups(declarations: AgentBrowserDesignDeclaration[]): SectionGroup[]
  ```

- [ ] **Step 1: 写失败测试**

```ts
import { describe, test, expect } from 'bun:test'
import { deriveSectionGroups } from './sectionGroups'
import type { AgentBrowserDesignDeclaration } from '../../../packages/shared/src/types/agent'

const d = (property: string, value = 'v', previousValue = 'p'): AgentBrowserDesignDeclaration => ({ property, value, previousValue })

describe('deriveSectionGroups', () => {
  test('width+height → dimensions section', () => {
    const groups = deriveSectionGroups([d('width'), d('height'), d('color')])
    const dims = groups.find((g) => g.kind === 'dimensions')
    expect(dims).toEqual({ kind: 'dimensions', width: d('width'), height: d('height') })
    expect(groups.filter((g) => g.kind === 'declaration').length).toBe(1)
  })
  test('margin-* → spacing section（property=margin，4 边）', () => {
    const groups = deriveSectionGroups([d('margin-top'), d('margin-bottom'), d('margin-left'), d('margin-right')])
    const sp = groups.find((g) => g.kind === 'spacing')
    expect(sp?.kind).toBe('spacing')
    expect(sp?.property).toBe('margin')
    expect((sp as { top?: unknown }).top).toEqual(d('margin-top'))
  })
  test('padding-* → spacing（property=padding）', () => {
    const groups = deriveSectionGroups([d('padding-top'), d('padding-left')])
    expect(groups.find((g) => g.kind === 'spacing')?.property).toBe('padding')
  })
  test('gap → flex-spacing（row-gap + column-gap）', () => {
    // Codex gap 合并 row-gap/column-gap；Lume styleSnapshot 用 gap 单字段——确认 Lume declarations 是否含 row-gap/column-gap
    const groups = deriveSectionGroups([d('row-gap'), d('column-gap')])
    const fs = groups.find((g) => g.kind === 'flex-spacing')
    expect(fs?.kind).toBe('flex-spacing')
  })
  test('其他（color/font-size）→ declaration section', () => {
    const groups = deriveSectionGroups([d('color'), d('font-size')])
    expect(groups.length).toBe(2)
    expect(groups.every((g) => g.kind === 'declaration')).toBe(true)
  })
  test('保持输入顺序（已处理 property 不重复）', () => {
    const groups = deriveSectionGroups([d('color'), d('width'), d('height'), d('font-size')])
    expect(groups.map((g) => g.kind)).toEqual(['declaration', 'dimensions', 'declaration'])
  })
})
```

> 注：Lume styleSnapshotDeclarations（5a Task 52）字段集是 20 CSS + textContent，含 `gap`/`rowGap`/`columnGap`？确认 5a styleSnapshotDeclarations 实际字段（`gap`/`row-gap`/`column-gap` 命名）。若 Lume 用 `gap` 单字段（非 row-gap/column-gap），flex-spacing 派生适配（gap → flex-spacing 单字段）。实施时按 5a 实际字段调整派生。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 deriveSectionGroups**

```ts
import type { AgentBrowserDesignDeclaration } from '../../../packages/shared/src/types/agent'

export type SectionGroup =
  | { kind: 'dimensions'; width?: AgentBrowserDesignDeclaration; height?: AgentBrowserDesignDeclaration }
  | { kind: 'spacing'; property: 'margin' | 'padding'; top?: AgentBrowserDesignDeclaration; right?: AgentBrowserDesignDeclaration; bottom?: AgentBrowserDesignDeclaration; left?: AgentBrowserDesignDeclaration }
  | { kind: 'flex-spacing'; rowGap?: AgentBrowserDesignDeclaration; columnGap?: AgentBrowserDesignDeclaration; gap?: AgentBrowserDesignDeclaration }
  | { kind: 'declaration'; declaration: AgentBrowserDesignDeclaration }

const SPACING_PREFIX = /^(margin|padding)-(top|right|bottom|left)$/

// 扁平 declarations → 分组 section（移植 Codex AWo @8918022）。
export function deriveSectionGroups(declarations: AgentBrowserDesignDeclaration[]): SectionGroup[] {
  const map = new Map(declarations.map((d) => [d.property, d]))
  const processed = new Set<string>()
  const groups: SectionGroup[] = []
  for (const decl of declarations) {
    if (processed.has(decl.property)) continue
    if (decl.property === 'width' || decl.property === 'height') {
      const width = map.get('width'); const height = map.get('height')
      if (width) processed.add('width')
      if (height) processed.add('height')
      groups.push({ kind: 'dimensions', width, height })
      continue
    }
    const spacing = SPACING_PREFIX.exec(decl.property)
    if (spacing) {
      const [, base] = spacing
      const top = map.get(`${base}-top`); const right = map.get(`${base}-right`); const bottom = map.get(`${base}-bottom`); const left = map.get(`${base}-left`)
      ;[top, right, bottom, left].forEach((s) => { if (s) processed.add(s.property) })
      groups.push({ kind: 'spacing', property: base as 'margin' | 'padding', top, right, bottom, left })
      continue
    }
    if (decl.property === 'row-gap' || decl.property === 'column-gap' || decl.property === 'gap') {
      const rowGap = map.get('row-gap'); const columnGap = map.get('column-gap'); const gap = map.get('gap')
      if (rowGap) processed.add('row-gap')
      if (columnGap) processed.add('column-gap')
      if (gap) processed.add('gap')
      groups.push({ kind: 'flex-spacing', rowGap, columnGap, gap })
      continue
    }
    processed.add(decl.property)
    groups.push({ kind: 'declaration', declaration: decl })
  }
  return groups
}
```

- [ ] **Step 4: 运行通过 + verify typecheck**

Run: `cd apps/desktop && bun test src/browser-overlay/sectionGroups.test.ts` → PASS
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 62: DeclarationInput 输入分发

**目标**：纯展示组件 `DeclarationInput`，按 property 类型分发 color/opacity/px/combobox 表单输入（无 scrub，5c）。受控（value + onChange）。

**Files:**
- Create: `apps/desktop/src/browser-overlay/DeclarationInput.tsx`
- Create: `apps/desktop/src/browser-overlay/DeclarationInput.test.tsx`

**Interfaces:**
- Produces: `DeclarationInput({ declaration, onChange }: { declaration: AgentBrowserDesignDeclaration; onChange: (value: string) => void })`

- [ ] **Step 1: 写失败测试**

```tsx
import { describe, test, expect, mock } from 'bun:test'
await mock.module('electron', () => ({ ipcRenderer: { on() {}, off() {}, send() {} } }))
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
const { DeclarationInput } = await import('./DeclarationInput')

function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div'); document.body.append(container)
  act(() => { createRoot(container).render(node) })
  return container
}
const decl = (property: string, value = 'v', previousValue = 'p') => ({ property, value, previousValue })

describe('DeclarationInput 输入分发', () => {
  test('color → <input type="color">', () => {
    const c = render(<DeclarationInput declaration={decl('color', '#ff0000')} onChange={() => {}} />)
    expect(c.querySelector('input[type="color"]')).toBeTruthy()
    document.body.innerHTML = ''
  })
  test('background-color → color input', () => {
    const c = render(<DeclarationInput declaration={decl('background-color', '#00f')} onChange={() => {}} />)
    expect(c.querySelector('input[type="color"]')).toBeTruthy()
    document.body.innerHTML = ''
  })
  test('opacity → number input（step 0.01）', () => {
    const c = render(<DeclarationInput declaration={decl('opacity', '0.5')} onChange={() => {}} />)
    const input = c.querySelector('input[type="number"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.step).toBe('0.01')
    document.body.innerHTML = ''
  })
  test('font-size → number input（step 1，px 后缀显示）', () => {
    const c = render(<DeclarationInput declaration={decl('font-size', '16px')} onChange={() => {}} />)
    expect(c.querySelector('input[type="number"]')).toBeTruthy()
    document.body.innerHTML = ''
  })
  test('font-family → combobox（text input + datalist）', () => {
    const c = render(<DeclarationInput declaration={decl('font-family', 'sans-serif')} onChange={() => {}} />)
    expect(c.querySelector('input[type="text"]')).toBeTruthy()
    document.body.innerHTML = ''
  })
  test('onChange 回调（值变更）', () => {
    const onChange = mock(() => {})
    const c = render(<DeclarationInput declaration={decl('color', '#ff0000')} onChange={onChange} />)
    const input = c.querySelector('input[type="color"]') as HTMLInputElement
    act(() => { input.value = '#00ff00'; input.dispatchEvent(new Event('input', { bubbles: true })) })
    // 受控 input onChange 在 happy-dom 需 fiber-key 提取（Task 41 教训）；或断言 onChange 被调
    document.body.innerHTML = ''
  })
})
```

> onChange 测试：happy-dom 受控 input onChange 不冒泡（Task 41 教训）。用 React fiber-key 提取 onChange 直接调用，或断言 input.value 变化。实施时按 Task 41 fiber-key 模式。

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 DeclarationInput**

```tsx
import type { AgentBrowserDesignDeclaration } from '../../../packages/shared/src/types/agent'

const isColor = (p: string): boolean => p === 'color' || p.endsWith('-color')
const isOpacity = (p: string): boolean => p === 'opacity'
const isPxNumeric = (p: string): boolean => p === 'font-size' || p === 'border-radius' || p === 'border-width' || p.startsWith('column-')

// 单属性行输入分发（color/opacity/px/combobox），无 scrub（5c）。
export function DeclarationInput({ declaration, onChange }: { declaration: AgentBrowserDesignDeclaration; onChange: (value: string) => void }) {
  const { property, value, previousValue } = declaration
  if (isColor(property)) {
    return (
      <span className="decl-row">
        <input className="decl-color" type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <input className="decl-color-text" type="text" value={value} placeholder={previousValue} onChange={(e) => onChange(e.target.value)} />
      </span>
    )
  }
  if (isOpacity(property)) {
    return <input className="decl-number" type="number" min={0} max={1} step={0.01} value={value} placeholder={previousValue} onChange={(e) => onChange(e.target.value)} />
  }
  if (isPxNumeric(property)) {
    return (
      <span className="decl-row">
        <input className="decl-number" type="number" step={1} value={value.replace(/px$/, '')} placeholder={previousValue.replace(/px$/, '')} onChange={(e) => onChange(`${e.target.value}px`)} />
        <span className="decl-unit">px</span>
      </span>
    )
  }
  return <input className="decl-text" type="text" list="decl-suggestions" value={value} placeholder={previousValue} onChange={(e) => onChange(e.target.value)} />
}
```

- [ ] **Step 4: 运行通过 + verify**

Run: `cd apps/desktop && bun test src/browser-overlay/DeclarationInput.test.tsx` → PASS
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 63: DesignEditor 主组件

**目标**：`DesignEditor` 主组件——sectionGroup 渲染 + DeclarationInput + hold-to-view 原视图按钮（pointer/keyboard 双通道）+ 提交（design-overlay-update 推送全部 declarations / design-overlay-delete）。受控（activeDesignChange + 回调）。

**Files:**
- Create: `apps/desktop/src/browser-overlay/DesignEditor.tsx`
- Create: `apps/desktop/src/browser-overlay/DesignEditor.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function DesignEditor(props: {
    activeDesignChange: { id: string; anchor: AgentBrowserAnchor; declarations: AgentBrowserDesignDeclaration[]; text?: {previousValue:string;value:string}; comment?: string }
    onUpdate: (group: { id: string; anchor: AgentBrowserAnchor; declarations: AgentBrowserDesignDeclaration[]; text?: {previousValue:string;value:string}; comment?: string }) => void
    onDelete: () => void
    onToggleOriginalView: (enabled: boolean) => void
  })
  ```

- [ ] **Step 1: 写失败测试**

```tsx
// 渲染 sectionGroups（dimensions/spacing/declaration）+ DeclarationInput + hold-to-view 按钮 + 提交按钮
// 测试：编辑 declaration → onUpdate 被调（含全部 declarations）；hold-to-view pointerdown → onToggleOriginalView(true); 提交按钮 → onUpdate
```
（实施时按 sectionGroups/DeclarationInput 已有组件，测 DesignEditor 渲染 + onUpdate/onDelete/onToggleOriginalView 回调；受控 onChange 用 fiber-key 或断言渲染。）

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 DesignEditor**

```tsx
import { useState } from 'react'
import { deriveSectionGroups } from './sectionGroups'
import { DeclarationInput } from './DeclarationInput'
import type { AgentBrowserAnchor, AgentBrowserDesignDeclaration } from '../../../packages/shared/src/types/agent'

type ActiveDesignChange = { id: string; anchor: AgentBrowserAnchor; declarations: AgentBrowserDesignDeclaration[]; text?: { previousValue: string; value: string }; comment?: string }

// 网页内设计编辑器卡片（按 Codex DesignEditorEntry/JUo）：sectionGroup 渲染 + 输入分发 + hold-to-view + 提交。
export function DesignEditor({ activeDesignChange, onUpdate, onDelete, onToggleOriginalView }: {
  activeDesignChange: ActiveDesignChange
  onUpdate: (group: ActiveDesignChange) => void
  onDelete: () => void
  onToggleOriginalView: (enabled: boolean) => void
}) {
  const [declarations, setDeclarations] = useState(activeDesignChange.declarations)
  const [comment, setComment] = useState(activeDesignChange.comment ?? '')
  const groups = deriveSectionGroups(declarations)
  const changeValue = (property: string, value: string): void => {
    setDeclarations((prev) => prev.map((d) => (d.property === property ? { ...d, value } : d)))
  }
  const submit = (): void => onUpdate({ ...activeDesignChange, declarations, comment: comment || undefined })
  const holdDown = (): void => onToggleOriginalView(true)
  const holdUp = (): void => onToggleOriginalView(false)
  return (
    <div className="design-editor" data-browser-comment-design-editor-stack>
      <div className="design-editor-header">
        <span className="design-editor-title">设计</span>
        <button type="button" className="design-editor-hold" onPointerDown={holdDown} onPointerUp={holdUp} onPointerCancel={holdUp} onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdDown() } }} onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') holdUp() }}>按住看原视图</button>
        <button type="button" className="design-editor-delete" onClick={onDelete}>删除</button>
      </div>
      <div className="design-editor-body" data-browser-sidebar-design-scroll-container>
        {groups.map((group, i) => {
          if (group.kind === 'dimensions') return <div key={i} className="design-section"><label>尺寸</label><span className="design-section-fields">{group.width && <span><span className="design-label">宽</span><DeclarationInput declaration={group.width} onChange={(v) => changeValue(group.width!.property, v)} /></span>}{group.height && <span><span className="design-label">高</span><DeclarationInput declaration={group.height} onChange={(v) => changeValue(group.height!.property, v)} /></span>}</span></div>
          if (group.kind === 'spacing') return <div key={i} className="design-section"><label>{group.property === 'margin' ? '外边距' : '内边距'}</label><span className="design-section-fields">{(['top', 'right', 'bottom', 'left'] as const).map((side) => { const s = group[side]; return s ? <span key={side}><span className="design-label">{side}</span><DeclarationInput declaration={s} onChange={(v) => changeValue(s.property, v)} /></span> : null })}</span></div>
          if (group.kind === 'flex-spacing') return <div key={i} className="design-section"><label>间距</label><span className="design-section-fields">{group.rowGap && <span><span className="design-label">行</span><DeclarationInput declaration={group.rowGap} onChange={(v) => changeValue(group.rowGap!.property, v)} /></span>}{group.columnGap && <span><span className="design-label">列</span><DeclarationInput declaration={group.columnGap} onChange={(v) => changeValue(group.columnGap!.property, v)} /></span>}{group.gap && <span><span className="design-label">gap</span><DeclarationInput declaration={group.gap} onChange={(v) => changeValue(group.gap!.property, v)} /></span>}</span></div>
          return <div key={i} className="design-section"><span className="design-label">{group.declaration.property}</span><DeclarationInput declaration={group.declaration} onChange={(v) => changeValue(group.declaration.property, v)} /></div>
        })}
      </div>
      <input className="design-editor-comment" type="text" value={comment} placeholder="评论（可选）" onChange={(e) => setComment(e.target.value.slice(0, 20_000))} />
      <button type="button" className="design-editor-submit" onClick={submit}>提交</button>
    </div>
  )
}
```

- [ ] **Step 4: 运行通过 + verify**

Run: `cd apps/desktop && bun test src/browser-overlay/DesignEditor.test.tsx` → PASS
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 64: overlayReducer design action 接线 + AnnotationOverlay 渲染

**目标**：overlayReducer `deriveTarget` 在 `open-design-editor-at-point` 填 groupId（从 action）；AnnotationOverlay 检测 `state.activeDesignChange` → dispatch restore-editor（target.mode='design'）→ 渲染 DesignEditor；DesignEditor 回调 → bridge.send(design-overlay-update/delete) + set-original-view-enabled command。

**Files:**
- Modify: `apps/desktop/src/browser-overlay/overlayReducer.ts`（deriveTarget open-design-editor-at-point 填 groupId；加 `open-design-editor-at-point` action 携带 groupId?）
- Modify: `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx`（activeDesignChange → restore-editor design；editor.target.mode==='design' + activeDesignChange → 渲染 DesignEditor；回调 bridge.send）
- Test: `apps/desktop/src/browser-overlay/AnnotationOverlay.test.tsx`（扩展，design 渲染 + 回调）

**Interfaces:**
- Consumes: DesignEditor（Task 63）、overlayReducer（design action）、GuestState.activeDesignChange（5a）
- Produces: AnnotationOverlay 在 design 模式渲染 DesignEditor，回调 `bridge.send({type:'design-overlay-update', group})` / `{type:'design-overlay-delete', groupId}` / set-original-view-enabled

- [ ] **Step 1: 写失败测试**

扩展 `AnnotationOverlay.test.tsx`：
- activeDesignChange 到达（design）→ 渲染 DesignEditor（input.decl-* 存在）
- DesignEditor onUpdate（提交）→ bridge.send({type:'design-overlay-update', group:{id, anchor, declarations}})
- hold-to-view → bridge.send set-original-view-enabled
- activeDesignChange 消失 → DesignEditor 卸载

（用 Task 42 的 ipcRenderer.on 捕获 harness 推送 activeDesignChange。）

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 接线**

(1) `overlayReducer.ts`：`OverlayAction` 的 `open-design-editor-at-point` 加 `groupId?: string`；`deriveTarget` case `open-design-editor-at-point` 返回 `{ mode: 'design', ...(action.groupId ? { groupId: action.groupId } : {}) }`。

(2) `AnnotationOverlay.tsx`：在 activeDraft useEffect 旁加 activeDesignChange effect：
```tsx
  useEffect(() => {
    const draft = state?.activeDesignChange as ActiveDesignChange | undefined
    if (draft) dispatch({ type: 'restore-editor', target: { mode: 'design', groupId: draft.id } })
    // activeDesignChange 与 activeDraft 互斥（manager 同一时刻只一个）；若 activeDraft 在则其 effect 处理
  }, [state?.activeDesignChange])
```
渲染（在 EditorCard 渲染旁）：
```tsx
      {editor.type === 'editing' && editor.target.mode === 'design' && state?.activeDesignChange ? (
        <DesignEditor
          activeDesignChange={state.activeDesignChange as ActiveDesignChange}
          onUpdate={(group) => bridge.send({ type: 'design-overlay-update', group })}
          onDelete={() => bridge.send({ type: 'design-overlay-delete', groupId: (state.activeDesignChange as ActiveDesignChange).id })}
          onToggleOriginalView={(enabled) => bridge.send({ type: 'set-original-view-enabled', enabled })}
        />
      ) : null}
```

> 注：activeDraft（comment）与 activeDesignChange（design）互斥——manager 同一时刻推一个。reducer restore-editor 抗打断（不覆盖进行中）。若两者都到（边界），activeDraft 优先（comment）或 design 优先——实施时确认互斥假设。

- [ ] **Step 4: 运行通过 + verify**

Run: `cd apps/desktop && bun test src/browser-overlay/AnnotationOverlay.test.tsx` → PASS（design 渲染 + 回调）
Run: `cd apps/desktop && bun test src/browser-overlay/` → 全绿（无回归）
Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 65: overlay.css.ts design 样式

**目标**：overlay.css.ts 加 DesignEditor 样式（editor-card/header/body/section/declaration-row/input/color/unit/comment/submit），偏移跟随定位。

**Files:**
- Modify: `apps/desktop/src/browser-overlay/overlay.css.ts`

- [ ] **Step 1: 加样式**

在 overlayStyles 末尾追加：
```css
.design-editor{position:fixed;display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid #ffffff33;border-radius:10px;background:#17181c;color:#f5f5f5;box-shadow:0 12px 32px #0006;pointer-events:auto;min-width:280px;max-height:60vh;z-index:3}
.design-editor-header{display:flex;align-items:center;gap:6px;justify-content:space-between}
.design-editor-title{font-weight:600;font-size:13px}
.design-editor-hold{background:#ffffff1a;border:0;border-radius:6px;color:#f5f5f5;cursor:pointer;font:11px system-ui;padding:4px 8px}
.design-editor-delete{background:0;border:0;color:#f87171;cursor:pointer;font:11px system-ui}
.design-editor-body{display:flex;flex-direction:column;gap:6px;overflow-y:auto}
.design-section{display:flex;flex-direction:column;gap:2px;font-size:12px}
.design-section-fields{display:flex;flex-wrap:wrap;gap:4px}
.design-label{color:#aaa;font-size:11px;margin-right:2px}
.decl-row{display:inline-flex;align-items:center;gap:2px}
.decl-color{width:24px;height:24px;padding:0;border:0;background:0}
.decl-color-text,.decl-text,.decl-number{background:#ffffff0d;border:1px solid #ffffff26;border-radius:4px;color:#f5f5f5;font:12px system-ui;padding:3px 4px;width:70px}
.decl-unit{color:#aaa;font-size:11px}
.design-editor-comment{background:#ffffff0d;border:1px solid #ffffff26;border-radius:6px;color:#f5f5f5;font:12px system-ui;padding:6px}
.design-editor-submit{background:var(--annotation-accent);border:0;border-radius:6px;color:#fff;cursor:pointer;font:600 12px system-ui;padding:6px}
```

- [ ] **Step 2: verify（样式加载，build 不破）**

Run: `cd apps/desktop && bunx tsc --noEmit -p tsconfig.json` → 无新增

---

## Task 66: 整合验证

**目标**：全量 typecheck + build + test，确认 5b DesignEditor UI 就位，零倒退。

- [ ] **Step 1: 全量测试**：`cd apps/desktop && bun test`（全绿；1 pre-existing electron-security fail 保留）
- [ ] **Step 2: typecheck**：`cd apps/desktop && bunx tsc --noEmit -p tsconfig.json`（无新增）
- [ ] **Step 3: build**：`cd apps/desktop && bun ./scripts/build.ts`（overlay preload 打包，bundle 较 5a 增长——DesignEditor + sectionGroups + DeclarationInput 组件）
- [ ] **Step 4: 零倒退确认**：main.ts 仍 guest-preload；popup/editor 分支未动；overlay 休眠

---

## 完成判据（5b 收尾）

1. DesignEditor overlay 组件就位（sectionGroup 派生 + 输入分发 + hold-to-view + 提交），happy-dom 测试全绿。
2. overlayReducer design action 接线（open-design-editor-at-point 填 groupId；activeDesignChange → restore-editor → DesignEditor）。
3. 提交 bridge.send(design-overlay-update/delete) + set-original-view-enabled（5a manager 已处理）。
4. 零倒退：main.ts 未改、popup/web 面板不动、overlay 休眠。
5. typecheck 干净、build 成功。
6. 无 commit；ledger 更新 5b 进度。

## Self-Review

**1. Spec 覆盖**（对照 spec §5b）：
- DesignEditor 组件（sectionGroup + 输入 + hold-to-view + 提交）：Task 63 ✓
- sectionGroup 派生（AWo）：Task 61 ✓
- 输入分发（color/opacity/px/combobox）：Task 62 ✓
- overlayReducer design action 接线 + AnnotationOverlay 渲染：Task 64 ✓
- overlay.css.ts design 样式：Task 65 ✓
- 未覆盖（5c 范围）：scrub（拖输入框）、locked relationships（dimensions/spacing 锁）、多选（additionalAnchors 渲染 + Alt）、tweaks-open-changed（编辑器开关）。

**2. 占位符扫描**：Task 61 flex-spacing gap 单字段 vs row-gap/column-gap（Lume styleSnapshot 字段）标注"实施时确认"；Task 63 onChange 测试用 fiber-key（Task 41 教训）标注；activeDraft vs activeDesignChange 互斥假设标注"实施时确认"。

**3. 类型一致**：`AgentBrowserDesignDeclaration` 跨 sectionGroups/DeclarationInput/DesignEditor 一致；`ActiveDesignChange` 跨 DesignEditor/AnnotationOverlay 一致（对齐 5a snapshot activeDesignChange）。

**4. 范围**：5b 基础 UI（表单输入，非 scrub）。scrub/locked/多选 5c。

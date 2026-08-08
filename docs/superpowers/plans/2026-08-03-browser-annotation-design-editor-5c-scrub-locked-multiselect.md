# 浏览器注释 DesignEditor 5c — scrub + locked + 多选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **依据**：`docs/superpowers/specs/2026-08-03-browser-annotation-design-editor-design.md`（Codex app-initial 实证，§1.2 scrub gWo + §1.4 locked + §1.3 多选 host）。5a（数据/host）+ 5b（基础 UI）已完成。

**Goal:** 完成 design-editor Codex 交互：scrub（拖 number input 垂直调值，非 Alt）+ locked relationships（dimensions 比例锁/spacing 对边锁/peer 高亮）+ Alt 多选（host 管理 additionalAnchors + overlay 渲染/移除）+ manager 交互命令（design-scrub-changed/set-design-modifier-pressed/set-original-view-enabled/tweaks-open-changed，5a 延期到此）。

**Architecture:** scrub 在 DeclarationInput 扩展（number input onPointerDown 拖拽）；locked 在 DesignEditor（锁联动 bWo）；多选 host 在 manager（set-design-modifier-pressed + additionalAnchors），overlay 渲染 annotationSelectionAnchors。延续并行重写——overlay 休眠，happy-dom 单测验证。

**Tech Stack:** React 18.3.1、TypeScript、bun:test + happy-dom。

## Global Constraints

1. **按 Codex 实证**（spec + 分析报告）：
   - **scrub（gWo @8904954）**：number input onPointerDown（type==='number' && scrubStep && button===0 && isPrimary && pointerType!=='touch'）→ 垂直拖拽（startY-currentY，上=增下=减）→ 4px 阈值/步长（hGo=gGo=4）→ clamp（XWo min/max）→ 格式化（YWo 2 位小数）→ body 锁定（cursor ns-resize SVG + userSelect none + overscrollBehavior none + scrollContainer overflowY hidden）→ pointerUp 还原。消息 `design-scrub-changed{property}`（仅激活信号，结束不发）。**与 Alt 无关**。
   - **locked（bWo）**：dimensions 比例锁（width:height）+ spacing 对边锁（top⇄bottom / left⇄right）+ 联动批量更新两 declaration。peer 高亮（拖 peer 锁定属性时两 cell 高亮，data-scrub-value-cell + peer-property）。
   - **多选（host 管理，§1.3）**：Alt+click 添加元素到组（host set-design-modifier-pressed + additionalAnchors）；overlay 仅渲染 annotationSelectionAnchors + 移除（remove-annotation-selection）。groupId === designChange.id。
2. **5c 含 manager 交互命令**（5a 延期）：onGuestMessage 加 design-scrub-changed/set-design-modifier-pressed/set-original-view-enabled/tweaks-open-changed 处理 + store 状态 + syncGuest 推送。
3. **延续并行重写（零倒退）**：不切 preload（main.ts 不动）；popup/web 面板不动；overlay 休眠。
4. 仓库用 **bun**；测试 **bun:test + happy-dom**；**React 18.3.1**；共享 `test-electron-mock.ts` + `test-dom-preload.ts`。
5. **无 commit 工作流**；**中文注释**；**LF**；测试 `.tsx`；测试教训（fiber-key onChange/pointer、dispatch 连入 document、renderHook unmount）。
6. **属性命名 camelCase**（5a snapshot + 5b 一致）。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `apps/desktop/src/browser-overlay/DeclarationInput.tsx` | number input 加 scrub（拖拽 + body 锁定 + design-scrub-changed） | **改** |
| `apps/desktop/src/browser-overlay/useScrub.ts` | scrub hook（拖拽逻辑 + clamp + 格式化 + body 锁定） | **新建** |
| `apps/desktop/src/browser-overlay/DesignEditor.tsx` | locked relationships（dimensions/spacing 锁联动 bWo）+ peer 高亮 + annotationSelectionAnchors 渲染 | **改** |
| `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx` | annotationSelectionAnchors 透传 DesignEditor | **改** |
| `apps/desktop/src/browser-annotation-manager.ts` | onGuestMessage 加 4 交互命令（scrub-changed/modifier/original-view/tweaks-open）+ store 状态 + syncGuest | **改** |
| `apps/desktop/src/browser-annotation-session.ts` | store 加 design 交互状态（isDesignModifierPressed/isOriginalViewEnabled/isTweaksEditorOpen） | **改** |
| `apps/desktop/src/browser-overlay/overlay.css.ts` | scrub 光标 + peer 高亮 + lock 按钮 样式 | **改** |

---

## Task 71: manager 交互命令 + store 状态

**目标**：manager onGuestMessage 加 4 交互命令（design-scrub-changed/set-design-modifier-pressed/set-original-view-enabled/tweaks-open-changed）+ store 加 design 交互状态字段（isDesignModifierPressed/isOriginalViewEnabled/isTweaksEditorOpen）+ syncGuest 推送。

**Files:**
- Modify: `apps/desktop/src/browser-annotation-session.ts`（加 design 交互状态字段 + setter）
- Modify: `apps/desktop/src/browser-annotation-manager.ts`（onGuestMessage 4 命令 + syncGuest）
- Test: `apps/desktop/src/browser-annotation-manager.test.ts`

- [ ] **Step 1: store 加 design 交互状态**

session.ts snapshot（已在 5a Task 51 加 activeDesignChange）旁加（可选字段）：
```ts
isDesignModifierPressed?: boolean
isOriginalViewEnabled?: boolean
isTweaksEditorOpen?: boolean
```
+ setter `setDesignFlags(input: { threadId; tabId; url; generation; isDesignModifierPressed?; isOriginalViewEnabled?; isTweaksEditorOpen? }): snapshot`（合并到当前 snapshot，参照 setMode 模式）。

- [ ] **Step 2: manager onGuestMessage 4 命令**

```ts
    if (payload.type === 'design-scrub-changed') {
      // scrub 激活信号（property 非空）/结束（null）；manager 仅记状态/转发，不存 declarations（declarations 在 activeDesignChange）
      // 5c 简化：manager 不处理 scrub 实时值（overlay 本地状态），仅可选记 isScrubbing
      return
    }
    if (payload.type === 'set-design-modifier-pressed') {
      const snapshot = this.store.setDesignFlags({ threadId: payload.threadId, tabId: tab.tabId, url: tab.url, generation: tab.generation, isDesignModifierPressed: payload.pressed === true })
      this.syncGuest(tab, snapshot); this.emitSnapshot(snapshot); return
    }
    if (payload.type === 'set-original-view-enabled') {
      const snapshot = this.store.setDesignFlags({ threadId: payload.threadId, tabId: tab.tabId, url: tab.url, generation: tab.generation, isOriginalViewEnabled: payload.enabled === true })
      this.syncGuest(tab, snapshot); this.emitSnapshot(snapshot); return
    }
    if (payload.type === 'tweaks-open-changed') {
      const snapshot = this.store.setDesignFlags({ threadId: payload.threadId, tabId: tab.tabId, url: tab.url, generation: tab.generation, isTweaksEditorOpen: payload.open === true })
      this.syncGuest(tab, snapshot); this.emitSnapshot(snapshot); return
    }
```

> AnnotationGuestPayload 加 pressed?/enabled?/open? 字段。design-scrub-changed 5c 简化为 no-op（overlay 本地 scrub 状态，manager 不存实时值——对齐 Codex scrub 结束不发消息）。

- [ ] **Step 3: syncGuest 推送 design flags**

syncGuest（5a）加 isDesignModifierPressed/isOriginalViewEnabled/isTweaksEditorOpen（条件推送，参照 theme 模式）。

- [ ] **Step 4: 测试 + verify**

测 4 命令（set-design-modifier-pressed → store isDesignModifierPressed + syncGuest；set-original-view-enabled；tweaks-open-changed；design-scrub-changed no-op）。manager test pass + typecheck no NEW。

---

## Task 72: scrub 交互（useScrub hook + DeclarationInput）

**目标**：useScrub hook（number input 拖拽：垂直 4px clamp 格式化 + body 锁定 + onScrub 回调）+ DeclarationInput number input 集成 scrub。

**Files:**
- Create: `apps/desktop/src/browser-overlay/useScrub.ts`
- Modify: `apps/desktop/src/browser-overlay/DeclarationInput.tsx`（number input 集成 useScrub）
- Test: `useScrub.test.ts` + `DeclarationInput.test.tsx`（scrub）

- [ ] **Step 1: useScrub hook**

```ts
// scrub 拖拽 number input（对齐 Codex gWo @8904954）：垂直，4px 阈值/步长，clamp，格式化 2 位小数，body 锁定。
export function useScrub(opts: {
  value: number
  min?: number
  max?: number
  step: number
  onChange: (value: number) => void
  onScrubActive?: (active: boolean) => void
}): {
  onPointerDown: (e: React.PointerEvent) => void
  scrubbing: boolean
}
```
实现：onPointerDown（条件：button===0 && isPrimary && pointerType!=='touch'）→ setPointerCapture + 记 startY/startValue + body 锁定（cursor ns-resize + userSelect none）+ onPointerMove（delta = trunc((startY-currentY)/4)，clamp，格式化，onChange）+ onPointerUp（还原 body + onScrubActive(false)）。4px 阈值（delta===0 不触发直到移动 4px）。

- [ ] **Step 2: DeclarationInput number input 集成**

opacity/px number input 用 useScrub（受控 value + scrub onChange）。

- [ ] **Step 3: 测试 + verify**

useScrub test（拖拽 mock pointer event + 断言 onChange 值/clamp/格式化；body 锁定；4px 阈值）。DeclarationInput scrub 集成。fiber-key pointer 测试（happy-dom 无 PointerEvent，fiber-key 取 onPointerDown）。

---

## Task 73: locked relationships + peer 高亮

**目标**：DesignEditor 加 locked relationships（dimensions 比例锁 width:height + spacing 对边锁 top⇄bottom/left⇄right，联动 bWo 更新两 declaration）+ scrub peer 高亮（拖 peer 锁定属性时两 cell 高亮 data-scrub-value-cell）。

**Files:**
- Modify: `apps/desktop/src/browser-overlay/DesignEditor.tsx`（locked 状态 + 锁联动 + peer 高亮）
- Modify: `apps/desktop/src/browser-overlay/overlay.css.ts`（peer 高亮 + lock 按钮 样式）
- Test: `DesignEditor.test.tsx`（locked）

- [ ] **Step 1: locked 状态 + 联动**

DesignEditor 加 lockedRelationships state（dimensions 比例锁 + spacing 对边锁键）。changeValue 扩展：若锁开启，同步更新 peer declaration（bWo 批量）。

- [ ] **Step 2: peer 高亮**

scrub 一个属性时，若该属性有 peer（如 paddingTop ⇄ paddingBottom），高亮两 cell（data-scrub-value-cell + data-peer）。

- [ ] **Step 3: 测试 + verify**

locked test（锁 dimensions，改 width → height 按比例；锁 spacing top⇄bottom，改 top → bottom 同步；peer 高亮）。

---

## Task 74: Alt 多选（host + overlay 渲染）

**目标**：Alt 多选——overlay（useAnnotationInteraction）监听 Alt + click 添加 anchor 到组（bridge.send set-design-modifier-pressed + design-overlay-update additionalAnchors）；manager（5a/71 set-design-modifier-pressed）+ store additionalAnchors；AnnotationOverlay annotationSelectionAnchors 渲染 + remove（bridge.send remove-annotation-selection）。

**Files:**
- Modify: `apps/desktop/src/browser-overlay/useAnnotationInteraction.ts`（Alt 监听 + click 添加 additionalAnchor）
- Modify: `apps/desktop/src/browser-overlay/DesignEditor.tsx`（annotationSelectionAnchors 渲染 + onRemove）
- Modify: `apps/desktop/src/browser-overlay/AnnotationOverlay.tsx`（additionalAnchors 透传）
- Modify: `apps/desktop/src/browser-annotation-manager.ts`（onGuestMessage remove-annotation-selection + store additionalAnchors）
- Test: 各

- [ ] **Step 1: overlay Alt + click 添加**

useAnnotationInteraction：Alt 按下（key down/up）→ set-design-modifier-pressed（bridge.send）。design 模式 + Alt + click 元素 → buildAnchor + bridge.send design-overlay-update additionalAnchors（追加）。

- [ ] **Step 2: DesignEditor annotationSelectionAnchors 渲染**

activeDesignChange.additionalAnchors 渲染列表 + onRemove（bridge.send remove-annotation-selection{selectionIndex}）。

- [ ] **Step 3: manager remove-annotation-selection**

onGuestMessage 加 remove-annotation-selection → store 从 activeDesignChange.additionalAnchors 移除指定 index。

- [ ] **Step 4: 测试 + verify**

Alt+click 添加 additionalAnchor；remove-annotation-selection 移除；渲染。

---

## Task 75: 整合验证

- [ ] 全量 typecheck + build + test + 零倒退确认（main.ts/popup/overlay 休眠）
- [ ] design-editor 5a/5b/5c 全功能回顾（declarations + DesignEditor + scrub + locked + 多选）

---

## 完成判据（5c 收尾 = design-editor 完成）

1. scrub（拖 number input 垂直 4px clamp 格式化 body 锁定 design-scrub-changed）+ peer 高亮。
2. locked（dimensions 比例 + spacing 对边 + 联动）。
3. Alt 多选（host additionalAnchors + overlay 渲染/remove）。
4. manager 交互命令（scrub-changed/modifier/original-view/tweaks-open）+ store 状态。
5. 零倒退 + typecheck/build/test 绿。
6. 无 commit；ledger 更新 5c + design-editor 完成。

## Self-Review

**1. Spec 覆盖**（spec §5c）：scrub（gWo）Task 72 ✓；locked（bWo）Task 73 ✓；多选 host Task 74 ✓；manager 交互命令 Task 71 ✓。
**2. 占位符**：Task 71 design-scrub-changed 简化 no-op（对齐 Codex 结束不发）标注；fiber-key pointer 测试标注。
**3. 类型一致**：useScrub/locked/multiselect 用 5a declarations + 5b DesignEditor 类型。
**4. 范围**：5c 是 design-editor 最后 sub-plan（scrub/locked/多选 + 交互命令）。完成后 design-editor 全功能（待 Plan 8 切 preload 真机）。

# 浏览器注释 Preload 合并 + 退役 + 全量回归 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task.
> **依据**：调查报告（overlay vs guest preload 功能差距 + 退役清单 + auth 纠错）+ spec §7/§8/§10。
> **架构决策（用户拍板）**：B 变体——保留 guest-preload 作入口（不切 main.ts:1124），React AnnotationOverlay 渲染搬入 guest，保留 syncFrames iframe 骨架，退役原生 DOM 渲染 + popup 全链路。

**Goal:** 完成 browser-annotation 架构收尾：guest-preload 合并 React overlay 渲染（.tsx 改造）+ 保留 iframe syncFrames 骨架 + 退役原生 DOM 渲染层 + 退役 popup 全链路 + open-editor 改 setDraft/syncGuest + 退役 overlay-preload + anchor 统一 + 全量回归。

**Architecture:** guest-preload.tsx 作唯一入口（沿用 bootstrap + Web MCP qe() + iframe syncFrames + React AnnotationOverlay）。main.ts:1124 不变（零切换风险）。原生 DOM overlay（marker/preview/hover/cursor）被 React overlay 取代。popup BrowserWindow 链路退役（EditorCard 替代）。

**Tech Stack:** React 18.3.1、TypeScript、bun:test + happy-dom、Vite lib mode CJS preload。

## Global Constraints

1. **B 变体（保留 guest 入口）**：不切 main.ts:1124（仍 browser-guest-preload.cjs）。React 渲染搬入 guest-preload。
2. **保留 iframe syncFrames 骨架**：AnnotationDocumentRuntime 的 iframe 递归遍历保留（不丢 iframe 批注）。仅退役 DOM 渲染层（marker/preview/hover/cursor）。
3. **qe() Web MCP 保留**（Plan 6 已在 guest-preload，生产功能）。
4. **open-editor 改路径**：manager L331 open-editor 不再 openPopup，改为 setDraft + syncGuest 推 activeDraft（驱动 EditorCard）。
5. **退役 popup 全链路**：openPopup/positionPopup/closePopup/hidePopup/handlePopupCommand/popups Map/tabPopupIds/BrowserAnnotationPopup.tsx/browser-annotation-preload.ts/browser-annotation-position.ts/main.ts popup IPC/annotationPopupPreloadPath。
6. **auth 不涉及**（spec §10 错误，auth 在独立 browser-auth-preload.ts 认证窗口）。
7. 仓库用 **bun**；测试 **bun:test + happy-dom**；**React 18.3.1**。
8. **无 commit 工作流**；**中文注释**；**LF**。
9. **最高风险 plan**：iframe 递归保留 + 大量删除 + open-editor 路径改 + 全量回归。

---

## File Structure

| 文件 | 职责 | 状态 |
|---|---|---|
| `apps/desktop/src/browser-guest-preload.tsx` | guest-preload.ts → .tsx；加 React AnnotationOverlay 渲染；保留 syncFrames 骨架 + qe()；退役 DOM 渲染 | **改（重命名+重构）** |
| `apps/desktop/src/browser-overlay-preload.tsx` | 退役（合并进 guest） | **删** |
| `apps/desktop/src/browser-annotation-manager.ts` | open-editor 改 setDraft/syncGuest；删 popup 方法 | **改** |
| `apps/desktop/src/browser-annotation-preload.ts` | 退役（popup 桥） | **删** |
| `apps/desktop/src/browser-annotation-position.ts` | 退役（popup 定位） | **删** |
| `apps/web/src/components/browser/BrowserAnnotationPopup.tsx` | 退役（popup UI） | **删** |
| `apps/desktop/src/main.ts` | 删 popup IPC + annotationPopupPreloadPath | **改** |
| `apps/desktop/src/browser-runtime.ts` | 删 annotationPopupPreloadPath/handlePopupCommand/isPopupSender | **改** |
| `apps/desktop/vite.config.ts` | 删 overlay-preload + browser-annotation-preload build entry | **改** |
| `apps/desktop/package.json` | 更新 build.files（删 retire 产物） | **改** |
| `apps/desktop/scripts/desktop-package.test.mjs` | 更新 build.files 断言 | **改** |

---

## Task 101: guest-preload .tsx 改造（React 渲染搬入）

**目标**：guest-preload.ts → .tsx；加 React AnnotationOverlay 渲染（从 overlay-preload.tsx 搬 start() 逻辑）；保留 qe() + syncFrames 骨架 + GuestAnnotationRuntime IPC dispatch；vite build entry 更新。

**Files:**
- Rename: browser-guest-preload.ts → browser-guest-preload.tsx
- Modify: vite.config.ts（guest-preload entry .tsx + jsx）
- Test: guest-preload 现有测试适配

- [ ] **Step 1: .tsx 改造**（加 `import { createRoot } from 'react-dom/client'` + `import { AnnotationOverlay } from './browser-overlay/AnnotationOverlay'` + `import { overlayStyles } from './browser-overlay/overlay.css'`；在 start() 加 Shadow DOM + createRoot render）
- [ ] **Step 2: vite.config.ts**（guest-preload entry 改 .tsx；确认 jsx plugin 对该 entry 生效）
- [ ] **Step 3: 保留 qe() + syncFrames + GuestAnnotationRuntime IPC dispatch**（不加不改）
- [ ] **Step 4: 测试 + verify**

> 注：本 task 只加 React 渲染（与原生 DOM overlay 并存）。退役 DOM 渲染在 Task 102。过渡期双 overlay 并存（React + 原生 DOM），验证 React 渲染正确后再退役 DOM。

---

## Task 102: 退役原生 DOM 渲染层

**目标**：退役 GuestAnnotationRuntime + AnnotationDocumentRuntime 的 DOM 渲染层（markerLayer/hoverBox/cursorBadge/preview/frame-target 渲染）。保留 syncFrames iframe 遍历骨架 + IPC dispatch。

**Files:**
- Modify: browser-guest-preload.tsx（删 render/renderMarker/showPreview/schedulePreview/scheduleHidePreview + DOM 创建代码；保留 syncFrames/IPC dispatch/effect listeners）

- [ ] **Step 1: 识别 DOM 渲染层 vs syncFrames/IPC 骨架**（render L344-372 / renderMarker L374-399 / preview L401-435 = DOM 渲染；syncFrames L213-238 / start L166-192 / applyState / receive = 骨架）
- [ ] **Step 2: 删 DOM 渲染**（render/renderMarker/showPreview/schedulePreview/scheduleHidePreview + markerLayer/hoverBox/cursorBadge/preview DOM 创建）
- [ ] **Step 3: 保留 syncFrames + IPC dispatch + effect listeners**（iframe 递归 + sync/restore/close/prepare-screenshot 消息处理）
- [ ] **Step 4: 测试 + verify**（React overlay 接管渲染；guest 仅 IPC + iframe）

---

## Task 103: open-editor 改路径（setDraft + syncGuest）

**目标**：manager onGuestMessage open-editor 不再 openPopup，改为 setDraft + syncGuest 推 activeDraft（驱动 overlay EditorCard）。

**Files:**
- Modify: browser-annotation-manager.ts（open-editor handler：删 openPopup 调用，改 setDraft + syncGuest + emitSnapshot）

- [ ] **Step 1: open-editor 改 setDraft + syncGuest**（annotation 模式：setDraft + syncGuest 推 activeDraft → overlay EditorCard；tweaks 模式：emit browser:annotation-selection 不变）
- [ ] **Step 2: 测试 + verify**

---

## Task 104: 退役 popup 全链路

**目标**：退役 popup BrowserWindow 链路（openPopup/positionPopup/closePopup/hidePopup/handlePopupCommand/popups Map/tabPopupIds/BrowserAnnotationPopup.tsx/browser-annotation-preload.ts/browser-annotation-position.ts/main.ts popup IPC/annotationPopupPreloadPath）。

**Files:**
- Delete: BrowserAnnotationPopup.tsx + browser-annotation-preload.ts + browser-annotation-position.ts（+ test）
- Modify: browser-annotation-manager.ts（删 openPopup/positionPopup/closePopup/hidePopup/handlePopupCommand/popups/tabPopupIds/isPopupSender/reposition）
- Modify: main.ts（删 ipcMain.handle lume:browser-annotation-popup + annotationPopupPreloadPath）
- Modify: browser-runtime.ts（删 annotationPopupPreloadPath/handlePopupCommand/isPopupSender）
- Modify: vite.config.ts（删 browser-annotation-preload build entry）
- Modify: package.json + desktop-package.test.mjs（更新 build.files）

- [ ] **Step 1: 删 popup manager 方法 + state**
- [ ] **Step 2: 删 popup 文件**（BrowserAnnotationPopup + browser-annotation-preload + position）
- [ ] **Step 3: 删 main.ts/browser-runtime popup IPC + config**
- [ ] **Step 4: 更新 build（vite/package.json/desktop-package.test）**
- [ ] **Step 5: 测试 + verify**

---

## Task 105: 退役 overlay-preload + anchor 统一 + styleSnapshot

**目标**：退役 overlay-preload.tsx（合并进 guest）+ 删 guest-preload 的 anchor 拷贝（统一到 overlay anchor.ts）+ styleSnapshot 迁移确认。

**Files:**
- Delete: browser-overlay-preload.tsx
- Modify: browser-guest-preload.tsx（删 anchor 拷贝 L457-535，import from overlay/anchor.ts；styleSnapshot/styleSnapshotDeclarations 保留或迁移）
- Modify: vite.config.ts（删 overlay-preload build entry）
- Modify: package.json + desktop-package.test.mjs（更新 build.files）

- [ ] **Step 1: 删 overlay-preload.tsx**
- [ ] **Step 2: anchor 统一**（guest-preload import anchor.ts，删本地拷贝）
- [ ] **Step 3: styleSnapshot**（确认 overlay design-editor 运行时能调 styleSnapshotDeclarations，或保留在 guest）
- [ ] **Step 4: 更新 build + 测试**

---

## Task 106: 全量回归

**目标**：全量 typecheck + build + test + e2e（尽量）+ 真机手动清单。

- [ ] **typecheck**（desktop + web + sidecar）
- [ ] **build**（guest-preload.tsx 打包含 React overlay）
- [ ] **test**（全 desktop + web suite 绿）
- [ ] **e2e**（browser-runtime.e2e.mjs：marker/preview/hover/region/text/iframe/截图/design-editor/Web MCP）
- [ ] **真机手动清单**：comment 模式 click/text/region → EditorCard；design 模式 scrub/locked/多选 → DesignEditor；preview hover；ESC 退出；scroll/resize 刷新；Web MCP registerTool；宿主面板 CommentList；iframe 内批注

---

## 完成判据（Plan 8 收尾 = browser-annotation 完成）

1. guest-preload.tsx 作唯一入口（React overlay + qe() + syncFrames + IPC）。
2. 原生 DOM 渲染退役（React overlay 取代）。
3. popup 全链路退役（EditorCard 替代）。
4. open-editor 改 setDraft/syncGuest（驱动 EditorCard）。
5. overlay-preload 退役 + anchor 统一。
6. main.ts:1124 不变（B 变体，零切换风险）。
7. 全量回归绿（typecheck + build + test + e2e + 真机清单）。
8. 无 commit。

## Self-Review

**1. 覆盖**：React 渲染搬入 Task 101 ✓；退役 DOM Task 102 ✓；open-editor 改 Task 103 ✓；退役 popup Task 104 ✓；退役 overlay/anchor Task 105 ✓；回归 Task 106 ✓。
**2. iframe 风险**：保留 syncFrames 骨架（Task 102 只删 DOM 渲染，不删 syncFrames）。过渡期双 overlay（Task 101 React + 原生 DOM 并存，Task 102 退役 DOM）。
**3. open-editor**：Task 103 改 setDraft/syncGuest（对齐 Plan 4 editor-* 模式）。
**4. styleSnapshot**：Task 105 确认归属（design-editor 运行时能否调）。
**5. 最高风险**：大量删除 + 路径改 + iframe 保留 + 回归。每 task verify + 回归。

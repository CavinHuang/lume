# 浏览器注释 DesignEditor 对齐 Codex — 设计文档

> 日期：2026-08-03
> 目标：将 Lume 浏览器注释 design-editor（网页内 CSS 设计编辑器）对齐复刻到 Codex 桌面版（`OpenAI.Codex_26.727.4816.0`）的实际实现。
> **证据来源**：Codex `app-initial-BZcC-pud.js`（14MB）第 8913 行 DesignEditor 组件实证（grep + 字节区间分析），非反推。`browser-B15L647J.js` 经确认是 canvas/截图代码，不含 DesignEditor。
> 总 spec（架构/数据契约/IPC/退役）：`docs/superpowers/specs/2026-08-02-browser-annotation-codex-parity-design.md`。本文档是其 design-editor 章节的深化（实证修正）。

## 1. Codex 实证（设计依据，已 grep 验证）

### 1.1 组件树（DesignEditor @ app-initial:8913）
```
DesignEditorEntry (fKo)            // 入口，preview/full 切换
├─ pKo (preview 模式)              // 只读预览（surfaceMode==="preview"）
└─ mKo (full 模式)                 // 完整编辑器
   ├─ 编辑器开关按钮 [data-browser-sidebar-design-editor-toggle]
   ├─ 多选 anchors 列表 (yUo)      // annotationSelectionAnchors 渲染
   └─ [data-browser-comment-design-editor-stack]
      ├─ [data-browser-comment-design-prompt-shell] → ProseMesh 输入（评论正文）
      └─ JUo (DesignEditor body)
         ├─ ZUo (drag handle bar)  // targetLabel + drag 图标
         ├─ QUo (text input row)   // 文本内容编辑 [data-browser-sidebar-design-content-input]
         └─ $Uo ×N (sectionGroup)   // 按 kind 派生分发
            ├─ nWo (declaration) → rWo (value cell) → uWo (input dispatcher)
            │   ├─ vWo (color)         // <input type="color">
            │   ├─ dWo (opacity)       // scrubMin=0 scrubMax=1 scrubStep=0.01
            │   ├─ fWo (length px)     // scrubStep=1，px 后缀
            │   ├─ pWo (combobox)      // font-family / font-weight
            │   └─ gWo (scrub input)   // ★核心 scrub 交互
            ├─ sWo (dimensions)        // width+height，可锁比例
            ├─ iWo (spacing)           // padding/margin 4 边，可锁对边
            └─ oWo (flex-spacing)      // row-gap + column-gap
```

### 1.2 ★ Scrub 交互（gWo @ 8904954）— 与 Alt 无关
**触发**：直接拖拽 number 输入框本身（`onPointerDown`，非 Alt）。条件：`type==='number' && scrubStep!=null && scrubValue!=null && button===0 && isPrimary && pointerType!=='touch'`。
**拖拽**：垂直（`cursor-ns-resize`），向上=增、向下=减。常量 `hGo=4`（4px/步）、`gGo=4`（移动 <4px 不进入 scrub，防误触）。`delta = trunc((startY - currentY)/4)`，新值 `startValue + delta*step`，经 `XWo`（clamp min/max）+ `YWo`（格式化，最多 2 位小数）。
**视觉**：进入 scrub 设 `body.cursor=ns-resize SVG`、`body.userSelect=none`、`documentElement.overscrollBehavior=none`、最近 `[data-browser-sidebar-design-scroll-container]` 的 `overflowY=hidden`；pointerUp 全部还原。
**防误触**：scrub 刚结束的 click 阻止（避免选中文字）；number input 聚焦时滚轮 blur（避免误改值）。
**消息**：scrub 开始/活动 → `design-scrub-changed {property}`（仅 property 名字符串）；结束本地清理，**不发消息**。

### 1.3 ★ groupId === designChange.id（多选由 host 管，非 React 创建）
- React 侧不创建分组。多选 anchors 来自 `session.anchorState.anchor + additionalAnchors`。
- **添加 anchor = host 端职责**：`set-design-modifier-pressed {pressed:true}` 在「Alt 按下 + sidebar 激活 + 编辑器开 + hover」时发，host 开启「Alt+click 添加选择」模式。
- React 侧只能**移除**：`remove-annotation-selection {selectionIndex}`。
- 删除 design change：`design-overlay-delete {groupId}`，其中 `groupId === designChange.id`。
- **结论**：Lume 不必在 overlay 处理多选加入——交给 manager（Alt 监听），overlay 仅渲染 + 移除。

### 1.4 declarations 数据模型 + sectionGroup 派生
**Declaration**：`{ property: string; value: string; previousValue: string; placeholderValue?: string }`。`previousValue` 来自 baseline（host 抓取的 originalStyles）。
**sectionGroup 派生**（React 侧，非 host 固定结构，AWo @ 8918022）：
- `gap` → flex-spacing section（row-gap + column-gap）
- `margin-*`/`padding-*` → spacing section（4 边）
- `width`/`height` → dimensions section
- 其他 → declaration section
**LockedRelationships**：`{ dimensions: boolean（比例锁）; [spacingLockKey]: boolean（对边锁 top⇄bottom / left⇄right）}`。锁联动批量更新两个 declaration。

### 1.5 提交 diff（yGo @ 8927970）
仅提交 `value !== previousValue` 的 declaration（previousValue 准确性依赖 host 抓取的 originalStyles）。无变更 → null。提交结构 `{id, anchor, comment?, declarations: changed[], text?}`。

### 1.6 输入类型分发（uWo @ 8893827）
| CSS 属性 | 组件 | scrub |
|---|---|---|
| `color` / `*-color` | vWo `<input type="color">` + 文本 | 无 |
| `opacity` | dWo | min=0 max=1 step=0.01 |
| `font-size`/`border-radius`/`border-width`/`column-*` | fWo px 后缀 | step=1 |
| `font-family`/`font-weight` | pWo combobox | 无 |
| 其他 | pWo 非紧凑 | 无 |

### 1.7 hold-to-view-original（VXo @ 9086400）
按钮 + pointer/keyboard 双通道（Space/Enter）。按下 `isOriginalViewEnabled=true` → `set-original-view-enabled` command → host 应用 originalStyles。pointerCancel 清空该会话所有 hold。i18n: `thread.browser.tweaks.holdToViewOriginal`。

### 1.8 消息清单（实证，Lume 采用 `lume:` 前缀对齐语义）
| Codex 消息 | Lume 对应（lume: 前缀） | payload |
|---|---|---|
| `browser-sidebar-comment-overlay-design-scrub-changed` | `design-scrub-changed` | `{property}` |
| `browser-sidebar-design-overlay-update` | `design-overlay-update` | `{group: DesignEditorState}` |
| `browser-sidebar-design-overlay-delete` | `design-overlay-delete` | `{groupId}` |
| `browser-sidebar-comment-overlay-tweaks-open-changed` | `tweaks-open-changed` | `{open: bool}` |
| `browser-sidebar-comment-overlay-annotation-selection-hover-state` | `annotation-selection-hover-state` | `{selectionIndex}` |
| `browser-sidebar-comment-overlay-remove-annotation-selection` | `remove-annotation-selection` | `{selectionIndex}` |
| `set-design-modifier-pressed`（command） | `set-design-modifier-pressed` | `{pressed: bool}` |
| `set-original-view-enabled`（command） | `set-original-view-enabled` | `{enabled: bool}` |

### 1.9 CSS 选择器协议（实证，Plan 5 复用同名 data-attr）
`[data-browser-sidebar-design-editor-toggle]` / `[data-browser-comment-design-editor-stack]` / `[data-browser-sidebar-design-scroll-container]` / `[data-browser-sidebar-design-scrub-value-cell]` / `[data-browser-sidebar-design-scrub-property]` / `[data-browser-sidebar-design-scrub-peer-property]` / `[data-browser-sidebar-design-content-input]` 等。Lume overlay 用语义类名 + 关键 data-attr（peer 高亮用）。

## 2. Lume 现状 vs Codex 差距

**可复用**：`styleSnapshot`（guest-preload L502-505，21 字段）；`applyPageTweaksScript`/`resetPageTweaksScript`（browser-runtime.ts L4065-4098，`__lumePageTweakOriginals` Map 原值还原）；`tweaks:apply`/`tweaks:reset` RPC；`AgentBrowserDesignChangeAttachment`（originStyles/proposedStyles 整快照）；`setOriginalPreview`（双 surface）；overlayReducer `{mode:'design',groupId?}` 占位 + `open-design-editor-at-point`。

**必须新增（缺口）**：
1. declarations 粒度（attachment 类型扩展 + styleSnapshot declarations 输出 + apply 按 declarations）
2. DesignEditor overlay 组件（sectionGroup 派生 + 5 输入分发 + 提交 diff + hold-to-view）
3. scrub 交互（拖 number input + 垂直 + 4px + SVG 光标 + body 锁定 + peer 高亮）
4. locked relationships（dimensions 比例锁 + spacing 对边锁）
5. 多选 host 管理（Alt 监听 set-design-modifier-pressed + additionalAnchors + 移除）
6. sync 字段扩展（isDesignModifierPressed/canUseTweaks/isOriginalViewEnabled/isTweaksEditorOpen/activeDesignChange）
7. manager design 编排（消息处理 + activeDesignChange state）
8. overlayReducer design action（design-modifier-state/design-scrub-changed/open-design-editor-at-point/restore-editor）

## 3. 架构（延续并行重写）

DesignEditor 是**网页内 overlay 卡片**（同 EditorCard/PreviewCard 层），overlayReducer `target.mode:'design'` 驱动。**overlay 仍休眠、web 面板/popup 不动、main.ts:1119 未改**——happy-dom 单测验证。Plan 8 切 preload 转正。

## 4. 数据模型扩展

### 4.1 `AgentBrowserDesignChangeAttachment`（shared/types/agent.ts）加 declarations
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
  declarations: AgentBrowserDesignDeclaration[]   // ★ 新增（Codex 对齐）
  originalStyles: Record<string, string>          // 保留（向后兼容，existing schema/context/assembler）
  proposedStyles: Record<string, string>          // 保留
  groupId?: string                                // ★ = id（Codex groupId === designChange.id）
  text?: { previousValue: string; value: string } // ★ 文本节点编辑
  body?: string
  screenshotRef?: string
}
```
declarations 与 originalStyles/proposedStyles 并存（declarations 是主，整快照保留兼容）；提交 diff 仅 `value !== previousValue`。

### 4.2 styleSnapshot 扩展（guest-preload）输出 declarations
```ts
function styleSnapshotDeclarations(element, win): AgentBrowserDesignDeclaration[] {
  // 21 字段 → declarations: [{property, value, previousValue: value}]
}
```
（previousValue 初始 = value；用户编辑后 value 变，previousValue 保留 baseline）

### 4.3 sectionGroup 派生（overlay 侧，移植 AWo）
扁平 declarations → dimensions/spacing/flex-spacing/declaration 分组（见 1.4）。

### 4.4 BrowserAnnotationSessionSnapshot 加 activeDesignChange
```ts
activeDesignChange?: { id: string; anchor: AgentBrowserAnchor; declarations: ...; text?; comment? }
```
（不加独立 designGroups——groupId === designChange.id，多选用现有 additionalAnchors）

## 5. sub-plan 拆分（3 个，各自 spec→plan→实现 cycle）

### 5a：数据模型 + host 编排
- shared `AgentBrowserDesignDeclaration` + attachment 扩展（declarations/groupId/text）
- guest-preload `styleSnapshotDeclarations`（输出 declarations）
- manager onGuestMessage 加 design 消息处理（design-overlay-update/delete/tweaks-open-changed/design-scrub-changed + set-design-modifier-pressed/set-original-view-enabled command）
- store activeDesignChange + sync 字段扩展（guest-state sanitizeSync）
- sanitizeStyles 扩展（declarations 校验）
- 测试（declarations schema/styleSnapshot/manager design 分支/sync）

### 5b：DesignEditor 基础 UI
- `DesignEditor.tsx` overlay 组件（DesignEditorEntry preview/full + sectionGroup 派生 + 5 输入分发 color/opacity/px/combobox + 文本输入 + 评论输入 + hold-to-view + 提交 diff yGo）
- overlayReducer design action（open-design-editor-at-point 填 groupId / restore-editor / close-editor）+ AnnotationOverlay 渲染 DesignEditor（target.mode==='design'）
- overlay.css.ts design 样式（editor-stack/scroll-container/declaration 行/输入）
- activeDesignChange → DesignEditor 渲染 + 提交 → bridge.send(design-overlay-update)
- 测试（sectionGroup 派生/输入分发/提交 diff/hold-to-view/render）

### 5c：scrub + locked + 多选整合
- scrub 交互（拖 number input + 垂直 + 4px + SVG 光标 + body 锁定 + design-scrub-changed）
- locked relationships（dimensions 比例锁 + spacing 对边锁 + peer 高亮 overlay）
- Alt 多选 host 管理（set-design-modifier-pressed + additionalAnchors + remove-annotation-selection + annotationSelectionAnchors 渲染）
- tweaks-open-changed（编辑器开关）
- 全量 typecheck/build/test + 零倒退回归

## 6. 风险与未决

1. **Codex 是右侧栏 React 组件（web），Lume 是 overlay（preload）**：Codex DesignEditor 在 web renderer，Lume 复刻到 overlay preload（网页内）。技术栈差异：Codex 用 ProseMirror 评论输入 + CSS module；Lume overlay 用原生 HTML + overlay.css.ts。视觉对齐但实现不同。
2. **declarations 与 originalStyles/proposedStyles 并存**：双数据模型增加复杂度。提交以 declarations 为主（diff），整快照保留兼容现有 schema/context/assembler。
3. **scrub peer 高亮 overlay**：Codex 在 React 侧浮动 tooltip；Lume overlay 内实现（同层）。
4. **provenance/draftAttribute/targetLabel（Codex A.6）**：实证未见核心使用，5a 可暂不实现（YAGNI），declarations/groupId/text 是主。
5. **Plan 5 规模**：3 sub-plan 各 4-6 task，总计 ~14 task。延续 Plan 1-4 无-commit + subagent-driven + 每 task reviewer。

## 7. 与总 spec 的关系

本文档深化总 spec（2026-08-02）的 design-editor 章节（§4.1 DesignEditor + §A.5 sync + §A.6 DesignChange），用 Codex 实证修正（scrub 拖输入框非 Alt、groupId=designChange.id、sectionGroup 派生）。总 spec 的架构/IPC/退役/宿主面板章节不变。Plan 5a/5b/5c 各自 plan 文档依据本 spec。

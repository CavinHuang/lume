# 浏览器注释功能对齐 Codex — 设计文档

> 日期：2026-08-02
> 目标：将 Lume 浏览器注释/评论功能对齐复刻到 OpenAI Codex 桌面版（`OpenAI.Codex_26.727.4816.0`）的 UI、交互与技术栈。
> Codex 参考分析见 `docs/codex-browser-annotation-analysis.md`。

## 1. 背景与范围决策

Lume 已有一套**功能覆盖 ~85%** 的浏览器注释实现（`apps/desktop/src/browser-annotation-*.ts` + `apps/web/src/components/browser/BrowserShell.tsx`）。本设计**不是从零构建**，而是对齐/补齐/重构。

经 brainstorming 确认的 4 项关键决策（用户拍板，均选「最大程度忠实 Codex」）：

1. **评论编辑器**：从独立 BrowserWindow popup → **网页内 React overlay 卡片**（与 marker/preview 同层）。
2. **Web MCP**：**完整实现**（含 modelContext 注入侧，对齐 Codex `qe()`）。
3. **design 子模式**：**完整复刻** design-editor（设计组 groupId / design-scrub / designChange 提交）。
4. **overlay 技术**：**引入 React**（忠实 Codex 技术栈），重写现有原生 DOM overlay。

## 2. 现状 vs Codex 差距（精确）

| 维度 | Codex | Lume 现状 | 复刻动作 |
|---|---|---|---|
| overlay 渲染 | 网页内 React in preload | 网页内原生 DOM（`browser-guest-preload.ts` Shadow DOM） | 🔴 重写为 React |
| marker / 编号 | SVG pin | ✅ 原生 DOM 圆 pin（index+1） | 迁移到 React + 视觉对齐 |
| selection / cursor badge | ✅ | ✅ 原生 DOM | 迁移到 React |
| 文本选区高亮 | `.text-selection-highlight` | ⚠️ 仅悬停框 | 🟡 新增持久高亮 |
| 元素元数据 tooltip | role/aria | ❌ | 🟡 新增 |
| preview 卡片 | 网页内 | ✅ 原生 DOM | 迁移到 React |
| **评论编辑器** | **网页内卡片** | **BrowserWindow popup** | 🔴 重构为网页内 EditorCard |
| design-editor | 完整（group/scrub/designChange） | 🟡 purpose:'tweaks' + styleSnapshot + 数据模型已有 | 🟡 补完整 UI/交互 |
| 修饰键多选 | alt/shift + additionalSelections | ❌ guest 层单选（数据模型 `additionalAnchors` 已有） | 🟡 guest 层补多选 |
| Shadow DOM 选区 | `getComposedRanges({shadowRoots})` | 普通 `getSelection` | 🟡 升级 |
| 视觉细节 | `#128dff` / SVG | `#0b84ff` / 圆 | 🟡 对齐 |
| anchor 模型 | element/text/region | ✅ 一致（且有 `scrollContainer` 优于 Codex） | 🟢 复用 |
| 锚点恢复 | elementPath | ✅ selector+domPath+role+textQuote+TreeWalker | 🟢 复用（很强） |
| session 持久化 | snapshot.comments | ✅ v2 store | 🟢 复用 |
| 截图→对话 | capturePage+cropRect | ✅ off/necessary/always + screenshotRef | 🟢 复用（补 cropRect） |
| 宿主面板 UI | 评论列表/线程/未读 | ✅ BrowserShell review/annotation 面板 | 🟢 对齐细节 |
| **Web MCP 消费** | list/invoke | ✅ `webmcp:list`/`webmcp:invoke`（modelContext） | 🟢 已同构 |
| **Web MCP 注入** | preload `qe()` 注入 modelContext | ❌ 只消费不注入 | 🔴 新增注入侧 |

## 3. 架构

```
┌─ 主窗口 webview (apps/web) ── 右侧浏览器面板宿主 ──────────────┐
│  BrowserShell（review/annotation 面板，已就位，对齐细节）        │
└──▲───────────────────────────────────────────────────────▲──┘
   │ lume:browser-annotation-*  +  webmcp:list/invoke        │
┌──┴───────────────────────────────────────────────────────┴──┐
│ Electron 主进程 (apps/desktop)                                │
│  BrowserAnnotationManager（复用+扩展）  +  WebMcpHost（扩展）  │
│   • session store / 截图 / security（复用）                    │
│   • 移除 popup BrowserWindow，改 sync 驱动 React overlay       │
│   • design-editor 编排 + designChange 提交（新）               │
│   • modelContext 注入桥（新）+ agent RPC（已有 webmcp:list/invoke）│
└──▲─────────────────────────────────────────────────────────▲─┘
   │ lume:browser-annotation-guest                              │
┌──┴─────────────────────────────────────────────────────────┴─┐
│ 浏览器网页 (webContents)                                       │
│  ┌─ browser-overlay-preload.tsx（新 · 内嵌 React 19）────────┐│
│  │  React overlay：Marker / SelectionHighlight / TextHL /    ││
│  │   CursorBadge+MetadataTooltip / PreviewCard / EditorCard /││
│  │   DesignEditor / FrameTarget / AnnotationSelection        ││
│  │  + WebMcp 注入：document/navigator.modelContext（新）      ││
│  └────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## 4. 组件设计

### 4.1 React overlay preload（新 `apps/desktop/src/browser-overlay-preload.tsx`）

Shadow DOM closed 根（`data-lume-annotation-host`，z-index 2147483646，pointer-events none 容器 + 子元素按需 auto）。内嵌 React 19（与 `apps/web` 同版本）。状态机 reducer 对齐 Codex `Ve()`：`select-comment / create-comment-at-point / create-comment-from-selection / open-design-editor-at-point → 编辑态；close-editor → null；sync / prepare-comment-screenshot → 透传`。

| 组件 | 职责 | 关键交互 |
|---|---|---|
| `AnnotationOverlay` | 根容器 + reducer + Shadow DOM + 跨 frame 子树（复用现有递归 frame 逻辑） | sync/applyState |
| `Marker` | 编号 pin（attached/stale/detached/draft） | hover→PreviewCard、click→open-editor |
| `SelectionHighlight` | 悬停元素描边+填充（对齐 Codex `.flex-item-overlay`） | pointermove 跟随 |
| `TextSelectionHighlight` | **新**：文本选区蓝色高亮（对齐 `.text-selection-highlight`） | mouseup→选区 rect |
| `CursorBadge` + `ElementMetadataTooltip` | 光标徽章 + **新**元素 role/aria/name tooltip | pointermove + 元素元数据 |
| `PreviewCard` | 评论预览（对齐 comment-preview） | marker hover 120ms |
| `EditorCard` | **新**：评论编辑器，替代 BrowserWindow | open/close/cancel/focus/restore；Enter=添加，Ctrl+Enter=发送 |
| `DesignEditor` | **新**：设计编辑器，groupId 组、design-scrub、proposedStyles | design-modifier-state / design-scrub-changed |
| `FrameTarget` | 跨域 iframe 选择（保留 Lume 特色） | comment 模式覆盖 |
| `AnnotationSelection` | **新**：修饰键 alt/shift 多选，写入 `additionalAnchors` | annotation-selection-modifier/hover/remove |

锚点捕获沿用 `buildAnchor` 逻辑（element/text/region + domPath/selector/role/textQuote/textRange/viewport/markerPoint），**升级**：文本选区用 `getComposedRanges({shadowRoots})` 穿透 Shadow DOM；锚点恢复沿用 `locateAnchor`（selector→domPath→role→textRange→textQuote TreeWalker→fallback degraded）。

### 4.2 主进程 `BrowserAnnotationManager`（复用 + 扩展）

- **保留**：`BrowserAnnotationSessionStore`、`prepareScreenshot`（补 cropRect 裁剪，对齐 Codex `screenshotCropRect`）、security `sanitizeAnchor`、`syncGuest`。
- **移除**：`openPopup` / `positionPopup` / `closePopup` / `hidePopup` / `handlePopupCommand` / `popups` Map / `tabPopupIds`（整个 BrowserWindow popup 链路）。
- **改**：`onGuestMessage` 的 `open-editor` 不再开 popup，改为 `syncGuest` 推送 activeDraft 由 overlay 渲染 `EditorCard`；新增 `editor:*`、`design:*`、`annotation-selection-*`、`comment-screenshot-ready(+rect)` 等消息处理。
- **新**：design-editor 编排（groupId 管理、designChange 提交为 `AgentBrowserDesignChangeAttachment`）。

### 4.3 WebMcpHost（扩展，非新建）

Lume 已有 `webmcp:list`/`webmcp:invoke`（消费 `document.modelContext`）。**新增注入侧**（对齐 Codex `qe()`）：
- 在 `browser-overlay-preload.tsx` 用 `contextBridge.exposeInMainWorld('__lumeWebMcpModelContext', {...})` 暴露 `modelContext` 到 `document`/`navigator`（优先 `internalContextBridge.overrideGlobalPropertyFromIsolatedWorld`，回退 `exposeInMainWorld` + `executeInMainWorld` 重定义属性）。
- 提供 `getTools()` / `executeTool(tool, input)` / `onToolsChanged(cb)`，桥接到主进程工具注册表。
- 开关：复用现有 capability `webmcp`（`tab_capabilities_list` 已含）。

> 未决：modelContext 注册方向（网页→agent vs 主进程→网页）。Codex 的 `codex-sandbox` 页面自带工具；Lume 浏览器面板加载的网页来源（第三方 vs 内建）决定注入语义。**实现时先确认 Lume 浏览器面板的网页来源**，再定 modelContext 是「收集网页工具」还是「向网页暴露主进程工具」。默认按 Codex 方向（收集网页工具供 agent 调用）。

### 4.4 宿主面板（apps/web `BrowserShell.tsx`，已就位 + 对齐）

现有 `reviewSessions`/`annotationSession`/`pendingPageAnnotations`/列表/计数/提交/迁移/v1 已覆盖核心。对照 Codex 补：未读计数、resolved 状态、线程形态（具体组件参考 `docs/codex-browser-annotation-analysis.md` 第 10 节，待 Codex UI 分析补充）。

## 5. 数据契约（复用 `packages/shared/src/types/agent.ts`）

**无需改动**（Lume 已完备）：
- `AgentBrowserAnchor`（element/text/region + framePath/textQuote/textRange/viewport/markerPoint/scrollContainer/rect）
- `AgentBrowserAnnotationAttachment`（含 `additionalAnchors` 多选）
- `AgentBrowserDesignChangeAttachment`（origin:'browser-design-change' + originalStyles/proposedStyles）
- `BrowserAnnotationSessionSnapshot`（mode/selectionPurpose/comments/activeDraft/screenshotRef/theme）

**可能微调**：
- activeDraft 增加 `purpose` 透传 design；snapshot 增加 `designGroups?`（若 design-editor 需要显式组结构）。
- `AgentBrowserDesignChangeAttachment` 现为整快照（`originalStyles`/`proposedStyles`），Codex 用逐属性 `declarations:[{property,value,previousValue}]` + `isOriginalViewEnabled` 原视图切换。**可选对齐**（非必须）：扩展 declarations 粒度以支持 Codex 的原视图对照交互（见附录 A.5/A.6）。

## 6. IPC 协议对齐（语义对齐 Codex，前缀保留 `lume:`）

现有主通道：`lume:browser-annotation-guest`（主进程→网页：sync/prepare-screenshot/restore/close）、网页→主进程（mode-changed/screenshot-ready/anchor-state/preview-open/preview-close/open-editor）、popup 通道 `lume:browser-annotation-popup`（**退役**）、`lume:browser-annotation-popup-state`（**退役**）。

新增消息（对齐 Codex 语义）：
- 编辑器：`editor:open / close / cancel / focus / restore`
- 截图：`comment-screenshot-ready`（携带 `annotationViewportRect` + `markerViewportPoint` + `skipScreenshotCapture?`）
- 标注选区：`annotation-selection-modifier-state / hover-state / remove`
- design：`design:open-editor / open-editor-at-point / modifier-state / scrub-changed`
- 模式：`exit-comment-mode`、`capture-text-selection`
- 辅助：`mouse-navigation`、`image-drag-started / ended`

## 7. 构建与依赖改动

- `apps/desktop/package.json`：新增 `dependencies`：`react`、`react-dom`（版本对齐 `apps/web`）。
- `apps/desktop/vite.config.ts` `preloadConfig`：
  - 新增 entry `browser-overlay-preload: src/browser-overlay-preload.tsx`
  - 启用 JSX/TSX：`esbuild` jsx 支持（`build.commonjsOptions`/esbuild `jsx: 'automatic'`）或 `@vitejs/plugin-react`（评估，preload 是 CJS lib 模式，需确认插件兼容）。
- `electron-builder` `build.files`：新增 `dist/preload/browser-overlay-preload.cjs`，移除 `browser-annotation-preload.cjs`。
- 主进程 `main.ts`：`webPreferences.preload` 指向新 overlay preload（替代 `browser-guest-preload`？需确认 guest-preload 是否合并进 overlay 或并存）。

> 未决：`browser-guest-preload.ts`（含 iframe bootstrap、auth）与 `browser-overlay-preload.tsx`（注释 overlay + WebMcp 注入）的关系——合并为一个 preload，还是分入口注入同一 webContents。**实现时确认** Lume 浏览器 webContents 的 preload 挂载点。

## 8. 迁移与退役

**退役**（被 React overlay 取代）：
- `apps/desktop/src/browser-annotation-preload.ts`（popup 桥）
- `apps/desktop/src/browser-annotation-position.ts`（窗口定位）
- `apps/web/src/components/browser/BrowserAnnotationPopup.tsx`（独立窗口 UI）
- `browser-guest-preload.ts` 内的原生 DOM overlay（markerLayer/hoverBox/cursorBadge/preview/marker）→ 迁移到 React overlay preload

**保留并复用**：`browser-annotation-manager.ts`（核心，扩展）、`browser-annotation-session.ts`、`browser-annotation-security.ts`、`browser-annotation-position.ts` 的纯函数（若 EditorCard 定位复用）。

## 9. 测试策略

- 现有测试（`browser-annotation-position.test.ts` / `-security.test.ts` / `-session.test.ts` / `browser-annotation-submit.test.ts`）保持绿；`position` 若退役则迁移断言到 EditorCard 定位逻辑。
- React overlay 组件：参考 `AgentView.test.tsx` 的 fake DOM 模式（memory）。新增 `Marker` / `EditorCard` / `DesignEditor` / `AnnotationSelection` 的渲染与 reducer 状态机测试。
- 锚点恢复：`locateAnchor` 已有隐式覆盖，新增 Shadow DOM（`getComposedRanges`）选区用例。
- Web MCP 注入：mock `document.modelContext`，验证 `getTools`/`executeTool`/`onToolsChanged` 桥接。
- 截图：`prepareScreenshot` + cropRect 裁剪用例。
- 端到端：复用 `scripts/browser-runtime.e2e.mjs` 扩展注释 + design + webmcp 流程。

## 10. 风险与未决

1. **React in preload 构建可行性**：desktop 当前零 React 依赖，preload 为 CJS lib 模式。需验证 `@vitejs/plugin-react` 或 esbuild jsx 在 lib mode + `external: [electron, node:]` 下可行，且 React runtime 打包后 preload 体积可接受（~360KB）。
2. **重写回归风险**：现有原生 DOM overlay 可工作，重写为 React 需完整回归（marker/preview/selection/frame 跨域）。
3. **preload 挂载点**：`browser-guest-preload` 与新 overlay preload 的合并/并存关系待确认。
4. **Web MCP 注入语义**：modelContext 注册方向取决于浏览器面板网页来源（第三方 vs 内建）。
5. **设计组（designGroups）数据结构**：若 design-editor 需显式组管理，需扩展 snapshot 类型。
6. **宿主面板 UI 细节**：未读/resolved/线程形态待 Codex UI 分析（agent）补充后对齐。

## 11. 实施分阶段建议（供 writing-plans 细化）

> 阶段 7（宿主面板对齐）实施前，建议解出 `browser-B15L647J.js` + `app-initial-BZcC-pud.js`（`node D:/temp/codex-asar/asar-tool.js extract browser-B15L647J app-initial-BZcC-pud`）以获取右侧栏 React 组件树的直接证据。

---

## 附录 A：Codex 实现精确细节（UI 分析 agent 结论，实施依据）

> 来自对 `comment-preload.js`（line 1/97/98-119/121）+ `main-DyB6ps5P.js`（line 762/1041/1063/1065）的直接证据提取。

### A.1 三层架构与通道
- 单一 IPC 通道串联三层：`codex_desktop:browser-sidebar-runtime-message`（主进程常量 `r.K`，runtime 常量 `ze`）。
- 主进程核心类 `NV`（browserSidebarManager）+ `overlayManager`（按 owner+conversation+tab 维护 overlay 会话）。
- runtime 通过 `sendMessageToHost(msg)=ipcRenderer.invoke(ze,msg)` 与 `subscribeToHostMessages(cb)` 与主进程通信。

### A.2 DOM 浮层 CSS 类（comment-preload line 98-119，复刻视觉基准）
| 类 | 作用 | 关键样式 |
|---|---|---|
| `.interaction-layer` | 全屏底层 | `position:fixed;inset:0;z-index:0;100vw×100vh;pointer-events:none` |
| `.interaction-blocker` | 全屏拦截 | `position:absolute;inset:0;pointer-events:auto;touch-action:pan-x pan-y` |
| `.markers-layer` | pin 容器 | `position:fixed;inset:0;z-index:1;pointer-events:none` |
| `.marker` | pin 按钮 | `position:fixed;transform:translate(-50%,-50%)` 居中到 markerPoint |
| `.saved-marker`/`.draft-marker` | 已保存/草稿 pin | 尺寸变量 `--browser-sidebar-{saved,draft}-marker-size` |
| `.marker-label` | pin 数字 | 反色描边、`font-weight:700`、按 `--marker-label-offset` 偏移 |
| `.marker[data-selected="true"]` | 选中态 | `scale(1.08)` |
| `.text-selection-highlight` | 文本高亮 | `background:#128dff66` |
| `.hover-box` | 元素框 | `2px solid 主题色; 3% fill` |
| `.flex-item-overlay` | 设计模式 flex 项 | `border:1px solid rgba(2,133,255,.52); 18% fill` |
| `.region-box` / `.posted-region-highlight` | 区域选择/已提交 | dashed 2px / 3% fill |
| `.google-docs-annotation-box`/`-element-box` | Google Docs 专用 | transparent + 无 shadow（canvas 渲染适配）|
| `.annotation-selection-cursor`/`-modifier-cursor` | 自定义光标 | 按 zoomFactor 缩放 |

### A.3 Marker 渲染管线（line 121）
- `markers-layer` 内：草稿 pin + 已保存 pins。已保存 pins 由 `[comment.anchor, ...comment.additionalAnchors].flatMap()` 生成（一条评论多锚点 → 多 pin，共享同一 `commentNumber`）。
- `commentNumber` 来自 `Map<commentId, 序号>`（按已保存评论顺序赋号）；草稿 label = 已保存数 + 1。
- marker hover → `open-comment-preview`；click → `open-editor`（`target.mode:'edit'`）或 `focus-editor`。

### A.4 overlayManager API（主进程 line 762，揭示宿主面板语义）
- `open({owner, conversationId, browserTabId, browserBounds, viewportScale, target:{mode:'create'|'edit'|'design', commentId?}, anchorState, body, defaultDesignEditorOpen?})` — 挂载编辑器/设计编辑器卡
- `openPreview/closePreview/focus/dismiss/close` — 预览卡与编辑器卡生命周期
- `handleOverlayPreviewOpenChanged` — 列表项展开/收起
- `updateSessionForOwner` — anchor/设计变更实时回写
- `handleOverlaySubmit` → `sendMessageToWebContents(owner, {type:'browser-sidebar-direct-comment', browserTabId, conversationId, sessionId, body, comment})` — **评论喂给 agent**
- `selectComment` → runtime 发 `select-comment`（滚动定位 + 选中态）
- `target.mode` 五态：`create` / `edit`（带 commentId）/ `design`（带 groupId，`defaultDesignEditorOpen` 在 create 时默认展开设计编辑器）

### A.5 sync 消息完整 schema（host→runtime 全量快照，line 121）
```ts
{
  interactionMode: 'comment' | other,
  annotationEditorMode: 'comment' | 'design',        // 编辑器大类
  isAgentControllingBrowser: bool,
  canUseAnnotationMultiSelect: bool,                 // 多选开关（默认 false）
  canUseTweaks: bool,                                // 设计 tweaks（默认 true）
  isDesignModifierPressed: bool,                     // Alt 修饰键（仅 canUseTweaks）
  isOriginalViewEnabled: bool,                       // "原视图"开关：原 CSS vs 用户改的 CSS 对照
  isTweaksEditorOpen: bool,
  activeDesignChange?: DesignChange,
  intlConfig, comments, viewportScale, zoomPercent,
}
```
> `isOriginalViewEnabled` + `canUseTweaks` 是让用户在原 CSS 与自己修改的 CSS 间切换对照的功能（`activeDesignChange` 替换 declarations 渲染）。Lume 对应 design-editor 的"原视图"切换。

### A.6 Comment / DesignChange 数据模型（line 97/121）
```ts
Comment = {
  id, anchor, additionalAnchors?: Anchor[],
  markerViewportPoint: {x,y}, markerViewportSize?: {w,h},
  themeVariant: 'dark'|'light', viewportSize,
  selectionSourceIndexes?: number[],                 // 每个 anchor 在原 selection 的索引
  designChange?: DesignChange,
}
DesignChange = {
  id, anchor,
  declarations: [{property, value, previousValue}],  // 设计变更项
  draftAttribute, provenance, selector, targetLabel, text,
  markerViewportPoint, themeVariant, viewportSize,
}
```
> Lume 的 `AgentBrowserDesignChangeAttachment` 有 originalStyles/proposedStyles（整快照），Codex 用 `declarations:[{property,value,previousValue}]`（逐属性）。**实施时考虑对齐 declarations 粒度**。

### A.7 截图流程（line 762/121，端到端）
`prepare-comment-screenshot{commentId}` → runtime 等 `requestAnimationFrame`（确保 marker+高亮画到 DOM）→ `comment-screenshot-ready{commentId, annotationViewportRect, markerViewportPoint, skipScreenshotCapture?}` → 主进程 `webContents.capturePage()` + `IV(annotationViewportRect, markerViewportPoint)` 计算裁剪框 → 编码 PNG → `browser-sidebar-direct-comment`（含 screenshot）喂 agent → `clear-comment-screenshot`。超时 `browser-sidebar-comment-screenshot-ready-timeout`，无重试（截图可能静默为 null）。

### A.8 Web MCP shim（comment-preload line 1）
- `g({locationLike, onToolsChanged})` → `{registerTool, unregisterTool, executeTool, codexExecuteTool, getTools, codexGetTools}` — 网页注册自定义 MCP 工具（inputSchema + execute 回调）
- 工具变化 → `webmcp_changed` 事件（version 1）→ `onToolsChanged`
- 主进程 JSON-RPC：`webmcp_list_tools` / `webmcp_invoke_tool`
- 开关：`codex_desktop:get-browser-webmcp-enabled`
- **Lume 对齐**：消费侧（`webmcp:list/invoke`）已同构；注入侧需实现 shim `g()` 等价（registerTool/getTools/executeTool/onToolsChanged），用 contextBridge 暴露 `__lumeWebMcpModelContext` 到 `document/navigator`。

### A.9 set-of-mark 明确否定
全文（comment-preload + main）无 `set-of-mark/setofmark/numbered/...` 任何字面量。`.marker-label` 数字是 `commentNumber`（第几条用户评论），非可交互元素编号。本功能**不是** browser-use 类 SoM prompting。

### A.10 其他关注点
- **Google Docs 特殊路径**：`ae()`/`se()` 解析 `docs.google.com/{document,spreadsheets}/d/<id>`，专属 transparent CSS 类（canvas 渲染适配）。
- **agent 控制态隔离**：`isAgentControllingBrowser===true` 时跳过 URL 导航策略（潜在安全关注点，Lume 实现时需评估）。
- **盲区**：右侧栏 React 组件树（评论列表/线程/编辑器卡/设计编辑器卡的具体视觉）在 `browser-B15L647J.js`/`app-initial`（未解出），附录 A.4 的 overlayManager API 为反推依据；阶段 7 实施前解出获取直接证据。

1. **基建**：react/react-dom 依赖 + vite JSX + 新 preload entry + 构建验证。
2. **React overlay 骨架**：AnnotationOverlay + reducer + Shadow DOM + 跨 frame，迁移 Marker/Selection/Cursor/Preview（对齐视觉）。
3. **EditorCard**：网页内编辑器，退役 BrowserWindow popup 链路 + manager 改造。
4. **交互补齐**：TextSelectionHighlight、ElementMetadataTooltip、AnnotationSelection 多选、getComposedRanges、exit-comment-mode 等。
5. **design-editor**：DesignEditor + groupId + design-scrub + designChange 提交。
6. **Web MCP 注入侧**：modelContext 桥 + onToolsChanged + agent 对接验证。
7. **截图 cropRect + 宿主面板对齐**：cropRect 裁剪、未读/resolved/线程（待 Codex UI 结论）。
8. **退役清理 + 全量回归**。

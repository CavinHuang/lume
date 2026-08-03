# Codex 桌面版「浏览器注释/评论功能」实现分析

> 逆向分析对象：`OpenAI.Codex_26.727.4816.0_x64`（Electron 应用，代号 **owl**，`openai-codex-electron` v26.727.40816）
> 目的：作为 Lume 浏览器注释功能对齐复刻的权威参考。
> 分析方法：解包 `app.asar`（221MB）+ `@oai/cua`/`@oai/sky` 运行时，对 minified bundle 做关键词上下文提取。

## 0. TL;DR / 功能定性

Codex 右侧面板的「浏览器注释」**不是** CUA 里给模型看的「set-of-mark 数字编号」系统（`set-of-mark`/`numbered`/`badge` 全 0 命中）。

它是一套**给人用的网页协作批注/评论系统**，定位类似 **Figma comments / Google Docs 评论**：

- 用户在右侧浏览器面板加载的网页上：选中文本 / 点击元素 / 框选区域 → 锚定一条带截图的评论
- 评论连同「锚点元数据 + 裁剪截图 + 评论文本」注入到 Codex 对话（`conversationId`）指导 agent
- 对 `docs.google.com` 有专门解析分支（支持 Google Docs 协作批注）
- agent 通过 Web MCP（`modelContext`）反向操作网页

---

## 1. 整体架构：三层 + 进程边界

```
┌─────────────────────────────────────────────────────────────────┐
│  Codex 主窗口 webview (webview/index.html)                       │
│  React 主 UI，含「右侧浏览器面板宿主」                            │
│    • thread-browser-panel-tabs (面板 Tab)                        │
│    • browser-*.js (面板主模块 651KB，含评论列表/线程 UI)          │
│    • browser-use-settings (功能开关)                              │
└──────────────▲───────────────────────────────▲──────────────────┘
               │ codex_desktop:* IPC            │
┌──────────────┴───────────────────────────────┴──────────────────┐
│  Electron 主进程 (owl)  — browserSidebarManager                  │
│    • 持有 snapshot.comments（评论状态源）                         │
│    • IPC 路由 / 状态同步 (sync)                                   │
│    • 截图编排：prepare→waitForReady→capturePage→裁剪→写对话       │
│    • Web MCP host（modelContext 工具桥）                          │
└──────────────▲───────────────────────────────▲──────────────────┘
               │ ze / Re channel                │
┌──────────────┴───────────────────────────────┴──────────────────┐
│  浏览器网页（codex-sandbox://web-sandbox.oaiusercontent.com）     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ comment-preload.js  (内嵌 React 19.2.7，361KB)           │    │
│  │  在目标网页 DOM 上挂载 React overlay：                    │    │
│  │   • interaction-layer / blocker（全屏交互层）             │    │
│  │   • text-selection-highlight（蓝色 #128dff66 高亮）       │    │
│  │   • flex-item-overlay（元素矩形描边）                     │    │
│  │   • annotation-selection-cursor + SVG marker pin         │    │
│  │   • comment editor / preview 卡片                         │    │
│  │   • element-metadata-tooltip（role/aria-label）          │    │
│  │  职责：DOM 选区捕获、锚点坐标计算、overlay 渲染            │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

**两个 HTML 入口**（`app.asar` 内仅 2 个）：
- `webview/index.html` — 主 UI（含右侧浏览器面板）
- `webview/avatar-overlay-composition-surface.html` — ⚠️ 这是 **Codex 实时语音宠物（Pet）覆盖层**（dictation orb / realtime voice），**与浏览器注释无关**，不要混淆。

---

## 2. 通信通道（IPC）

`comment-preload.js` line 64 定义 4 个核心通道常量：

| 常量 | channel 名 | 方向 | 用途 |
|---|---|---|---|
| `ze` | `codex_desktop:browser-sidebar-runtime-message` | preload ↔ 主进程 | 注释主通道（双向）|
| `Re` | `codex_desktop:message-for-view` | 主进程 → preload | 视图消息 |
| `Be` | `codex_desktop:browser-page-event` | 页面 → 主进程 | 页面事件 |
| `Ke` | `__codexWebMcpModelContext` | 注入页面全局 | Web MCP 工具上下文暴露 |

辅助查询：`codex_desktop:get-browser-webmcp-enabled`（`sendSync`，返回布尔，控制 Web MCP 开关）。

---

## 3. 注释运行时 comment-preload.js

### 3.1 关键设计：preload 内嵌完整 React 19.2.7

`comment-preload.js`（361KB）主体是 **内联打包的 React 19.2.7 + react-dom + scheduler**。
**原因**：注释 overlay 要在**任意第三方网页 DOM**（含 Google Docs）上渲染，宿主页面的 React 版本/样式/CSP 都不可信。preload 自带框架 = 沙箱化渲染，overlay 与宿主页面彻底解耦。代价是包体 ~360KB。

### 3.2 Overlay 视觉层（注入网页的 CSS，offset ~307261）

| CSS class | 样式 | 用途 |
|---|---|---|
| `.text-selection-highlight` | `position:fixed; background:#128dff66` | 蓝色半透明文本选区高亮 |
| `.flex-item-overlay` | `border:1px solid rgba(2,133,255,.52)` | 元素矩形描边标注 |
| `.interaction-layer` | `position:fixed; inset:0; 100vw×100vh; pointer-events:none` | 全屏交互底层 |
| `.interaction-blocker` | `pointer-events:auto; touch-action:pan-x pan-y` | 触摸阻挡（评论模式捕获手势）|
| `.annotation-selection-cursor` | `position:fixed; z-index:1` | 注释选区光标 + SVG marker pin（`strokeWidth:1.65, width:26`）|
| `.annotation-selection-modifier-cursor` | `z-index:2; paint-order:stroke fill` | 修饰键光标（随 alt/shift 着色 + 描边）|
| `.element-metadata-tooltip` | `position:fixed; z-index:2; grid 两列` | 元素元数据（role/aria-label/tag）|
| `.element-metadata-cell` | `text-overflow:ellipsis` | 元数据单元格 |
| `.element-metadata-label` | `color:rgb(125,125,125); text-transform:lowercase` | 元数据标签 |

属性标记：`data-codex-browser-design-group`（设计组元素标识）。

主色：蓝色系 `#128dff` / `rgba(2,133,255,.52)`。marker pin 为带白色描边的 SVG 图标。

### 3.3 编辑器状态机 `Ve(e, t)`（line 64）

纯函数 reducer，决定「当前活跃编辑器」：

```js
function Ve(prev, msg) {
  switch (msg.type) {
    case 'select-comment':
    case 'create-comment-at-point':
    case 'create-comment-from-selection':
    case 'open-design-editor-at-point':
      return msg;                          // 进入编辑态
    case 'restore-editor':
      // 仅当 prev 是上述编辑态时保持 prev，否则用 msg
      return (prev?.type 是编辑态) ? prev : msg;
    case 'close-editor':
      return null;                          // 退出编辑
    case 'sync':
    case 'prepare-comment-screenshot':
    case 'clear-comment-screenshot':
      return prev;                          // 透传，不打断当前编辑
  }
}
```

---

## 4. 数据模型：Anchor + Target（复刻的核心契约）

### 4.1 三种锚点 `anchor.type`（offset ~285727–303254）

| 类型 | 触发 | 关键字段 |
|---|---|---|
| `text` | 选中文本 | `pageUrl`, `frameUrl`, `framePath`, `elementPath`, `title:'Selected text'`, `value` |
| `element` | 点击元素 | `element`, `markerViewportPoint`, `cardViewportRect`, `additionalSelections`, `viewportSize` |
| `region` | 框选区域 | `additionalSelections`, `viewportSize`, `value` |

锚点相等性判定（offset ~9921）：比较 `pageUrl && title && elementPath && frameUrl && framePath[] && selection`，逐段严格匹配。

### 4.2 两种目标 `target.mode`

| 模式 | 含义 |
|---|---|
| `create` | 创建普通评论 |
| `design` | 设计编辑：选中元素加入「设计组」（`groupId` + `data-codex-browser-design-group`），对应 `design-editor` / `design-modifier-state` / `design-scrub-changed` 整套设计子模式 |

`design` 模式产物：`comment.designChange.id`（评论可携带设计变更，被 agent 应用）。

### 4.3 坐标系与选区捕获

- `viewportPoint = Ma(target, {x: clientX, y: clientY})`：鼠标 client 坐标 + 跨 iframe frame offset
- 文本选区用 **`getComposedRanges({shadowRoots})`** 穿透 Shadow DOM 边界（offset ~283087）
- 元素 rect：`getBoundingClientRect()` + frame offset（`ja()` 计算）
- 锚点定位用 **`elementPath` + `framePath`（DOM 路径）**，**非像素坐标** → 抗重排，滚动/局部重绘后仍能找回元素

---

## 5. 完整 IPC 消息清单

### 5.1 评论生命周期
| 消息 | 说明 |
|---|---|
| `create-comment-at-point` | 在视口坐标点创建评论（element anchor）|
| `create-comment-from-selection` | 从文本选区创建评论（text anchor）|
| `select-comment` | 选中已有评论 |
| `exit-comment-mode` | 退出评论模式 |
| `capture-text-selection` | 捕获当前文本选区 |

### 5.2 编辑器
| 消息 | 说明 |
|---|---|
| `open-editor` / `close-editor` / `cancel-editor` | 打开/关闭/取消编辑器 |
| `focus-editor` | 聚焦编辑器 |
| `restore-editor` | 恢复编辑器（抗打断）|
| `open-comment-preview` / `close-comment-preview` | 评论预览卡片 |

### 5.3 锚点与截图
| 消息 | 说明 |
|---|---|
| `update-anchor` | 更新评论锚点位置 |
| `prepare-comment-screenshot` | 主进程→preload：准备某 commentId 的截图 |
| `comment-screenshot-ready` | preload→主进程：截图就绪，携带 rect + markerPoint + `skipScreenshotCapture?` |
| `clear-comment-screenshot` | 清除截图状态 |

### 5.4 标注选区（element/region 多选）
| 消息 | 说明 |
|---|---|
| `annotation-selection-modifier-state` | 修饰键状态（`pressed`，alt/shift）|
| `annotation-selection-hover-state` | 悬停状态 |
| `remove-annotation-selection` | 移除一个选区 |

### 5.5 设计编辑子模式
| 消息 | 说明 |
|---|---|
| `open-design-editor` / `open-design-editor-at-point` | 打开设计编辑器 |
| `design-modifier-state` | 设计修饰状态 |
| `design-scrub-changed` | 设计 scrub 变更 |

### 5.6 辅助交互
| 消息 | 说明 |
|---|---|
| `sync` | 全量状态同步（host↔runtime）|
| `mouse-navigation` | 鼠标前进/后退导航 |
| `image-drag-started` / `image-drag-ended` | 图片拖拽起止 |

---

## 6. 端到端流程

### 6.1 创建评论
1. 用户进入评论模式（反向消息 `exit-comment-mode` 退出）
2. 操作网页 → preload 监听鼠标/键盘：
   - **点击元素** → `create-comment-at-point` + `viewportPoint` → 计算 **element anchor**
   - **选中文本** → `create-comment-from-selection` → `getComposedRanges({shadowRoots})` → **text anchor**
   - 修饰键 alt/shift → 实时上报 `annotation-selection-modifier-state`，支持 `additionalSelections` 多选
3. preload 经 `sendMessageToHost(ze)` 上报 anchor 给主进程

### 6.2 主进程编排（`browserSidebarManager`）
- 更新 `snapshot.comments` → `sendRuntimeStateToPage` 把状态 `sync` 回 preload（双向同步）
- 打开评论编辑器（`open-editor`），用户输入正文

### 6.3 截图归档（注释→agent 的桥梁，main offset ~1184142）
```
主进程: send prepare-comment-screenshot {commentId}  → preload
preload: 计算 annotationViewportRect + markerViewportPoint
preload: send comment-screenshot-ready {commentId, rect, markerPoint, skipScreenshotCapture?}
主进程: waitForRuntimeCommentScreenshotReady(commentId)   // 带超时 + 错误上报
   ↓ (若 !skipScreenshotCapture)
主进程: webContents.capturePage()
        → 按 screenshotCropRect 裁剪 (IV(rect, view))
        → 可选 shouldUseCompactScreenshot 紧凑变体
        → 图片 + 评论文本 + conversationId 注入 Codex 对话
```
兜底：`browser-sidebar-comment-screenshot-ready-timeout`、`failed to capture browser comment`。
复用：`browser-sidebar-screenshot` 通道用 `capturePage()` + `clipboard.writeImage` 提供「复制浏览器截图」。

### 6.4 agent 反向操作（Web MCP）
`qe(e)`（line 64）检查 `codex_desktop:get-browser-webmcp-enabled`，开启后用 `contextBridge` 把 `modelContext` 挂到页面 `document`/`navigator`：
- 优先 `internalContextBridge.overrideGlobalPropertyFromIsolatedWorld`（隔离世界，更安全）
- 回退 `exposeInMainWorld` + `executeInMainWorld` 重新定义 `document/navigator.modelContext`

这让 Codex agent 能在网页内调用工具，实现「agent 操作浏览器」。

---

## 7. 主进程 host（main-DyB6ps5P.js，line 762）

主进程 `browserSidebarManager` 是注释功能的核心编排者：

- **状态源**：`snapshot.comments`（评论数组，每项含 `id`、可选 `designChange.id`）
- **关联键**：`browserTabId`、`conversationId`（评论绑定到对话，喂给 agent）
- **webContents**：`pageState.view.webContents`
- **消息路由**（offset ~1586826）：
  - `comment-screenshot-ready` → `handleRuntimeCommentScreenshotReady`
  - `update-anchor` → `handleRuntimeUpdateAnchor`
  - `open-design-editor` → `handleRuntimeOpenDesignEditor`
- **截图函数**（offset ~1184142）：
  ```js
  screenshotCropRect = IV(cropRect, view) ?? fallbackRect
  result = RV(LV(await webContents.capturePage(),
                 { annotation, screenshotCropRect, shouldUseCompactScreenshot }),
               shouldUseCompactScreenshot, cropRect, n, r)
  ```

---

## 8. Web MCP（agent 与网页的桥）

- 开关查询：`codex_desktop:get-browser-webmcp-enabled`（`sendSync`）
- 暴露全局：`__codexWebMcpModelContext`（常量 `Ke`）
- 工具变更回调：`onToolsChanged`（动态工具列表）
- 作用：把网页内的可操作能力（如读取/修改 DOM、调用页面 API）以 MCP 工具形式暴露给 Codex agent，与注释正交互补——**人用评论"指点"，agent 用 Web MCP"动手"**。

---

## 9. 设计亮点（复刻要点）

1. **人机意图解耦**：人用评论 UI（高亮+图钉+卡片），agent 收结构化 anchor + 裁剪截图，互不干扰。
2. **沙箱化 overlay**：preload 自带 React 19.2.7，可在任意第三方页面（含 Google Docs）稳定渲染，不受宿主 CSP/样式污染。
3. **健壮锚点**：`elementPath` + `framePath` 抗重排；`getComposedRanges({shadowRoots})` 穿透 Shadow DOM；锚点相等性逐段严格比较。
4. **截图即上下文**：评论始终带裁剪截图注入对话，agent 拿到「视觉 + 文本 + 元素元数据」三合一。
5. **设计子模式**：`design` mode + `groupId` 把评论升级为「设计变更」，可被 agent 应用。
6. **健壮性**：截图等待超时、错误分级上报（`errorReporter.reportNonFatal`）、`skipScreenshotCapture` 旁路、`restore-editor` 抗打断。
7. **主题适配**：anchor 携带 `themeVariant`，overlay 适配深浅色。

---

## 10. 宿主面板 UI 组件层（右侧栏 React）

> `browser-B15L647J.js`（651KB）与 `app-initial-BZcC-pud.js` 未解出（minified）。以下基于主进程 `overlayManager` API（main line 762）+ sync schema 反推；直接证据来自 `comment-preload.js` / `main-DyB6ps5P.js`。

右侧栏面板的 React 组件语义（由 `overlayManager` 方法揭示）：

| 组件（推断） | overlayManager 方法 | 触发 |
|---|---|---|
| 编辑器卡 / 设计编辑器卡 | `open({target:{mode:create\|edit\|design, commentId?}, anchorState, body, defaultDesignEditorOpen?})` | runtime `open-editor` / `open-design-editor` |
| 评论预览卡 | `openPreview` / `closePreview` | runtime `open/close-comment-preview`（marker hover）|
| 焦点 / 关闭 | `focus` / `dismiss` / `close` | `focus-editor` / `cancel-editor` / `exit-comment-mode` |
| 评论列表/线程 | 订阅 `snapshot.comments`；点击项 → `selectComment` | 选中 → runtime `select-comment`（滚动定位 + scale 1.08 选中态）|
| 提交（喂 agent） | `handleOverlaySubmit` → `browser-sidebar-direct-comment` | 用户提交评论 + 截图 |

`target.mode` 五态：`create`（新建）/ `edit`（带 commentId）/ `design`（带 groupId，`defaultDesignEditorOpen` 在 create 时默认展开设计编辑器）。

**盲区**：右侧栏 React 组件的具体视觉（列表项布局、未读计数、resolved 状态、线程折叠形态）未直接解出。实施对齐前应解出：
```
node D:/temp/codex-asar/asar-tool.js extract browser-B15L647J app-initial-BZcC-pud
```

> 排除项：`thread-browser-panel-tabs`（仅 4 行 tab 转移辅助）、`browser-use-settings`（浏览/下载历史设置，无评论开关）、`use-avatar-overlay-selection`（Codex Pet 语音浮层，与注释无关）。

---

## 附：证据索引（Codex 安装路径内）

| 内容 | 位置 |
|---|---|
| IPC 通道定义 + 状态机 + Web MCP | `app.asar` → `.vite/build/comment-preload.js` line 64 |
| Overlay CSS | 同上 offset ~307261–308400 |
| Anchor 数据模型 | 同上 offset ~285727–303254 |
| 截图编排 host | `app.asar` → `.vite/build/main-DyB6ps5P.js` line 762, offset ~1184142 |
| 消息路由 | 同上 offset ~1586826 |
| CUA 浏览器运行时（@oai/cua/sky）| `app/resources/cua_node/bin/node_modules/@oai/{cua,sky}` |

# 右侧文件面板预览 Tab 设计（issue #55）

> 2026-08-15 · 分支 `fix-right-panel-resize` · 状态：已评审通过

## 背景与目标

issue #55：右侧文件面板中的文件，希望可以在顶部用 tab 切换，方便在多个文件间往返。

现状：顶部 `RightPanelTabBar` 已支持 file tabs（可关闭、可滚动、去重），但**入口割裂**——

| 入口 | 现状行为 |
|---|---|
| agent 打开文件 / 划线引用 / 预览中点"编辑" | 开正式 file tab（`openFileTab`） |
| 窄模式（<680px）树单击 | 直接开正式 tab（`singleClickOpen`） |
| 宽模式树单击 | 只设 `temporaryPreviewTarget`（隐式临时预览，互相覆盖、不出现在 tab 栏、仅宽模式可见） |

目标：统一为 **VS Code 式预览 tab** 模型——浏览性单击产生一个可切换、可固定的预览 tab，正式打开仍走既有 file tab。

## 交互模型

| 操作 | 行为 |
|---|---|
| 树单击文件 | 打开/替换**预览 tab**（斜体标题，tab 栏显示、可点击切换） |
| 树双击文件 | **固定**为正式 tab（转正，位置保留在原处） |
| 双击预览 tab 本体 | 固定 |
| 预览中开始编辑（`onEditStart`） | 固定（保留现有语义） |
| 关闭预览 tab / 激活其他 tab | 预览态清除，预览 tab 消失 |
| 重复单击当前预览中的文件 | 仅刷新 navigationRevision（行定位），不重复创建 |

窄/宽模式统一为此模型；移除 `singleClickOpen` 与 `temporaryPreviewTarget` 两条旧路径。

## 状态模型（`right-panel-files-state.ts`）

- `ThreadFileWorkspace` 新增 `previewTab: RightPanelFileTab | null`（复用现有 tab 结构含 `target`/`lineSelection`/`navigationRevision`）
- **不持久化**：持久化 sanitize 时丢弃 `previewTab`（重启后预览态消失；正式 `openTabs` 照旧还原）
- 删除 `temporaryPreviewTarget` 字段及其全部读写
- `RightPanelActiveItem` 新增变体 `{ kind: 'file-preview' }`：预览激活时指向 previewTab（activeItem 为 runtime 态，不入持久化）
- **固定 = 现有 `openFileTab()`**（自带同文件去重：固定已打开过的文件 → 激活其正式 tab；固定当前预览文件 → 原地转正）并清空 previewTab

## 渲染改动

- **`buildRightPanelTabItems` / `RightPanelTabBar`**：file tabs 之后插入预览项（kind `file-preview`、斜体 label、可关闭、激活高亮同正式 tab；双击固定）
- **`FilesRightPanelWorkspace`**：
  - `previewTarget = activeTab?.target ?? workspace.previewTab?.target`
  - `lineSelection` / `navigationRevision` 取自 previewTab
  - `onEditStart` 在预览激活时 → `openFile`（固定）
- **`UnifiedFileTree`**：
  - `select()` 单击 → 设 previewTab（不再设 temporaryPreviewTarget）
  - 文件行增加 `onDoubleClick={() => onOpenFile(target)}`（照搬 MCP resource 区现有单击预览/双击打开模式，`UnifiedFileTree.tsx:630` 一带）
  - 移除 `singleClickOpen` 属性及调用点

## 错误处理与边界

- 预览文件缺失：`onMissing` → 清 previewTab（对齐正式 tab 缺失清理路径）
- 目录单击：维持现状（选中/展开，不动 previewTab）
- 宽模式折叠树（treeCollapsed）：现有逻辑不变

## 测试

- `right-panel-files-state.test.ts`：预览开 / 替换 / 固定（含去重转正）/ 清除 / 不持久化
- `RightPanelTabBar.test.ts`：预览项渲染（斜体）、双击固定回调、关闭回调
- 更新受影响旧测试：`singleClickOpen`、`temporaryPreviewTarget` 相关断言
- 组件测试沿用 bun:test + happy-dom 模式（参照 `AgentView.test.tsx` / `RightPanelSourcePreview.test.tsx`）

## 明确不做（YAGNI）

- 预览 tab 位置记忆（VS Code 的"固定首现位置"语义）——MVP 预览项恒排在 file tabs 末尾；固定后自然留在当前位置
- 预览态持久化
- tab 数量上限（现有 TabBar 滚动已处理溢出）

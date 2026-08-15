# 右侧文件面板"树常驻"体验重设计

> 2026-08-15 · 分支 `fix-right-panel-resize` · 状态：设计已确认
> 参考：Proma（树常驻+预览分离+hover 菜单）、deepseek-harness（concession 几何/关闭不卸载，暂不采用）
> 前置：#55 预览 tab（同分支已实现，本设计部分撤销其渲染层、保留状态层）

## 背景与痛点

用户实测反馈（在 #55 预览 tab 交付后）：
1. **tab 割裂**：点文件预览后 TabBar 高亮跳到预览 tab，"文件夹留在上一个 tab"——浏览树与看文件被 tab 切换割裂。
2. **底部操作栏杂乱**：窄模式选中文件后 FileDetailsBar 常驻底部（路径+详情+预览+系统打开+更多菜单），挤占空间且信息噪音大。

调研结论（Proma）：正确模型是**树为面板本体、预览不打断导航、操作收敛到行内 hover 菜单**，无底部栏。

## 交互模型

预览从"TabBar 一等公民"降级为**文件工作区内部的单槽**：

| 操作 | 行为 |
|---|---|
| 单击树文件 | 树内高亮 + 预览槽显示内容；**TabBar 高亮保持在"文件"功能 tab 不动** |
| 单击另一文件 | 预览槽单槽替换（树不动） |
| 双击文件 / 预览内开始编辑 | 升格正式 file tab（复用 `openFileTab` 去重），activeItem 切到该 tab |
| 激活正式 file tab | 该文件全宽预览（既有行为） |
| 回"文件"功能 tab | 树+预览槽原样恢复（预览槽内容保留） |

## 布局（宽窄统一模型）

```
宽面板（≥680，现状保留）：树 | 预览槽 并排，树列可折叠（既有 treeCollapsed）
窄面板（<680）：树/预览二态切换
  - 无预览内容或点"返回树" → 树占满
  - 单击文件 → 预览占满，预览头部左上"返回树"钮（面板内切换，非 TabBar 跳变）
  - 切换态存 preferences（并入 treeCollapsed 偏好体系）
```

## 底部 FileDetailsBar 废除 → 行内操作

- 窄模式 FileDetailsBar 整体删除（含折叠态）。
- 文件操作并入**既有行右键菜单** + 行尾 hover 三点（同一 DropdownMenu 两触发入口），操作集：复制相对路径 / 系统打开 / 文件管理器中显示 / 预览（窄模式）；与树已有的重命名/删除等右键项合并为同一菜单。
- 文件元信息（类型/大小/修改时间）移到预览槽头部小字（hover title 或次行），不再常驻底部。

## 状态模型

- **保留**（#55 已实现，语义改为"预览槽"）：`ThreadFileWorkspace.previewTab` 字段 + `previewFileTab` / `pinPreviewFileTab` / `clearPreviewFileTab`。
- **撤销**：
  - `RightPanelActiveItem` 的 `{ kind: 'file-preview' }` 变体删除（预览不再是激活态）；
  - TabBar 预览项渲染：`buildRightPanelTabItems` 第 5 参、`RightPanelTabBar` 的 `previewTab/onActivatePreview/onPinPreview/onClosePreview` props、`RightPanelTabItem` 的 `file-preview` 变体全部移除；
  - `RightPanelWorkspace` 的四个预览 handler props 撤除；`file-preview` 的 TS narrowing 占位分支清理。
- **改造**：
  - `UnifiedFileTree.select()`：设 previewTab 但**不动 activeItem**（树高亮走 selectedRef 既有机制）；
  - 窄模式二态切换态：新增 preference（如 `narrowShowsPreview: boolean`），由"单击文件→true / 返回树→false"驱动；宽模式忽略；
  - `FilesRightPanelWorkspace`：预览槽渲染已有（previewTarget 链），新增预览槽头部（文件名+元信息+窄模式返回钮）；`handleMissing` 预览清理保留。
- **不持久化**：previewTab 与窄模式切换态均为会话内状态（previewTab 本就不持久化；切换态入 preferences 则随 preferences 持久化，可接受）。

## 错误处理与边界

- 预览文件缺失：`onMissing` → `clearPreviewFileTab`（既有）。
- 目录单击：展开/选中，不动预览槽（既有）。
- reconcile rebind 清空 previewTab（既有）保留。
- 预览槽为空：显示既有空态（"选择文件以预览"）。

## 测试

- 状态层测试（#55 的 previewFileTab 系列）原样保留——语义未变。
- 删除：TabBar 预览项相关测试（#55 Task 2 的 4 用例）。
- 新增/改写：
  - 单击后 activeItem 不变（仍为 files function 或 null）、TabBar items 不含预览项；
  - 窄模式二态切换（preference 驱动 + 单击文件置 true + 返回置 false）；
  - 升格链路（双击/编辑 → openFileTab + 预览槽行为）；
  - 行内菜单操作集（合并后的右键/hover 菜单项）。
- 实机验证清单：宽（并排/折叠/升格/回文件 tab 恢复）+ 窄（二态切换/返回树/菜单）。

## 明确不做（YAGNI）

- 预览移到主区分屏（Proma split 模式）——Lume 主区是聊天+浏览器体系，不动。
- concession solver 几何（deepseek-harness）——现有 680 阈值 + 钳制够用。
- sticky 目录行/祖先竖线/Agent 修改小圆点——独立增强，另行立项。
- 多选/Cmd+Click——树已有能力不在本设计范围。

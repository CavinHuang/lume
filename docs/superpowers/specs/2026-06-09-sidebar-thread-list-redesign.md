# 侧边栏线程列表重构设计

> 日期：2026-06-09
> 状态：已批准
> 参考：直接移植 Proma `LeftSidebar.tsx` 的线程列表实现

## 目标

将 Lume 侧边栏中间的工作区线程列表部分重构为 Proma 风格：紧凑信息密集、右键菜单、悬浮预览、行内操作按钮组。

**范围**：只改工作区线程列表区域，顶部操作区（新建聊天/搜索/Lume/技能/自动化）和底部区域（设置/回收站）保持不变。

## 架构

### 组件映射

```
Lume 当前                          →  重构后（Proma 风格）
─────────────────────────────────────────────────────────────
LumeSidebar.tsx (纯 UI)           →  保留，修改线程列表渲染部分
  WorkspaceTree                    →  AgentProjectGroupItem（移植 Proma）
    WorkspaceRowRenderer           →  删除（不再二次分组）
      ThreadRow                    →  ThreadItem（移植 Proma AgentSessionItem，适配 Lume 数据模型）

LeftSidebar.tsx (业务逻辑)        →  保留，微调回调和数据传递
lume-sidebar-view-model.ts        →  简化：去掉二级分组，平铺线程
```

### 数据模型适配

Proma `AgentSessionMeta` vs Lume `AgentThreadMeta` 字段映射：

| Proma | Lume | 说明 |
|-------|------|------|
| `id` | `id` | 直接映射 |
| `title` | `title` | 直接映射 |
| `updatedAt` | `updatedAt` | 直接映射 |
| `pinned` | `pinned` | 直接映射 |
| `archived` | 无，用归档 API 模拟 | Lume 通过 `agent:archive-thread` 实现 |
| `workspaceId` | `workspaceId` | 直接映射 |
| `sourceAutomationId` | 无 | 忽略 |
| indicator status | `isStreaming` | Lume 用 `agentStreamingStatesAtom` 判断流式状态 |

### 需要新增的 UI 组件

1. **ThreadItem** — 基于 Proma `AgentSessionItem`，支持：
   - 右键上下文菜单（ContextMenu）
   - 悬浮 MiniMap 预览（SessionMiniMapPopover）
   - 行内操作按钮组（默认显示时间，hover 切换为 Pin/Archive/三点菜单）
   - 左侧 3px 状态色条（流式=蓝色脉冲、选中=品牌色）
   - 双击重命名

2. **WorkspaceGroupItem** — 基于 Proma `AgentProjectGroupItem`，支持：
   - 文件夹图标 + 工作区名称
   - hover 显示 [+新建会话] [三点菜单]
   - 默认显示活跃 + 最近 5 条线程
   - 「显示更多」/「收起」按钮

3. **ThreadItemActions** — 基于 Proma `SessionItemActions`，行内操作按钮组

### 需要新增的依赖

- `@radix-ui/react-context-menu` — 右键菜单
- `@radix-ui/react-dropdown-menu` — 下拉菜单（可能已有）
- `@radix-ui/react-tooltip` — 工具提示（可能已有）

### 视图模型简化

当前 `lume-sidebar-view-model.ts` 的 `LumeSidebarWorkspaceRow` 支持两种类型：
- `thread-group`：二级分组（如「置顶」「今天」等）
- `synthetic-thread`：合成线程（如「新建聊天」入口）

重构后：
- 去掉 `thread-group`，线程平铺
- 保留 `synthetic-thread`
- 新增 `active` 线程筛选和默认展示数量限制逻辑

## 不变的部分

- 顶部操作区（新建聊天、搜索、Lume、技能、自动化按钮）
- 底部区域（设置、回收站）
- 折叠状态的侧边栏（72px 图标视图）
- 工作区创建/删除/重命名对话框
- 确认对话框（ConfirmDialog）
- 所有业务逻辑（LeftSidebar.tsx 中的 IPC 调用、状态管理）

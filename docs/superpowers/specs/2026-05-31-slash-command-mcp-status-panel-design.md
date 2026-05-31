# 斜杠命令 MCP 状态面板设计

## 概述

在聊天输入框中输入 `/` 触发命令面板，选中 `/mcp` 后面板切换为 MCP 服务状态列表。两阶段交互，只读展示，ESC 或点击外部关闭。

## 交互流程

### 状态机

```
[关闭] --输入/--> [命令列表模式]
[命令列表模式] --选中/mcp--> [MCP状态模式]
[命令列表模式] --选中其他命令--> [关闭，执行命令]
[命令列表模式] --ESC/点击外部--> [关闭]
[MCP状态模式] --ESC/点击外部--> [关闭]
[MCP状态模式] --点击返回--> [命令列表模式]
```

### 流程

1. 用户在输入框输入 `/`
2. MentionList 弹出，显示命令列表（`/clear`, `/compact`, `/mcp`, `/resume`, `/reload-plugins` 等）
3. 用户通过键盘上下键或鼠标选中 `/mcp`
4. MentionList 内容切换为 MCP 状态列表
5. 用户查看状态后按 ESC 或点击外部关闭面板

## 实现方案：扩展 MentionList 组件

在现有 `MentionList.tsx` 中增加 MCP 状态面板视图，通过状态变量 `MentionPanelMode` 控制切换。

### 选择理由

- 复用现有的弹出定位、键盘导航、动画逻辑
- 改动范围小（仅修改 2-3 个文件）
- 面板位置天然跟随输入框

## 组件架构

### 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `apps/web/src/components/agent/MentionList.tsx` | 新增 MCP 状态面板视图 + 模式切换状态 |
| `apps/web/src/components/agent/slash-command-state.ts` | `/mcp` 命令的 onSelect 回调触发面板切换 |
| `apps/web/src/components/agent/editor-mention-suggestions.ts` | 传递 MCP 状态切换回调 |

### 复用但不需要修改的文件

- `McpSettings.tsx` — 设置页不受影响
- `mcp-settings-state.ts` — 复用 `buildMcpServerRows`、`McpServerRow` 类型和 `McpUiStatus` 类型
- `lib/desktop-api/mcp.ts` — 复用 `getMcpStatus` API

### 新增类型（在 MentionList.tsx 内部）

```typescript
type MentionPanelMode = 'commands' | 'mcp-status'
```

### 数据获取

面板切换到 MCP 状态模式时：
1. 通过 `getMcpStatus(workspaceSlug)` 获取当前工作区 MCP 服务器状态
2. 使用 `McpServerRow`（或直接用 `McpServerStatus`）渲染每行
3. 不轮询 — 只在面板打开时获取一次快照（只读展示）

### 组件结构

```
MentionList
├── commands 模式（现有逻辑不变）
│   └── 渲染命令列表项
└── mcp-status 模式（新增）
    ├── 标题栏："← 返回" + "MCP 服务状态"
    └── 状态列表（可滚动）
        └── 每行：[状态圆点] 服务器名称  x 个工具
```

## UI 视觉规范

### 面板定位与尺寸

- 位置：输入框正上方，与现有 MentionList 位置一致
- 宽度：与输入框等宽
- 最大高度：~320px，超出可滚动

### MCP 状态模式布局

- **标题栏**：左侧 "← 返回" 按钮 + "MCP 服务状态" 文字，高度 36px
- **状态列表项**：
  - 左侧：状态圆点（8x8px）
  - 中间：服务器名称（`text-sm`）
  - 右侧：工具数量（如 "3 个工具"，`text-xs text-muted-foreground`）

### 状态圆点配色

| 状态 | 颜色 | 样式 |
|------|------|------|
| `connected` | 绿色 | `bg-green-500` |
| `connecting` | 黄色 | `bg-yellow-500 animate-pulse` |
| `error` | 红色 | `bg-red-500` |
| `disconnected` | 灰色 | `bg-muted-foreground/40` |
| `auth_needed` | 蓝色 | `bg-blue-500` |

### 空状态与加载

- 无数据：居中显示 "暂无 MCP 服务配置"
- 加载中：简单的 loading spinner

### 动画与过渡

- 模式切换使用 `animate-in fade-in` 过渡
- 遵循项目现有 `bg-popover`、`text-popover-foreground` 配色

## 键盘交互

| 按键 | 行为 |
|------|------|
| `↑` / `↓` | 导航 MCP 状态列表项 |
| `Escape` | 关闭面板 |
| `Backspace`（标题栏） | 返回命令列表 |

## 约束与边界

- MCP 面板为纯只读展示，无操作按钮
- 不轮询状态，打开时获取一次快照
- 不影响现有命令列表的行为
- 面板关闭后状态重置为命令列表模式

# 命令面板搜索功能设计

## 概述

为 Lume 添加全局命令面板，用于跨工作区搜索线程标题。采用 VS Code 风格的居中弹窗，支持 Ctrl+K 快捷键和侧边栏搜索按钮双入口触发。

## 搜索范围

- 仅搜索线程标题，模糊匹配
- 跨所有工作区，不受当前选中工作区限制
- 纯客户端实现，读取已有的 `agentThreadsAtom`，无需新增 IPC 调用

## 搜索逻辑

```
用户输入 → debounce(150ms) → agentThreadsAtom 全量线程 → title.toLowerCase().includes(query) → 排序 → 渲染
```

**排序规则：** 置顶优先 → 按 `updatedAt` 倒序

## 选中结果行为

Enter 或点击结果 → 切换到该线程标签页（不存在则新建） → 关闭面板 → 聚焦聊天输入框

## 组件架构

**新增组件：**

| 组件 | 文件 | 职责 |
|------|------|------|
| `CommandPalette` | `components/command-palette/CommandPalette.tsx` | 根组件，遮罩层 + 弹窗 + 键盘事件 |
| `SearchInput` | `components/command-palette/SearchInput.tsx` | 搜索输入栏（图标 + input + 计数 + Esc） |
| `SearchResultList` | `components/command-palette/SearchResultList.tsx` | 结果列表，管理键盘选中状态 |
| `SearchResultItem` | `components/command-palette/SearchResultItem.tsx` | 单条结果（标题 + 工作区标签 + 时间） |

**组件层次：**

```
AppShell
└── CommandPalette (条件渲染，commandPaletteOpenAtom)
    ├── 遮罩层 (backdrop, onClick → 关闭)
    └── 弹窗容器
        ├── SearchInput
        ├── SearchResultList
        │   └── SearchResultItem × N
        └── 底部快捷键提示栏
```

**新增 Atom：**

- `commandPaletteOpenAtom: PrimitiveAtom<boolean>` — 面板开关状态，放在 `atoms/command-palette.ts`

**数据来源：**

- `agentThreadsAtom` — 线程列表
- `agentWorkspacesAtom` — 工作区列表（用于显示工作区名称标签）
- `tabsAtom` + `activeTabIdAtom` — 标签页切换

## UI 状态

### 空状态（刚打开）
- 输入框 placeholder: "搜索线程标题..."
- 内容区：搜索图标 + "输入关键词搜索所有线程"
- 底部：↑↓ 导航 / ↵ 打开 / Esc 关闭

### 搜索结果
- 输入框右侧显示结果计数（如 "3 个结果"）
- 结果列表：每项显示标题、工作区标签（右侧小 tag）、更新时间
- 选中项高亮背景色
- 底部：↑↓ 导航 / ↵ 打开 / Esc 关闭

### 无结果
- 内容区："未找到匹配的线程" + "尝试其他关键词"
- 底部：Esc 关闭

### 遮罩层
- 半透明黑色遮罩覆盖整个应用
- 点击遮罩关闭面板

## 键盘交互

| 按键 | 行为 |
|------|------|
| `Ctrl+K` | 打开面板（已打开时关闭） |
| `Esc` | 关闭面板 |
| `↑` / `↓` | 上下移动选中项（循环） |
| `Enter` | 打开选中线程 |
| 点击遮罩 | 关闭面板 |

## 动画

- 遮罩层：`fade-in` 150ms
- 弹窗：`animate-in fade-in zoom-in-95 slide-in-from-top-2` 150ms
- 关闭：`animate-out fade-out zoom-out-95` 100ms
- 选中项切换：背景色过渡 100ms

## 焦点管理

- 打开时自动聚焦输入框
- 关闭时焦点回到触发前的元素
- 输入框始终保持焦点，键盘事件在面板组件内用 `onKeyDown` 捕获

## 触发入口

1. `Ctrl+K` 全局快捷键 — 在 `AppShell` 层级用 `useEffect` 注册
2. 侧边栏搜索按钮 `onClick` — 设置 `commandPaletteOpenAtom` 为 true

## 边界情况

- 侧边栏折叠状态下，Ctrl+K 仍可正常触发
- 搜索词清空时回到空状态
- 线程列表为空时显示"暂无线程"
- 面板打开时不影响底层滚动和交互

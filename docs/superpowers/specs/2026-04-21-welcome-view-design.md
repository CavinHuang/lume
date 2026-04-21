# 新会话欢迎页设计

## 概述

将"新建聊天"从直接创建线程改为先显示欢迎页。欢迎页包含问候语、带内嵌配置的大输入框（复用现有编辑器组件）和当前工作区最近对话。线程在用户发送第一条消息时才真正创建。

## 新建聊天流程

```
点击"新建聊天" → 创建 welcome tab → 渲染 WelcomeView
→ 用户输入消息 + 选择配置（工作区/模型/附件）
→ 点击发送 → agent:create-thread → agent:send-thread-message
→ 关闭 welcome tab → 创建 agent tab → 渲染 AgentView
```

## Tab 系统扩展

**TabType** 新增 `'welcome'`。

```ts
export type TabType = 'agent' | 'settings' | 'welcome'

export interface Tab {
  id: string
  type: TabType
  title: string
  threadId?: string
  settingsTab?: SettingsTab
  workspaceId?: string  // welcome tab 记住用户选择的工作区
}
```

**渲染路由（TabContent）：**
- `type === 'welcome'` → WelcomeView
- `type === 'agent'` → AgentView（不变）
- `type === 'settings'` → SettingsView（不变）

**Welcome tab 规则：**
- id 固定为 `'__welcome__'`
- 同一时刻只存在一个 welcome tab
- 重复点击"新建聊天"：若已有 welcome tab 则激活，不新建

## 组件架构

### WelcomeView

```
WelcomeView
├── 问候语 ("What should we work on in {workspaceName}?")
├── ChatInput (大输入框，复用 TipTap 编辑器 + 工具栏)
│   ├── Paperclip 按钮（文件附加）
│   ├── ModelPicker（复用现有）
│   ├── ThinkingLevelPicker（复用现有）
│   └── 发送按钮
├── WorkspaceSelector (Popover：搜索 + 列表 + 新建)
└── RecentThreads (当前工作区最近 3 条对话)
```

### ChatInput 抽取

从 AgentInput 中提取共享的编辑器 + 工具栏为 `ChatInput` 组件。WelcomeView 和 AgentInput 都使用它，传入不同的 `onSend` 回调。

```ts
interface ChatInputProps {
  placeholder?: string
  workspaceSlug?: string
  disabled?: boolean
  onSend: (text: string, options: { thinkingLevel: string }) => void | Promise<void>
}
```

**ChatInput 包含：**
- TipTap 编辑器（复用 StarterKit + Placeholder + Mention 扩展）
- @文件、/Skill、#MCP mention 支持
- 工具栏：Paperclip、ModelPicker、ThinkingLevelPicker、发送按钮
- Enter 发送，Shift+Enter 换行

### WorkspaceSelector

内嵌在输入框下方或作为 Popover 从工作区标签触发：

- 搜索框：实时过滤工作区名称
- 工作区列表：每项显示名称 + 线程计数
- 底部"新建工作区"按钮：prompt 输入名称 → `agent:create-workspace` → 自动选中
- 选中后更新问候语中的工作区名 + 刷新最近对话

### RecentThreads

- 数据源：`agentThreadsAtom`，按 `selectedWorkspaceId` 过滤
- 取最近 3 条（按 `updatedAt` 倒序），排除置顶线程
- 每项显示：标题 + 相对时间
- 点击 → `openThread` 跳转到该线程的 agent tab
- 当前工作区无对话时不显示此区域

## 状态管理

**WelcomeView 本地状态：**
- `selectedWorkspaceId: string | null` — 初始值从 `currentWorkspaceIdAtom`
- `sending: boolean` — 发送中状态

**无需新 atom：**
- 工作区列表、线程列表、模型配置等都从现有 atom 读取
- Tab 状态通过已有的 `tabsAtom` / `activeTabIdAtom` 管理

## UI 设计

**布局（居中，ChatGPT 风格）：**

```
┌─────────────────────────────────────┐
│                                     │
│   What should we work on in Lume?   │  ← 问候语，工作区名渐变色
│                                     │
│  ┌─────────────────────────────────┐│
│  │ 描述你想完成的任务...            ││  ← TipTap 编辑器
│  │                                 ││
│  │ ┌──────┐ ┌──────┐ ┌──┐  ┌──┐  ││
│  │ │📎附件│ │🤖模型│ │🧠│  │▶ │  ││  ← 工具栏
│  │ └──────┘ └──────┘ └──┘  └──┘  ││
│  └─────────────────────────────────┘│
│                                     │
│  最近对话                            │
│  ┌─────────────────────────────────┐│
│  │ 帮我重构 Auth 模块     3分钟前  ││  ← 可点击跳转
│  ├─────────────────────────────────┤│
│  │ 数据库迁移脚本         昨天    ││
│  ├─────────────────────────────────┤│
│  │ OAuth 回调处理         3天前   ││
│  └─────────────────────────────────┘│
│                                     │
└─────────────────────────────────────┘
```

**问候语：** "What should we work on in **{workspaceName}**?"，工作区名使用渐变色。无工作区时显示 "What should we work on?"

**输入框：** 复用 ChatInput（TipTap 编辑器 + 完整工具栏），placeholder 为 "描述你想完成的任务..."

## 交互细节

**发送：** Enter 发送，Shift+Enter 换行。空消息时发送按钮 disabled。

**发送中：** 发送按钮显示 loading，输入框 disabled。完成后自动切换到 agent tab。

**发送失败：** toast 错误提示，保留输入内容不丢失，sending 重置为 false。

**工作区切换：** 更新问候语 + 刷新最近对话 + 更新 mention 查询的工作区上下文。

**模型选择：** 复用 ModelPicker，选择后模型信息随线程创建传入。

**文件附加：** 复用 Paperclip 按钮 + openFileDialog。文件在线程创建后通过 `agent:save-files-to-thread` 保存。

**Tab 切换保留状态：** 用户切换到其他 tab 再切回 welcome tab，保留之前的输入内容和选择状态。

## 边界情况

- 没有工作区时：工作区标签不显示，问候语不带工作区名
- 当前工作区没有对话时：最近对话区域整体隐藏
- 发送失败：toast 提示，保留输入内容
- 用户关闭 welcome tab 再点新建：创建新的 welcome tab
- 欢迎页中 mention（@文件）需要 workspaceSlug：从 selectedWorkspaceId 解析

# Proma -> Lume 功能对齐清单（含取舍点）

- 生成日期：2026-03-21
- 基线仓库：
  - Proma：`/Users/cavinhuang/workspace/projects/ai-projects/Proma`
  - Lume：`/Users/cavinhuang/workspace/projects/ai-projects/Lume`
- 目标：给出可执行的功能对齐范围、Proma 精确代码位置、以及每项的取舍决策点。

---

## 使用说明

- `P0`：建议优先对齐，直接影响用户主路径与产品认知一致性。
- `P1`：增强一致性或平台能力完整度。
- `P2`：锦上添花或可替代能力。
- 每项均包含：
  - `Proma 精确代码位置`：文件 + 行号
  - `Lume 当前锚点`：用于评估现状
  - `取舍点`：是否严格对齐 Proma，还是保留 Lume 现有路线

---

## P0 清单

### P0-SET-001 设置导航能力齐套（Prompts/Tools/Feishu/Tutorial/Proxy）

**Proma 精确代码位置**
- `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/atoms/settings-tab.ts:14`
- `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/SettingsPanel.tsx:41`
- `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/SettingsPanel.tsx:42`
- `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/SettingsPanel.tsx:47`
- `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/SettingsPanel.tsx:48`
- `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/SettingsPanel.tsx:49`

**Lume 当前锚点**
- `/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web/atoms/settings-tab.ts:3`
- `/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web/components/settings/SettingsPanel.tsx:33`

**对齐动作**
- 扩展 Lume `SettingsTab` 枚举和 `SettingsPanel` 渲染分发，显式恢复/补齐 Proma 的设置维度。

**取舍点**
- 方案 A（推荐）：保持 Lume 的信息架构，但新增缺失 tab，确保用户可见功能可达。
- 方案 B：严格复制 Proma 设置布局。优点是一致性最高；缺点是会抬高 Lume 已有 AgentSettings 聚合面板的拆分成本。

---

### P0-CHAT-001 系统提示词管理链路（创建/编辑/默认/追加）

**Proma 精确代码位置**
- 前端设置页：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/PromptSettings.tsx:31`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/PromptSettings.tsx:50`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/PromptSettings.tsx:75`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/PromptSettings.tsx:107`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/PromptSettings.tsx:120`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/PromptSettings.tsx:152`
- IPC 暴露：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:498`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:501`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:504`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:510`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:513`
- 主进程处理：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1518`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1526`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1534`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1550`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1558`

**Lume 当前锚点**
- 仅有 workspace bootstrap/system prompt 生成逻辑，缺少独立可视化管理面板。

**对齐动作**
- 在 Lume 新增 PromptSettings 视图和对应 sidecar 方法，打通 CRUD + default + append 开关。

**取舍点**
- 方案 A（推荐）：仅对齐 Chat 使用链路，Agent 继续走 Lume bootstrap prompt 体系。
- 方案 B：Chat 与 Agent 都统一到一套 prompt 配置。优点是统一；缺点是会冲突 Lume 现有 workspace identity 构建逻辑。

---

### P0-CHAT-002 Chat 工具开关与工具活动流（ToolSelector + Tool Activity）

**对齐进度（2026-03-22）**
- ✅ 已完成：工具设置页（内置工具开关、联网凭据、自定义工具增删、凭据配置、连接测试）。
- ✅ 已完成：输入区 ToolSelector（启用/禁用、不可用态“需配置”提示、跳转设置页）。
- ✅ 已完成：`chat:stream:tool-activity` 流式事件通道、UI 活动指示器渲染、活动持久化到 assistant 消息。
- ✅ 已完成：`chat-tools.json` 变更通知（`chat-tool:custom-tool-changed`）与前端自动刷新。
- ✅ 已完成：最小闭环工具执行（`memory_search` / `web_search` / `suggest_agent_mode` / `custom http`）与 systemPromptAppend 注入。
- ✅ 已完成：`nano_banana` 最小闭环（内置工具注册、凭据校验、连接测试、工具活动、图片附件落盘与展示）。
- ✅ 已完成：`nano_banana` 会话级多轮续接（thought signature 占位符兼容）与会话删除/截断后的历史清理。
- ✅ 已完成：`suggest_agent_mode` 推荐卡片渲染与一键切换 Agent 会话。
- ✅ 已完成：自定义工具可用性判定（按 `credential.*` 占位符）。
- ✅ 已完成：OpenAI / Anthropic / Google provider 的最小函数调用编排（tool_calls -> 工具执行 -> 续接请求）。

**当前剩余差异（非阻塞 P0，偏向 P1）**
- ⏳ 未做：复杂多轮工具调用场景下的 provider 级边界行为统一（当前为最小闭环实现）。
- ⏳ 未做：`nano_banana` 的高级编辑策略细节（参数自动化策略、参考图挑选策略等）与全量细节对齐。

**Proma 精确代码位置**
- 工具设置页：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/ToolSettings.tsx:467`
- 输入区工具选择：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/chat/ToolSelectorPopover.tsx:43`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/chat/ToolSelectorPopover.tsx:54`
- 工具活动指示：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/chat/ChatToolActivityIndicator.tsx:42`
- 协议与通道：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/chat.ts:356` (`STREAM_TOOL_ACTIVITY`)
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/chat-tool.ts:93`
- IPC：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:931`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:979`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:800`

**Lume 当前锚点**
- Chat IPC 已包含 `STREAM_TOOL_ACTIVITY`：`/Users/cavinhuang/workspace/projects/ai-projects/Lume/packages/shared/src/types/chat.ts:276`
- 已具备独立 Chat Tool 设置页：`/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web/components/settings/ToolSettings.tsx`

**对齐动作**
- 增加 Chat 工具状态与凭据管理模块。
- 增加 `chat:stream:tool-activity` 事件通道并在 UI 端渲染。

**取舍点**
- 方案 A（推荐）：先做最小闭环（memory/web-search 两个内置工具）。
- 方案 B：直接完整复刻 Proma 工具体系（含自定义工具）。复杂度高，不建议首期。

---

### P0-CORE-001 Onboarding / Tutorial / Welcome Conversation

**Proma 精确代码位置**
- 首屏接入：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/App.tsx:49`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/App.tsx:87`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/App.tsx:99`
- 教程组件：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/onboarding/OnboardingView.tsx:45`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/tutorial/TutorialBanner.tsx:17`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/tutorial/TutorialViewer.tsx:15`
- 后端服务与 IPC：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/lib/tutorial-service.ts:34`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/lib/tutorial-service.ts:61`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:354`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:362`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/chat.ts:342`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/chat.ts:344`

**Lume 当前锚点**
- 无 onboarding/tutorial/welcome conversation 对应通道与页面。

**对齐动作**
- 引入最小新手引导（环境检查 + 首个示例会话）。

**取舍点**
- 方案 A（推荐）：轻量 onboarding，仅保留关键路径，避免复制完整文案体系。
- 方案 B：全量复制 Proma 教程体系，维护成本更高。

---

### P0-AGT-001 Agent Teams 专项面板（Team Activity）

**Proma 精确代码位置**
- 团队面板：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/agent/TeamActivityPanel.tsx:60`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/agent/SidePanel.tsx:337`
- 数据重建与缓存：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/agent/AgentView.tsx:196`
- IPC 与读取器：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:934`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:936`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1083`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1091`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/lib/agent-team-reader.ts:227`

**Lume 当前锚点**
- 以事件时间线为主：`/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web/components/agent/EventTimeline.tsx:51`

**对齐动作**
- 增加可切换的 Team 视图（任务板 + Agent 状态 + inbox）。

**取舍点**
- 方案 A（推荐）：保留 Lume 时间线，新增 Team 视图作为并列模式。
- 方案 B：用 Team 视图替换时间线；会损失 Lume 现有通用调试可读性。

---

### P0-AGT-002 Agent 会话高级操作（迁移/置顶/跨工作区）

**Proma 精确代码位置**
- 通道定义：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:802`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:804`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:806`
- 主进程处理：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:657`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:665`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:676`
- preload API：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:825`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:829`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:833`

**Lume 当前锚点**
- `AGENT_IPC_CHANNELS` 不含上述迁移/置顶通道：`/Users/cavinhuang/workspace/projects/ai-projects/Lume/packages/shared/src/types/agent.ts:504`

**对齐动作**
- 增补会话迁移与置顶能力，避免多工作区管理体验断层。

**取舍点**
- 方案 A（推荐）：先补 `toggle pin` 与 `move session`。
- 方案 B：连同 `migrate chat->agent` 一起做；会牵涉 chat 历史结构映射。

---

### P0-FS-001 Agent 文件系统高级操作族

**Proma 精确代码位置**
- 通道定义：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:892`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:894`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:896`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:898`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/agent.ts:908`
- 主进程实现：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1309`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1318`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1337`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1357`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1433`
- 前端调用：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:1079`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:1083`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:1087`

**Lume 当前锚点**
- 仅基础目录操作与 copy-folder。

**对齐动作**
- 增加 rename/move/preview/attached-dir/search API，并在文件浏览器暴露操作入口。

**取舍点**
- 方案 A（推荐）：先补 rename/move/search（高频）。
- 方案 B：一步到位补齐 attached-dir 全族能力，开发面较大。

---

## P1 清单

### P1-WS-001 多标签 + 分屏工作台

**Proma 精确代码位置**
- 状态与算法：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/atoms/tab-atoms.ts:73`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/atoms/tab-atoms.ts:76`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/atoms/tab-atoms.ts:119`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/atoms/tab-atoms.ts:232`
- UI 组合：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/tabs/MainArea.tsx:18`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/tabs/TabBar.tsx:38`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/tabs/SplitContainer.tsx:30`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/tabs/SplitModeToggle.tsx:69`

**Lume 当前锚点**
- 未见 tabs/split 入口（当前单主视图模式）。

**取舍点**
- 方案 A（推荐）：Lume 保持单视图，先补“会话快速切换”与“固定会话”能力。
- 方案 B：直接引入多标签分屏；收益高但会重构较多状态管理。

---

### P1-FEI-001 飞书桥接态能力（presence/通知模式/绑定管理）

**Proma 精确代码位置**
- 设置页：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/FeishuSettings.tsx:773`
- 聊天通知切换：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/chat/FeishuNotifyToggle.tsx:35`
- 协议常量：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/feishu.ts:189`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/feishu.ts:213`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/feishu.ts:215`
- IPC：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1679`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1687`

**Lume 当前锚点**
- 采用 channel-gateway 统一入口（含飞书配置），无 chat 内通知模式切换。

**取舍点**
- 方案 A（推荐）：保留 Lume channel-gateway 架构，仅补 chat 侧 notify mode。
- 方案 B：整体改回 Proma bridge 架构，不建议，会削弱 Lume 多渠道统一层。

---

### P1-OPS-001 环境检测（Node/Git 健康卡）

**Proma 精确代码位置**
- 检测器：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/lib/environment-checker.ts:78`
- IPC 入口：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:554`
- About 使用：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/AboutSettings.tsx:199`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/AboutSettings.tsx:253`
- 卡片组件：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/environment/EnvironmentCheckCard.tsx:30`

**Lume 当前锚点**
- About 页仅 desktop/sidecar healthcheck：`/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web/components/settings/AboutSettings.tsx:15`

**取舍点**
- 方案 A（推荐）：保留现有 healthcheck，再新增 “Agent 环境检测”区块。
- 方案 B：完全替换成 Proma 风格检测页。

---

### P1-OPS-002 版本历史与 Release Notes 浏览

**Proma 精确代码位置**
- About 入口：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/AboutSettings.tsx:35`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/AboutSettings.tsx:439`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/AboutSettings.tsx:442`
- 组件：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/ReleaseNotesViewer.tsx:50`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/VersionHistory.tsx:16`
- 后端能力：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1566`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1574`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:1582`

**Lume 当前锚点**
- About 页有 updater 状态，但无 release 历史浏览。

**取舍点**
- 方案 A（推荐）：新增只读 Release Notes 与历史列表。
- 方案 B：保持简版 About（如果产品定位强调极简）。

---

## P2 清单

### P2-CHAT-003 附件图片原生“另存为”

**Proma 精确代码位置**
- 通道定义：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/packages/shared/src/types/chat.ts:328`
- IPC：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:446`
- preload：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/preload/index.ts:711`
- 消息 UI 调用：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/ai-elements/message.tsx:566`

**Lume 当前锚点**
- Chat 协议无 `SAVE_IMAGE_AS`。

**取舍点**
- 方案 A（推荐）：桌面端补齐，Web 端保留浏览器默认下载。
- 方案 B：不做，接受能力差异。

---

### P2-OPS-003 全局代理语义一致化（Chat+Agent）

**Proma 精确代码位置**
- UI：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/components/settings/ProxySettings.tsx:21`
- 状态：`/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/atoms/proxy-atoms.ts:15`
- IPC：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:569`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:577`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/main/ipc.ts:585`

**Lume 当前锚点**
- 代理放在通用设置但语义偏 Agent 工具请求：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web/components/settings/GeneralSettings.tsx:202`

**取舍点**
- 方案 A（推荐）：明确文案为“网络工具代理”，先不扩大为全局模型请求代理。
- 方案 B：升级为全局代理（Chat+Agent 所有上游请求），需梳理 sidecar provider 层。

---

## 反向取舍（Lume 已有且建议保留，不应盲目回退到 Proma）

1. 自动化任务（Cron）
- Lume：`/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web/components/settings/AgentSettings.tsx:731`
- 取舍建议：保留。

2. 外部渠道网关统一层（不仅飞书）
- Lume：`/Users/cavinhuang/workspace/projects/ai-projects/Lume/packages/shared/src/types/channel-gateway.ts:136`
- 取舍建议：保留统一网关架构，不要退化为单飞书桥接专用设计。

3. Plan 模式状态机与计划文件链路
- Lume：
  - `/Users/cavinhuang/workspace/projects/ai-projects/Lume/apps/web/atoms/plan-atoms.ts:87`
  - `/Users/cavinhuang/workspace/projects/ai-projects/Lume/packages/shared/src/types/agent.ts:619`
- 取舍建议：保留。

---

## 建议执行顺序

1. 先做 `P0-SET-001`（设置入口齐套）
2. 再做 `P0-CHAT-001` + `P0-CHAT-002`（聊天核心能力）
3. 再做 `P0-CORE-001`（新手路径）
4. 再做 `P0-AGT-001` + `P0-AGT-002` + `P0-FS-001`（Agent 核心）
5. 最后推进 `P1/P2`（运营与体验增强）

---

## 验收标准（建议）

- 每个条目都至少有：
  - 对应 UI 入口
  - 对应 IPC/sidecar 通道
  - 手动回归步骤（1-3 条）
- 对于“取舍保留”的项，必须在 PR 描述中明确写出“为什么不对齐 Proma”。

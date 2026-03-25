# Web 渲染与动作逻辑拆分计划

最后更新：2026-03-25

## 1. 背景

当前 `apps/web` 的前端架构方向是正确的：

1. `desktop-api` 作为唯一 sidecar 边界
2. `atoms` 作为共享状态中心
3. `ChatView / AgentView / SettingsPanel` 作为主页面入口
4. `shared runtime status` 已逐步取代前端本地运行态推断

但当前仍存在明显的“超重控制器文件”问题：

1. `components/agent/AgentView.tsx`
2. `components/chat/ChatView.tsx`
3. `components/app-shell/LeftSidebar.tsx`
4. `atoms/agent-atoms.ts`
5. `lib/desktop-api.ts`

本计划的目标不是重写前端，而是把已存在的逻辑边界显式化，使：

1. View 组件只负责渲染编排
2. 动作编排转移到 hooks/controller
3. 纯逻辑转移到 `lib/*`
4. `desktop-api` 按域拆分

## 2. 当前事实清单

### 2.1 根入口

1. `App.tsx`
   - 主题应用
   - IPC 协议 healthcheck
   - 全局 sidecar 订阅（workspace capabilities/files changed）
2. `components/app-shell/AppShell.tsx`
   - 应用布局壳
3. `components/app-shell/MainContentPanel.tsx`
   - 根据 `appModeAtom + activeViewAtom` 选择 `ChatView / AgentView / SettingsPanel`

### 2.2 主要状态中心

1. `atoms/chat-atoms.ts`
2. `atoms/agent-atoms.ts`
3. `atoms/plan-atoms.ts`
4. `atoms/system-prompt-atoms.ts`
5. `atoms/theme.ts`
6. `atoms/onboarding.ts`

### 2.3 主要页面入口

1. `components/chat/ChatView.tsx`
2. `components/agent/AgentView.tsx`
3. `components/settings/SettingsPanel.tsx`
4. `components/app-shell/LeftSidebar.tsx`

### 2.4 当前最重的逻辑中心

1. `AgentView.tsx`
   - 会话生命周期
   - stream/runtime 订阅
   - 发送/重发/截断/编辑
   - ask-user / tool-permission
   - plan flow
   - team activity
   - side panel
   - attachments/folders
   - watchdog
2. `ChatView.tsx`
   - 会话加载
   - stream 订阅
   - optimistic send
   - stream finalizer
   - attachments
   - inline edit / resend / truncate
   - onboarding
3. `LeftSidebar.tsx`
   - conversations/sessions/workspaces 初始化
   - create/delete/rename/pin/move
   - child session tree
   - capability badge

## 3. 拆分原则

1. sidecar 仍然是唯一真相源；前端只保留临时渲染态
2. atoms 负责共享状态，不承担重动作编排
3. hooks/controller 负责页面级动作流程
4. `lib/*` 负责纯逻辑与 helper
5. `desktop-api` 按域拆分，但保留统一出口，避免迁移期间大面积改 import

## 4. 拆分范围

### Phase A：拆 `desktop-api`

目标：

1. 将 `lib/desktop-api.ts` 的实现按域下沉到 `lib/desktop-api/`
2. 保留 `lib/desktop-api.ts` 作为兼容出口，逐步迁移调用方

目标模块：

1. `lib/desktop-api/core.ts`
2. `lib/desktop-api/chat.ts`
3. `lib/desktop-api/agent.ts`
4. `lib/desktop-api/system.ts`
5. `lib/desktop-api/events.ts`（若后续需要）
6. `lib/desktop-api/index.ts`
7. `lib/desktop-api/types.ts`

当前状态：

1. `core.ts / chat.ts / agent.ts / system.ts / index.ts / types.ts` 已创建
2. 当前仍未迁移现有调用方，兼容出口仍保留在 `lib/desktop-api.ts`

### Phase B：拆 `AgentView`

目标：

将 `components/agent/AgentView.tsx` 拆成以下 hook：

1. `hooks/useAgentSessionLifecycle.ts`
2. `hooks/useAgentStreamSubscriptions.ts`
3. `hooks/useAgentComposer.ts`
4. `hooks/useAgentPlanFlow.ts`
5. `hooks/useAgentRuntimeGuard.ts`
6. `hooks/useAgentSidePanelState.ts`

拆分后 `AgentView.tsx` 应只保留：

1. 页面级 atom 读取
2. hook 调用
3. JSX 组合

### Phase C：拆 `ChatView`

目标：

将 `components/chat/ChatView.tsx` 拆成以下 hook：

1. `hooks/useChatSessionLifecycle.ts`
2. `hooks/useChatStreamSubscriptions.ts`
3. `hooks/useChatComposer.ts`
4. `hooks/useChatPromptSelection.ts`
5. `hooks/useChatOnboardingFlow.ts`

### Phase D：拆 `LeftSidebar`

目标：

将 `components/app-shell/LeftSidebar.tsx` 拆成：

1. `hooks/useConversationListController.ts`
2. `hooks/useAgentSessionListController.ts`
3. `hooks/useWorkspaceSidebarState.ts`
4. `ConversationSidebarSection.tsx`
5. `AgentSidebarSection.tsx`
6. `SidebarSettingsEntry.tsx`

### Phase E：给 `agent-atoms.ts` 减负

目标：

将纯逻辑从 `atoms/agent-atoms.ts` 下沉到：

1. `lib/agent-timeline.ts`
2. `lib/agent-streaming.ts`
3. `lib/agent-tool-activity.ts`

保留 atom 作为“状态层”，不继续增长成前端 runtime。

## 5. 推荐执行顺序

1. 先完成 Phase A：`desktop-api` 按域拆分
2. 再完成 Phase B：拆 `AgentView`
3. 再完成 Phase C：拆 `ChatView`
4. 再完成 Phase D：拆 `LeftSidebar`
5. 最后完成 Phase E：清理 `agent-atoms`

原因：

1. `desktop-api` 是所有页面动作边界，先拆边界最稳
2. `AgentView` 风险最高、收益最大，应优先减负
3. `ChatView` 第二
4. `LeftSidebar` 第三
5. atoms 减负应放最后，避免中途放大耦合变化

## 6. 验收方式

每个阶段至少执行：

```bash
bun run --filter @lume/web typecheck
```

并根据阶段补相应测试：

1. `desktop-api` 导出测试
2. `agent-runtime-status` / helper 测试
3. 必要的页面级行为回归测试

手工 smoke 建议：

1. Chat 发送 / 停止 / 重发 / 截断
2. Agent 发送 / ask-user / tool-permission / compact
3. Sidebar 新建 / 切换 / 删除 / 重命名 / pin

## 7. 当前结论

当前前端“方向合理，但控制器文件过重”。

因此：

1. 不需要推翻现有架构
2. 需要通过 hook/controller + `desktop-api` 拆分降低复杂度
3. 拆分应逐步进行，优先减轻 `AgentView / ChatView / LeftSidebar`

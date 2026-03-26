# Web 渲染与动作逻辑拆分计划

最后更新：2026-03-26

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

当前规模（2026-03-26）：

1. `components/agent/AgentView.tsx`: `822` 行
2. `components/chat/ChatView.tsx`: `344` 行
3. `components/app-shell/LeftSidebar.tsx`: `325` 行
4. `atoms/agent-atoms.ts`: `164` 行
5. `lib/desktop-api.ts`: `7` 行

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

1. `core.ts / chat.ts / agent.ts / system.ts / index.ts / types.ts` 已创建并投入使用
2. `apps/web` 调用方已迁移到分域入口
3. `lib/desktop-api.ts` 已缩减为兼容 re-export shim
4. `@lume/web typecheck` 已通过

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

当前状态：

1. 已创建：
   - `hooks/useAgentSessionLifecycle.ts`
   - `hooks/useAgentStreamSubscriptions.ts`
   - `hooks/useAgentComposer.ts`
   - `hooks/useAgentPlanFlow.ts`
   - `hooks/useAgentRuntimeGuard.ts`
   - `hooks/useAgentSidePanelState.ts`
   - `hooks/useAgentInteractiveRequests.ts`
   - `hooks/useAgentTeamActivity.ts`
2. 已补纯逻辑模块：
   - `agent-session-lifecycle.ts`
   - `agent-stream-subscriptions.ts`
   - `agent-runtime-guard.ts`
   - `agent-composer.ts`
   - `agent-plan-flow.ts`
   - `agent-side-panel-state.ts`
   - `agent-interactive-requests.ts`
   - `agent-team-activity.ts`
3. `AgentView.tsx` 已明显减负，但仍保留页面编排与少量局部渲染逻辑

### Phase C：拆 `ChatView`

目标：

将 `components/chat/ChatView.tsx` 拆成以下 hook：

1. `hooks/useChatSessionLifecycle.ts`
2. `hooks/useChatStreamSubscriptions.ts`
3. `hooks/useChatComposer.ts`
4. `hooks/useChatPromptSelection.ts`
5. `hooks/useChatOnboardingFlow.ts`

当前状态：

1. 已创建：
   - `hooks/useChatSessionLifecycle.ts`
   - `hooks/useChatStreamSubscriptions.ts`
   - `hooks/useChatComposer.ts`
   - `hooks/useChatOnboardingFlow.ts`
2. 已补纯逻辑模块：
   - `chat-session-lifecycle.ts`
   - `chat-stream-subscriptions.ts`
   - `chat-composer.ts`
   - `chat-onboarding-flow.ts`
3. `ChatView.tsx` 已进入轻量页面编排状态

### Phase D：拆 `LeftSidebar`

目标：

将 `components/app-shell/LeftSidebar.tsx` 拆成：

1. `hooks/useConversationListController.ts`
2. `hooks/useAgentSessionListController.ts`
3. `hooks/useWorkspaceSidebarState.ts`
4. `ConversationSidebarSection.tsx`
5. `AgentSidebarSection.tsx`
6. `SidebarSettingsEntry.tsx`

当前状态：

1. 已创建：
   - `hooks/useConversationListController.ts`
   - `hooks/useAgentSessionListController.ts`
   - `hooks/useWorkspaceSidebarState.ts`
   - `ConversationSidebarSection.tsx`
   - `AgentSidebarSection.tsx`
   - `SidebarSettingsEntry.tsx`
2. `LeftSidebar.tsx` 已从控制器 + 大段列表模板混合体缩减为主编排层
3. workspace 初始化 / capability badge / settings 入口已收口到独立 hook/组件

### Phase E：给 `agent-atoms.ts` 减负

目标：

将纯逻辑从 `atoms/agent-atoms.ts` 下沉到：

1. `lib/agent-timeline.ts`
2. `lib/agent-streaming.ts`
3. `lib/agent-tool-activity.ts`

保留 atom 作为“状态层”，不继续增长成前端 runtime。

当前状态：

1. 已创建：
   - `lib/agent-timeline.ts`
   - `lib/agent-streaming.ts`
   - `lib/agent-tool-activity.ts`
2. `atoms/agent-atoms.ts` 已改为以状态定义与 atom 导出为主
3. `team-activity.ts` 已开始复用 `lib/agent-tool-activity.ts`

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

当前已补统一验证入口：

```bash
bun run --filter @lume/web test
```

```bash
bun run --filter @lume/web test:smoke
```

仓库根也可直接执行：

```bash
bun run test:web
```

```bash
bun run smoke:web
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

当前前端“方向合理，主要控制器与 runtime helper 已完成一轮系统减负”。

因此：

1. 不需要推翻现有架构
2. `desktop-api / AgentView / ChatView / LeftSidebar / agent-atoms` 五条主线已基本完成本轮拆分目标
3. `apps/web` 当前更适合进入“维护态 + 回归验证优先”，而不是继续做通用拆分
4. 后续重点应转向：
   - 保持 `bun run --filter @lume/web test` 与 `bun run smoke:web` 常态化回归
   - 仅在 `AgentView.tsx` 出现明确可证明收益时再继续下沉少量局部逻辑
   - 主精力切换到 sidecar 下一阶段分层与服务边界收口

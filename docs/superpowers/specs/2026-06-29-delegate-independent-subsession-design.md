# 委派式独立子会话（Delegate）设计 — 阶段 1

| 项 | 值 |
|---|---|
| 日期 | 2026-06-29 |
| 状态 | 待审查 |
| 阶段 | 阶段 1（共三阶段） |
| 对标参考 | Proma 链路 B（collaboration） |

---

## 1. 背景与目标

为 lume 增加"主 agent 可显式委派一个**会话栏可见的独立子会话**"的能力，并支持**会话栏 hover 预览消息**。

参考 Proma 链路 B（collaboration）的设计：subagent 作为真实独立会话出现在左侧会话栏，父会话下以父子树展示，hover 时 popup 预览该会话消息。

## 2. 关键发现（决定工作量）

探索 lume 既有实现后确认：**lume 的 subagent 在存储层早已是"独立 runtime session"**，并非 Proma 链路 A 那种"进程内临时嵌套"。

- `sidecarAgentTool`（`apps/sidecar/src/services/agent-runtime/runtime-core/run.ts:679-790`）已用 `childThreadId` 作为独立 `lumeSessionId` 跑完整 runtime（`run.ts:361-373`），有独立 transcript / run-state / trace。
- `SubagentRun` 已完整建模 `childThreadId`/`parentThreadId`/`rootThreadId`/`depth`（`apps/sidecar/src/services/agent/subagents/subagent-run.types.ts:19-48`）。
- `AgentThreadMeta.parentThreadId` 字段**已定义**（`packages/shared/src/types/agent.ts:147`），`createAgentThreadWithModelRef` 已接受该参数（`agent-thread-manager.ts:169`）——但**无任何业务调用方传它**。

真正的缺口只有 3 个：

| 缺口 | 位置 |
|---|---|
| childThread 未写入 `agent-sessions.json` 索引 | `run.ts` 从未调 `createAgentThread` |
| `parentThreadId` 字段未被赋值 | 无业务调用方 |
| 前端会话栏丢弃 `parentThreadId`、平铺渲染 | `lume-sidebar-view-model.ts:204-215` |

**结论**：本特性"最难部分"（独立 session、transcript、关系建模、事件流投影）已全部实现。阶段 1 是在现有骨架上做最小激活。

## 3. 范围与非目标

### 3.1 范围（阶段 1）
1. 新增 `DelegateTool`：主 agent 显式委派 → 创建会话栏可见的独立子会话。
2. 会话栏父子树展示（嵌套折叠，对标 Proma `LeftSidebar`）。
3. 会话栏 hover 预览（所有 thread，含子会话）。
4. 子会话结果回传父（复用现有 subagent 回传）。

### 3.2 非目标（留待后续阶段）
- ❌ 显式 `wait` 工具 / Promise 信号量收敛 / 异步 delegate（阶段 2）
- ❌ 并行委派的显式管理（阶段 2；阶段 1 天然支持并行但无收敛）
- ❌ 子会话 ask/permission 冒泡到父代答（阶段 3）
- ❌ 子会话独立停止入口（阶段 1 通过父级联中止处理）

## 4. 设计决策

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 架构 | 双模式并存（工具名区分） | AgentTool 保持不进索引（临时探索，会话栏干净）；DelegateTool 进索引（显式委派，可见） |
| D2 | 执行模型 | 新增独立 `DelegateTool`，同步 | 阶段 1 无 wait 工具，同步是父拿到结果的最简方式；复用现有 subagent 同步回传 |
| D3 | 会话栏展示 | 方案 A：嵌套折叠 | 父子树 + 完成计数 N/M + 蓝竖线缩进，最直接满足"会话栏看到子级会话" |
| D4 | 双模式区分 | 工具名区分 | 避免所有临时 subagent 污染会话栏 |
| D5 | 子会话创建通知 | 复用 `MESSAGE_APPENDED → LIST_THREADS` 全量重拉 | 最小改动，零新增 IPC，符合 YAGNI |
| D6 | 父中止 | 级联中止运行中子会话 | 同步语义下父中止=取消委派，避免孤儿子会话 |
| D7 | 层级深度 | 只允许一级 | delegate 子会话不可再 delegate，会话栏树最多两层 |
| D8 | 父归档 | 级联归档子会话 | 保持会话栏整洁 |

## 5. 后端设计

### 5.1 新增 `DelegateTool`（`apps/sidecar/.../runtime-core/run.ts`）

与现有 `sidecarAgentTool`（`:679-790`）并列，**复用约 80% 逻辑**：

```
DelegateTool.call(input, ctx):
  ├─ resolveSubagentSpawnPolicy(ctx)          // 复用：深度/扇出校验（D7 借此拦截二级 delegate）
  ├─ ★ createAgentThreadWithModelRef(         // 新增：创建可见子会话
  │     input.thread_title ?? input.description,
  │     modelRef, channelId, workspaceId,
  │     parentThreadId = ctx.threadId,        // 建立父子关系
  │     modelId)
  │   → childThreadId = meta.id
  ├─ buildSidecarSubagentRunContext(...)      // 复用，childThreadId 用上面的 meta.id
  ├─ runSidecarSubagent(...)                  // 复用：独立 runtime + 结果回传
  └─ onSubagentEnd: updateAgentThreadMeta(    // 新增：完成时补标题
       childThreadId, { title: generateAgentTitle(...) ?? input.description })
```

- **input schema**：复用 AgentTool 的 `prompt`/`description`/`subagent_type`/`model`/`mode`，加可选 `thread_title`。
- `isConcurrencySafe: true`（支持并行，与 AgentTool 一致）。
- `isReadOnly: false`，`isEnabled: () => true`。
- 注册到 `buildRuntimeCoreTools` 的 `groups`（`:802-814`），与 `sidecarAgentTool` 同组。

### 5.2 父子关系持久化（无破坏性变更）

- `createAgentThreadWithModelRef` 已接受 `parentThreadId`（`agent-thread-manager.ts:169`），**无需改 manager**。
- childThread 写入 `agent-sessions.json` 索引 → 自动进 `listAgentThreads()` 返回 → 前端可见。
- `SubagentRun.childThreadId` 复用现有字段（`subagent-run.types.ts:25`）。

### 5.3 子会话完成回传（完全复用）

- 结果回传主 agent：`finalizeSubagentOutputFromState` → `outcome.output`（`packages/sdk/src/tools/subagent-output.ts:84-117`）。
- 完成事件流向前端：`announceSubagentCompletion` → `SUBAGENT_COMPLETED` IPC → `agentSubagentRunsAtom`（`useGlobalAgentListeners.ts:188-229`）。

### 5.4 层级深度拦截（D7）

复用 `resolveSubagentSpawnPolicy`（`subagent-policy.ts:30-70`）。delegate 子会话的 `depth=1`，其 runtime 内再调 delegate 时 `depth=2` 超限被拒。无需新增校验代码，仅需把 delegate 也纳入既有 spawn policy。

## 6. 前端设计

### 6.1 会话栏父子树构建（`apps/web/src/components/app-shell/lume-sidebar-view-model.ts`）

- `LumeSidebarThreadItem` 扩展：`children?: LumeSidebarThreadItem[]`、`parentThreadId?`、`depth?`、`isDelegate?`。
- `buildLumeSidebarViewModel`（`:86-194`）改造：先按 `parentThreadId` 分桶 → 根线程（`parentThreadId == null`）为顶层，子线程挂到父 `children`。
- **"未分配工作区"分支（`:141-156`）也走同一树构建**。
- `buildThreadItem`（`:204-215`）改为保留 `parentThreadId`。
- 输入仍是 `AgentThreadMeta[]`，无破坏性变更。

### 6.2 ThreadItem 嵌套渲染（`ThreadItem.tsx` + `WorkspaceGroupItem.tsx`）

```
工作区：my-project
├─ 调研新框架         ⑂ 2/3 ▸       ← 父：GitBranch图标 + 完成计数 + 折叠箭头
│   └─ 展开（border-l-2 蓝竖线缩进）：
│      ├─ ⑂ 调研-React        ✓     ← 子：depth 缩进 + 状态图标
│      ├─ ⑂ 调研-Vue          ✓
│      └─ ⑂ 调研-Svelte       ⟳     ← 运行中
├─ 修复登录bug
└─ 写文档
```

- `ThreadItem` 新增 props：`children`、`depth`、`onToggleExpand`。
- 父项：`completed/total` 计数 + `ChevronRight`（展开 `rotate-90`）+ delegate 图标。
- 子项：按 `depth` 缩进 + 左竖线 + 状态图标（复用 `SubagentRun.status` 映射）。
- 折叠态记忆：新增 `expandedDelegateParentIds` Set atom（含"激活子会话时父自动展开"兜底）。
- `WorkspaceGroupItem` 改为递归渲染树。

### 6.3 hover 预览（新增 `ThreadMiniMapPopover`，复用现有数据源）

- `useThreadMiniMapHover(delayMs=600)` hook：600ms 防抖 + leave 延迟 + 移入面板取消关闭 + menuOpen 时禁用。
- **双源数据策略**：

| 场景 | 数据源 | 特点 |
|---|---|---|
| 已打开 thread | `agentRuntimeEventsFamily(id)` + `projectRuntimeEventMessages`（`runtime-event-message-projection.ts`） | 零延迟、含流式实时 |
| 未打开 thread | IPC `GET_RECENT_THREAD_MESSAGES(id, limit=N)`（`agent-handlers.ts:609`） | 读 transcript，轻量 |

- `createPortal` 到 body，anchor 右侧定位（空间不足翻左侧），渲染最近 N 条消息气泡（Markdown `line-clamp-2`），上限 80 条。
- **适用于所有 thread**（含子会话和普通会话）。

## 7. 端到端数据流

```
[后端] DelegateTool → createAgentThread(parentThreadId) → agent-sessions.json
   ↓ (子会话首条消息追加)
[IPC]  MESSAGE_APPENDED → LIST_THREADS 全量刷新（D5）
   ↓
[Atom] agentThreadsAtom → buildLumeSidebarViewModel 按 parentThreadId 构建树
   ↓
[渲染] 父会话项（计数+箭头）↔ 展开子会话（缩进+状态图标）
   ↓ hover ≥600ms
[预览] 已打开→runtime event投影 / 未打开→GET_RECENT_THREAD_MESSAGES

[状态] 子会话完成 → SUBAGENT_COMPLETED → agentSubagentRunsAtom → 父计数 + 子图标更新

[中止] 父中止 → 级联中止运行中子会话（D6）
```

## 8. 边界与错误处理

| 场景 | 处理 | 复用 |
|---|---|---|
| 子会话失败/超时/中止 | childThread 保留可见（错误图标），`outcome.error` 回传父 | 现有 `run.ts` onError 路径 |
| 子会话标题生成失败 | fallback 到 `description` | `generateAgentTitle` |
| 深度/扇出超限 | 抛错拒绝 | `resolveSubagentSpawnPolicy` |
| 父中止（D6） | 级联中止运行中子会话 | 扩展父 thread 中止逻辑，遍历其 active 子会话并 stop |
| 父归档（D8） | 子会话级联归档 | 扩展 `archiveAgentThread` |
| 并行 delegate | 天然支持，会话栏同时出现多个子会话 | 现有并行能力 |

## 9. 测试策略

遵循 lume AGENTS.md："不为仪式感补测试，只测可测试逻辑"。

- **后端测**：`DelegateTool` 创建 childThread + `parentThreadId` 关联、完成时标题更新（mock `createAgentThread` + `runSidecarSubagent`）—— 对标 `agent-tool.parallel.test.ts`。
- **前端测**：`buildLumeSidebarViewModel` 树构建（纯函数，对标现有 `lume-sidebar-view-model.test.ts`）+ hover 数据源选择逻辑。
- **不测**：纯样式（缩进/图标）、hover 防抖时序。

## 10. 成功标准（Goal-Driven）

1. 主 agent 调 DelegateTool → 会话栏出现子会话（父子树）→ verify: `agentThreadsAtom` 含 childThread 且 `parentThreadId === 父 id`。
2. 子会话完成 → 结果回传父 + 会话栏显示完成态 → verify: `SubagentRun.status === 'completed'` 且父计数 `N/M` 更新。
3. hover 任一会话项 → popup 显示最近消息 → verify: 已打开走投影、未打开走 `GET_RECENT_THREAD_MESSAGES`。
4. 父中止 → 运行中子会话随之中止 → verify: 子会话 status 转为 canceled/aborted，无孤儿子进程。
5. delegate 子会话内再调 delegate → 被拒 → verify: 抛深度超限错误，无孙会话产生。

## 11. 实现地图

### 后端（apps/sidecar）
| 文件 | 改动 | 复用 |
|---|---|---|
| `services/agent-runtime/runtime-core/run.ts:679-790` | 新增 `DelegateTool`，复用 `sidecarAgentTool` 结构 + 调 `createAgentThread` | `buildSidecarSubagentRunContext`/`runSidecarSubagent`/`finalizeSubagentOutputFromState` |
| `services/agent/agent-thread-manager.ts` | 无需改（`parentThreadId` 已支持） | `createAgentThreadWithModelRef` |
| `services/agent/subagents/subagent-run-registry.ts` | 无需改 | `create/update` |
| 父中止级联（D6） | 扩展父 thread 中止逻辑，遍历 active 子会话 stop | 现有 stop 路径 |
| `archiveAgentThread`（D8） | 扩展级联归档子会话 | 现有归档逻辑 |

### 前端（apps/web）
| 文件 | 改动 | 复用 |
|---|---|---|
| `components/app-shell/lume-sidebar-view-model.ts` | `LumeSidebarThreadItem` 加 `children`/`parentThreadId`/`depth`/`isDelegate`；构建树 | 输入仍是 `AgentThreadMeta[]` |
| `components/app-shell/ThreadItem.tsx` | 缩进 + 展开箭头 + delegate 图标 + 计数 | 现有交互保留 |
| `components/app-shell/WorkspaceGroupItem.tsx` | 递归渲染树 | - |
| 新增 `components/app-shell/ThreadMiniMapPopover.tsx` | hover 预览组件 + hook | `projectRuntimeEventMessages`/`GET_RECENT_THREAD_MESSAGES` |
| `atoms/agent-atoms.ts` | 加 `expandedDelegateParentIds` Set atom | jotai 模式 |

### 可直接复用（无需新写）
thread 持久化、subagent 执行 + 回传、runtime event 投影、SubagentRun registry、权限/深度/扇出策略、按 thread 切片订阅。

## 11.1 开放问题（plan 阶段需确认）

以下为实现细节，不改变本设计决策，但 plan 阶段需精确定位：

1. **会话栏渲染入口**：`LumeSidebar.tsx` 与 `LeftSidebar.tsx` 的关系（哪个是当前生效入口，或两者都需改）。设计层以 `lume-sidebar-view-model.ts` + `ThreadItem.tsx` 为锚点。
2. **父 thread 中止入口（D6）**：sidecar 侧中止一个 thread runtime 的精确函数/路径，以挂载"级联中止 active 子会话"逻辑。
3. **spawn policy 衔接（D7）**：确认 `DelegateTool` 是否纳入既有 `resolveSubagentSpawnPolicy` 的 depth 计数（使二级 delegate 自动被拒），或需新增 depth 校验。
4. **hover 预览 limit**：`GET_RECENT_THREAD_MESSAGES` 的 `limit` 取值，建议 12。
5. **`agentThreadsAtom` 过滤**：确认 `listAgentThreads()` 的 `status === 'active'` 过滤不会误排除失败/已完成的子会话（失败子会话需保持可见）。

## 12. 后续阶段展望

- **阶段 2（收敛）**：新增 `wait` 工具 + Promise 信号量，让父 agent 异步派发多个子会话并收敛结果（对标 Proma `delegate_agent` + `wait_for_delegations`）。
- **阶段 3（冒泡代答）**：子会话 ask/permission 冒泡到父会话，父代答后子继续（对标 Proma `delegation_blocked` + `answer_delegation_question`）。复用 lume 现有 `ask-user-service` / `approval-service`。

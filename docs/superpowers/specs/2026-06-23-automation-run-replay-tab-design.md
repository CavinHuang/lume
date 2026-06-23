# 自动化执行记录 → 只读会话回放 tab

- 日期：2026-06-23
- 状态：已确认，待实现
- 分支：feat/new-ui

## 背景

自动化任务详情页（`apps/web/src/components/automation/AutomationManagementView.tsx`）右侧的"运行历史记录"目前是纯文本列表，每条运行记录（`AutomationRun`）无任何点击行为。但每条 `AutomationRun` 已携带 `threadId?`（`packages/shared/src/types/automation.ts:130`），后端在执行自动化任务时会创建/复用一个 agent 线程、运行完成后将其归档（`apps/sidecar/src/services/automation/automation-runner-service.ts:181-184`）。因此每次自动化运行都对应一份完整、可回放的会话数据，只是前端没有把"运行记录"与"会话回放"关联起来。

打开会话的标准模式在仓库中已有三处先例（侧栏 `LeftSidebar.tsx:85-101`、命令面板、欢迎页）：`setActiveTabId(threadId)` + `setTabs`/`upsertTab` 加入一个 `{ id: threadId, type: 'agent', threadId, title }`。`AgentView` / `AgentMessages` 已支持渲染纯历史会话（无 runtime events 时降级，`AgentMessages.tsx:74-76`），归档线程凭 threadId 可直接取到完整历史。

## 目标

- 在自动化任务详情的运行历史记录中，点击某条执行记录可新开一个**应用内 tab**，以**只读回放**形态展示该次运行的完整会话（对话 + 工具调用流）。
- 复用现有会话渲染能力，不新建重复的会话组件。
- 后端零改动。

## 非目标

- 不做新开 OS 窗口（Tauri 多窗口）。本应用以应用内 tab 为导航原语，沿用之。
- 不做可分享/可深链的会话查看页（无 URL 路由，不在本次范围）。
- 不引入"可继续对话"的交互——只读。
- 不改动自动化执行/归档的后端逻辑。

## 设计

### 数据流

点击运行历史项 → 以 `run.threadId` 为 tab id，`upsertTab` 一个只读 agent tab → `setActiveTabId(run.threadId)` → `TabContent` 以 `readOnly` 渲染 `AgentView` → `AgentMessages` 凭 threadId 拉取历史（`getThreadRuntimeEvents` + `getThreadMessages`，归档线程可直接取到）→ 完整回放对话与工具调用流。

### 改动点（共 5 处文件）

1. **`apps/web/src/atoms/tab-atoms.ts`**
   - `Tab` 接口新增 `readOnly?: boolean`。

2. **`apps/web/src/components/tabs/TabContent.tsx:28-30`**
   - agent tab 分发改为 `<AgentView threadId={activeTab.threadId} readOnly={activeTab.readOnly} />`。

3. **`apps/web/src/components/agent/AgentView.tsx`**
   - `AgentViewProps` 新增 `readOnly?: boolean`（默认 false，现有行为不变）。
   - 为 true 时：
     - 不渲染输入区整块（当前 `:208-243`，含 `AgentInput` 及权限 `PermissionBanner` / 追问 `AskUserBanner` / 计划审批 `PlanApprovalOverlay` 三种交互浮层）。
     - 跳过桌面拖拽 `onDragDropEvent` 监听的注册（无输入框可投递附件）。
     - 将 `readOnly` 透传给 `AgentHeader`。
   - 保留：`AgentMessages`、`ErrorBanner`、文件/图片预览相关 plumbing（`openThreadFilePreview` / `openMemoryFilePreview` / `openThreadImagePreview`）。

4. **`apps/web/src/components/agent/AgentHeader.tsx`**
   - `AgentHeaderProps` 新增 `readOnly?: boolean`。
   - 为 true 时隐藏 `WorkspacePicker`（回放无需切换工作区）。
   - 保留线程标题与运行阶段徽标（历史线程通常显示"已完成"，有信息量）。

5. **`apps/web/src/components/automation/AutomationManagementView.tsx:1019-1031`**
   - 运行历史项可点击化（详见下一节）。

### 只读模式定义

- **隐藏**：输入框、三种交互浮层（权限 / 追问 / 计划审批）、工作区选择器、桌面拖拽。
- **保留**：消息流、工具调用渲染、文件/图片点击预览、运行阶段徽标。
- 归档线程无 pending 交互、无运行时事件流，只读模式天然安全；`readOnly` 仅作前端 UI 屏蔽，后端无只读语义（也不会有人触发发送）。

### 运行历史项交互

- `run.threadId` 存在：整行可点击（`cursor-pointer` + hover 底色），点击执行：
  ```ts
  setTabs(upsertTab(tabs, {
    id: run.threadId,
    type: 'agent',
    title: `自动化·${run.jobName} · ${formatRunTime(run.startedAt)}`,
    threadId: run.threadId,
    readOnly: true,
  }))
  setActiveTabId(run.threadId)
  ```
  - 按 `threadId` 去重（`upsertTab` 语义）：重复点击同一条记录会聚焦已打开的 tab。
  - tab 标题：`自动化·{jobName} · {MM-DD HH:mm}`，时间取 `run.startedAt`，优先复用仓库现有日期格式化工具，无则内联轻量格式化。
- `run.threadId` 缺失（极少数：线程创建前即失败的运行）：行不可点击，保持原样式，加 `title="无可查看的会话"` 浏览器原生提示。

### 边界与错误处理

- 会话不存在 / 无消息：`AgentMessages` 已有空态，不额外处理。
- 归档线程不在侧栏 threads 列表（`agent-thread-manager.ts:156` 过滤）：不影响，凭 threadId 直开。
- `tabsAtom` 为内存态（非持久化），重启后 tab 清空，符合预期。

## 验收标准

1. 自动化任务详情 → 运行历史记录中，**带 threadId** 的运行记录整行可点击；点击后打开一个标题为 `自动化·{jobName} · {时间}` 的只读 agent tab，展示该次运行的完整对话与工具调用流。
2. 打开的回放 tab **无输入框、无工作区选择器**；消息、工具调用、文件/图片预览均可正常查看。
3. 重复点击同一条运行记录，**复用**已存在的 tab（聚焦而非新开）。
4. **无 threadId** 的运行记录不可点击，hover 无可点击态，带"无可查看的会话"提示。
5. 默认（非只读）agent tab 行为**完全不变**（`AgentView` 默认 `readOnly=false`）。
6. 新增测试通过：运行记录点击 → 产生 `readOnly:true` tab 且切换 active；`AgentView readOnly` 不渲染输入框。

## 测试计划

- **主测**（`AutomationManagementView` 运行历史项接线）：
  - 渲染含一条带 `threadId` 的 run，点击该行 → 断言 `tabsAtom` 中出现 `readOnly: true` 且 `threadId` 正确的 tab，且 `activeTabIdAtom` 已切到该 threadId。
  - 渲染含一条无 `threadId` 的 run → 该行点击无副作用（无新 tab、不切换）。
- **次测**（`AgentView` 只读门控）：
  - `readOnly` 为 true → 不渲染 `AgentInput`（mock 必要 atom）。
  - `readOnly` 为 false（默认）→ 仍渲染 `AgentInput`（回归保护）。
- `AgentView` 的 atom 依赖较重，测试聚焦新增接线的渲染门控，不铺全量会话渲染测试。

## 非改动

- 后端（sidecar）自动化执行、线程归档、会话读写逻辑均不变。
- 现有侧栏 / 命令面板 / 欢迎页打开会话的逻辑不变。
- `AgentMessages` 及工具结果渲染器不变。

## 风险

- 低：`AgentView` 只读分支若遗漏屏蔽某交互入口，可能在回放 tab 触发非预期操作。缓解：改动集中在输入区整块与拖拽监听两处，且归档线程本无 pending 交互；测试覆盖输入框不渲染。
- 低：tab 以 `threadId` 为 id，理论上若同一 threadId 已作为可交互 tab 打开会发生状态覆盖；但自动化线程已归档、不在侧栏，实际不会与可交互 tab 冲突。

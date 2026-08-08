# 灵动岛 Phase 4（service 正确性 + planning 调度）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** 补齐 Lume 灵动岛 service 层相对 Proma 的正确性与调度差距——phase 优先级、dismiss visibilityKey 粒度、running 24h 剔除、hover 防疫、紧迫事件即时提权、planning 即时推送(M-3)、跨日 rollover+紧迫调度(M-4)、首推竞态(M-6)。

**Architecture:** 纯 service（`agent-island-service.ts`）+ 投影（`agent-island-projections.ts`）+ window（`agent-island-window.ts`，仅 M-6）层。**不碰 state schema**（不加 idleDashboard/recentSessions——留下批）。参考 Proma `apps/electron/src/main/lib/agent-island-service.ts`。

**Tech Stack:** TypeScript、`bun:test`（纯逻辑 TDD）、Electron BrowserWindow 事件（M-6）。

---

## Global Constraints

- **不碰 state schema**：不加 `idleDashboard`/`recentSessions`/`pill` 字段。本批只改 service 内部逻辑 + projections 纯函数。
- **不破坏 Phase 1/2/3**：Electron 推送路径、native 推送分支（service.push 第 287-294）、Phase 3 renderer/window 改动都不动。
- **service 命名**：`AgentIslandServiceDeps`（`this.deps`）。
- **apps/desktop import**：相对路径 `../../../packages/shared/src/...`。
- **测试**：`bun:test`。projections 纯函数 + service 可抽纯函数的部分必须 TDD。定时器/窗口事件类（Task 4/7/8）逻辑核心抽纯函数测，端到端留 finishing。
- **Proma 参考**：`D:/workspace/projects/ai-projects/Proma/apps/electron/src/main/lib/agent-island-service.ts`（行号见各 task）。
- **提交**：SDD 每 task 独立 commit、emoji 前缀。

---

## File Structure

**修改：**
- `packages/shared/src/agent-island-projections.ts` — PHASE_PRIORITY（Task 1）、buildVisibilityKey（Task 2）
- `packages/shared/src/agent-island-projections.test.ts` — 补 task 1/2 测
- `apps/desktop/src/agent-island-service.ts` — prune 24h（Task 3）、hover 防疫（Task 4）、即时提权（Task 5）、planning 即时推送（Task 6）、跨日+调度（Task 7）
- `apps/desktop/src/agent-island-window.ts` — did-finish-load 补推（Task 8，M-6）
- `apps/desktop/src/main.ts` — Task 6/7/8 的接线（planning 事件订阅、定时器 dispose、window ready 回调）

---

## Task 1: phase 优先级（error 应高于 completed）

**Files:** `packages/shared/src/agent-island-projections.ts` + test
**参考:** Proma `agent-island-service.ts:396-401`（attentionScore: needs-interaction(3) > error(2) > completed(1) > running(0)）
**现状:** Lume `PHASE_PRIORITY`（projections.ts:26-32）：needs-interaction(0) > running(1) > completed(2) > **error(3)** > idle(4) —— error 比 completed 更不优先，与 Proma 相反。

- [ ] **Step 1: 改测**（selectPrimarySession 排序）：多 session 时 error 应排在 completed 之前（更优先）。
- [ ] **Step 2: 改实现**：`PHASE_PRIORITY` 改为 `needs-interaction:0, error:1, completed:2, running:3, idle:4`（error 提到 completed 前；running 后置——Proma 是 running 最低，但 Lume 现状 running=1 也需调整以对齐"needs-interaction > error > completed > running"）。
- [ ] **Step 3: 测 PASS + commit** `🐛 fix(shared): 灵动岛 phase 优先级 error 提至 completed 之前(对齐 Proma)`

---

## Task 2: dismiss visibilityKey 拼全部 sessions + planningKeys 含 dueAt

**Files:** `packages/shared/src/agent-island-projections.ts` + test
**参考:** Proma `agent-island-service.ts:558-566`（拼全部 sessions 的 `sessionId:phase:lastActivityAt:detail` + planningKeys 含 `dueAt`/`startAt`）
**现状:** Lume `buildVisibilityKey`（projections.ts:72-84）只拼 **primary 单 session** + `[...todos,...reminders].id`。后果：改 todo dueAt（id 不变）不解除 dismiss；非 primary session 变化不解除。

- [ ] **Step 1: 改测**：改 dueAt 解除 dismiss；非 primary session phase 变化解除 dismiss。
- [ ] **Step 2: 改实现**：
  - `buildVisibilityKey(sessions: IslandSessionInput[], planning: AgentIslandPlanningSnapshot, now)` 拼全部 sessions（`threadId:phase:lastActivityAt:detail`）+ planningKeys 含 `dueAt`（`id:dueAt:overdue`）。
  - service `push`/`dismiss` 调用处适配（传全部 sessions + planning）。
- [ ] **Step 3: 测 PASS + commit** `🐛 fix(shared,desktop): 灵动岛 dismiss visibilityKey 拼全部 sessions+planningKeys(含 dueAt)`

---

## Task 3: running 24h 剔除

**Files:** `apps/desktop/src/agent-island-service.ts` + 抽纯函数到 projections + test
**参考:** Proma `agent-island-service.ts:385`（`isIslandSession` 用 `now - lastActivityAt >= 24h` 剔除）
**现状:** Lume `prune`（service.ts:250-254）只按 `terminalAt > 10min`，running/idle 永不清理 → 幽灵 session 累积。

- [ ] **Step 1: projections 加 `isStaleSession(session, now)` 纯函数 + 测**：`now - lastActivityAt >= 24h` 为真（且非 terminalAt 保留窗内）。
- [ ] **Step 2: service `prune` 加 24h 分支**：`if (isStaleSession(s, now)) delete`。
- [ ] **Step 3: 测 PASS + typecheck + commit** `🐛 fix(desktop,shared): 灵动岛 running 会话 24h 无活动剔除`

---

## Task 4: hover 防疫延迟

**Files:** `apps/desktop/src/agent-island-service.ts`
**参考:** Proma `agent-island-service.ts:850-883`（`pointerHovered` 即时高亮 + `hoverExpanded` 延迟：展开 300ms / 收起 420ms）
**现状:** Lume `handleIntent set-hovered`（service.ts:131-133）直接 `this.hoverExpanded = value`，无延迟 → 鼠标掠过立即展开又收起，视觉抖。

- [ ] **Step 1: 加 hover 定时器字段** `private hoverTimer` + 常量 `HOVER_EXPAND_MS=300` / `HOVER_COLLAPSE_MS=420`。
- [ ] **Step 2: set-hovered 分离 pointerHovered（即时，驱动高亮反馈）与 hoverExpanded（延迟）**：
  - `value=true` → 立即 pointerHovered=true（如有高亮反馈字段）；setTimeout 300ms 后 hoverExpanded=true + push
  - `value=false` → 立即 pointerHovered=false；setTimeout 420ms 后 hoverExpanded=false + push
  - 重复事件清旧 timer
- [ ] **Step 3:** 逻辑核心（定时器延迟）难 TDD，但可抽 `scheduleHover` 纯函数测延迟值选择；端到端留 finishing。typecheck + commit `✨ feat(desktop): 灵动岛 hover 展开收起防疫延迟(300/420ms)`

> **注意**：若 state 无 `hovered` 字段（首批不碰 schema），pointerHovered 高亮反馈只在 service 内部用（影响 presentation 计算），不进 state。可接受（视觉高亮是 renderer 侧 hover CSS，service 只控制 expanded 延迟）。

---

## Task 5: 紧迫事件即时提权节流

**Files:** `apps/desktop/src/agent-island-service.ts`
**参考:** Proma `agent-island-service.ts:735-741`（`requiresImmediateAgentIslandPush`：permission_request/ask_user_request/result/assistant.error 强制 80ms 桶）
**现状:** Lume `urgent(state)`（service.ts:308-312）只看 phase 终态（needs-interaction/completed/error）。事件到达瞬间若 phase 未翻，被 2000ms 节流拖延（permission 最多迟 2s）。

- [ ] **Step 1: 改 `urgent` 或加 `requiresImmediatePush`**：除 phase 终态外，识别**事件类型**（`handleSidecarNotification` 的 method/event.type：permission/ask_user/tool.started/result/error）→ 真。需把"本次事件是否紧迫"传入 push 决策。
- [ ] **Step 2:** `handleSidecarNotification` 计算 `const immediate = this.isImmediateEvent(method, params)`，传给 push（push 的 throttle 用 immediate 选 80ms）。
- [ ] **Step 3:** `isImmediateEvent` 抽纯函数测。typecheck + commit `✨ feat(desktop): 灵动岛紧迫事件即时提权节流(permission/ask_user 80ms 桶)`

---

## Task 6: M-3 planning 即时推送

**Files:** `apps/desktop/src/agent-island-service.ts` + `main.ts`
**参考:** Proma `agent-island-service.ts:629-636, 764-771`（`onPlanningChanged` → `pushPlanningStateImmediately` 绕节流）
**现状:** Lume 只 5min 轮询（service.ts:105-107, 215-236），完成/改期 todo 后岛屿内容最多延迟 5min。

- [ ] **Step 1: 确认 sidecar planning 变更事件**：读 sidecar 是否发 planning变更通知（如 `planning-todo:changed` / `onPlanningTodoChange`）。spec §1.3 提 `onPlanningTodoChange` / `onPlanningRemindersDue`。
- [ ] **Step 2: service 加 `onPlanningChanged()` → `await refreshPlanning()` + `push(true)`（force 绕节流）**。
- [ ] **Step 3: main.ts 把 sidecar planning 事件路由到 `getAgentIslandService().onPlanningChanged()`**（在 onNotification 处加分支）。
- [ ] **Step 4:** 若 sidecar 无 planning 变更事件（只有轮询），在 report 说明，保留 5min 轮询 + 文档 follow-up（不强行加 sidecar 事件）。typecheck + commit `✨ feat(desktop): 灵动岛 planning 变更即时推送(M-3)`

---

## Task 7: M-4 跨日 rollover + scheduleNextPlanningAttention

**Files:** `apps/desktop/src/agent-island-service.ts`
**参考:** Proma `agent-island-service.ts:671-707`（`scheduleNextPlanningRollover` 午夜 +150ms 清 dismiss + bump；`scheduleNextPlanningAttention` 算下个事项进入/退出 1h 窗口的时刻定时 bump）
**现状:** Lume 无任何午夜处理 + 无紧迫调度（只 5min 轮询）。

- [ ] **Step 1: `scheduleNextPlanningRollover`**：算下个午夜 00:00:00.150 的 timeout，触发：`dismissedKey=null` + `push(true)`。start() 启动；rollover 后重排下一个。
- [ ] **Step 2: `scheduleNextPlanningAttention`**：算下个 planning item（todo dueAt / reminder triggerAt）进入 1h 窗口的时刻，timeout 触发 `push(true)`（让岛屿浮现紧迫项）。refreshPlanning 后重排。
- [ ] **Step 3: destroy() 清 rollover/attention timer。** 逻辑核心（算下个午夜 / 下个 attention 时刻）抽纯函数测。typecheck + commit `✨ feat(desktop): 灵动岛跨日 rollover+紧迫 planning 调度(M-4)`

---

## Task 8: M-6 首推竞态（did-finish-load 补推）

**Files:** `apps/desktop/src/agent-island-window.ts` + `agent-island-service.ts` + `main.ts`
**参考:** Proma `agent-island-service.ts:783-787` + `agent-island-window.ts:165-169`（窗口 `did-finish-load` +120ms 后清空 lastStateJson + 补推）
**现状:** Lume `ensureIslandWindow` 只挂 `ready-to-show`（main.ts ~1314），未在 renderer 就绪后补推。`start()` 的 `push(true)` 时 webContents 可能未就绪 → `webContents.send` 静默丢失，要等下条 sidecar 通知才补。

- [ ] **Step 1: window 加 `onReady` 回调**：`createIslandWindow` 接收 `onReady` deps，在 `did-finish-load` + setTimeout(120ms) 调 onReady。
- [ ] **Step 2: service 加 `repush()`**：清 `lastStateJson=''` + `push(true)`（绕过去重 + 节流，强制再推一次）。
- [ ] **Step 3: main.ts 接线**：ensureIslandWindow 传 `onReady: () => getAgentIslandService().repush()`。
- [ ] **Step 4:** typecheck + commit `🐛 fix(desktop): 灵动岛首推竞态(window did-finish-load 后补推,M-6)`

---

## Self-Review

1. **覆盖**：phase 优先级→T1；visibilityKey→T2；24h 剔除→T3；hover→T4；即时提权→T5；M-3→T6；M-4→T7；M-6→T8。✅
2. **不碰 schema**：全在 service/projections/window 内部，不加 state 字段。✅
3. **TDD 边界**：T1/2/3/5/7（部分）纯函数可测；T4/6/8 定时器/事件端到端留 finishing。✅
4. **串行**：T1/T2 共改 projections；T3-8 共改 service（+ window T8）。SDD 串行 dispatch。
5. **不破坏前批**：push 路径（Electron + native）结构不变；Phase 3 renderer/window 不动。

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-08-05-agent-island-service-correctness.md`.

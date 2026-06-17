# Agent 消息极简显示模式 · 设计文档

- **日期**：2026-06-16
- **状态**：已通过设计评审，待实现
- **分支**：feat/new-ui
- **作者**：cavinHuang（与 Claude Code 协同设计）

## 1. 背景与问题

当前 agent 回合把每个工具调用、思考块、子代理调用都作为**独立 block 顺序渲染**（即使各自默认折叠）。
一条回合里这类过程块数量多、各自为政，造成视觉噪声，用户难以快速捕捉 agent 的**关键文字输出**（结论、解释）。

虽然每个块已支持「默认折叠 + 摘要预览」，但缺少：

- 全局的显示密度控制（无设置项）
- 跨消息/跨块的聚合（连续过程块无法合并成一条）
- 以「结论优先、过程退到背景」为原则的整体观感

## 2. 目标

- 新增「极简」显示模式：默认只露 agent 文字结论，过程（工具调用 / 思考 / 子代理）收进**一条可展开的次要色过程行**。
- 支持在设置中切换「极简 / 明细」。
- 极简模式成为**新用户默认**。
- 过程行内提供：工具调用计数、子代理计数、**区块内工具调用总时长**（运行中实时跳动）。
- 展开后每条工具可独立点开看完整结果。

## 3. 非目标（YAGNI，明确排除）

- 不做三档密度（极简 / 聚合 / 明细），只做二选一。
- 不做极简模式下的子开关（思考是否显示、子代理是否显示等）。
- 不做 LLM 智能摘要、侧栏抽屉、时间线、标签页等结构性变体（已在设计阶段确认排除）。
- 不改动现有「明细」模式的渲染逻辑。
- 不改动 `task_progress` / `memory_context_used` / `plan_preview` 等非过程块的现有展示。

## 4. 设计概述

### 4.1 两种模式

| 模式 | 行为 | 默认 |
|---|---|---|
| 极简 `minimal` | 过程块聚合为一条可展开过程行；文字结论主色内联 | ✅ 新用户默认 |
| 明细 `verbose` | 现状：每个过程块独立折叠渲染 | 可手动切换 |

### 4.2 极简模式渲染规则

过程信息一律使用**次要（亚一级）字体色**、**无胶囊/边框**；文字结论保持主色。

**折叠态（完成）**

```
▸ 🔧 N 操作 · 🤖 M 子代理 · ⏱ 总时长
```

- 次要色一行；`▸`/`▾` 箭头切换展开/收起，整行可点；**无「查看过程」文案**。
- `N` = 该过程组内非子代理的工具调用数；`M` = 子代理（`toolName === 'Agent'`）调用数。
- `⏱ 总时长` = 过程组内所有工具调用耗时之和；完成态定格。

**运行中态（`phase === 'streaming'` 且该过程组仍在活动）**

```
▸ ● 正在执行 <toolName> · 已完成 <N> 步 · ⏱ 12s
```

- 蓝色 `●` 活动指示。
- **不显示 X/Y 总数**（agent 回合是开放式的，事先未知总步数）；只显示已完成步数的绝对值。
- `⏱` 秒级实时往上跳，包含「当前正在跑的工具」的已用时间。
- 当该过程组无文字结论产出时，结论区不渲染（等流式产出后再出现）。

**展开态**

- 过程行箭头变 `▾`，下方列出过程组内各项，每项一行（次要色）：

  ```
  ▾ 🔧 N 操作 · 🤖 M 子代理 · ⏱ 8.3s
     💭 思考过程                       ▸
     🔧 Read — login.tsx              ▸  0.4s
     🔧 Grep — refreshToken（3 处）   ▸  0.3s
     🔧 Edit — login.tsx（+12 −3）    ▸  0.6s
     🔧 Bash — npm run test:auth ✓    ▸  2.1s
     🤖 子代理 Explore（只读）         ▸  4.2s
  ```

- 每行：名称 + 摘要（复用现有 `summarizeInput`）+ 单条耗时 + `▸`。
- 点某行的 `▸` 才展开**该工具的完整结果**（复用现有 `ToolResultRenderer`）；默认全部折叠。
- 文字结论（`type: text`）始终以主色内联显示在原位（过程组之前 / 之后 / 之间）。

**失败处理**

- 极简折叠态下，若过程组内有工具失败，过程行加 `⚠️` 并标出失败数：

  ```
  ▸ ⚠️ 🔧 6 操作 · 1 失败 · ⏱ 8.3s
  ```

- 展开后，失败的工具行用警示色高亮（状态徽章沿用现有 failed 样式）。

## 5. 数据模型与分组

### 5.1 现状

`apps/web/src/components/agent/runtime-message-view.ts` 中 `RuntimeAssistantMessageView.blocks: RuntimeAssistantBlock[]`
是**有序数组**，元素为 discriminated union：`text` / `thinking` / `tool_call` / `task_progress` / `memory_context_used` / `plan_preview`。
其中子代理本质是 `tool_call` 且 `toolName === 'Agent'`。

当前 `RuntimeEventContentBlock.tsx`（L98-165、L500-542）逐个 block 渲染。

### 5.2 极简模式的分组逻辑

引入一个「过程组」投影：遍历 `blocks`，把**相邻的连续过程块**（`thinking` 与 `tool_call`）合并成一个过程组；
`text` 块保持原位、原样内联渲染。

- 结果结构（仅渲染层面，不改底层数据）：`[文字] [过程组 → 一条过程行] [文字] [过程组 → 一条过程行] [文字]`
- 保留叙事顺序；一条消息可能出现多条过程行（文字之间各夹一组）。
- `task_progress` / `memory_context_used` / `plan_preview` 不参与分组，维持现有处理。

实现上建议在渲染层（`RuntimeEventContentBlock` 的 assistant 分支，或新增一个 `MinimalAssistantMessage` 组件）按 mode 做一次分组遍历，
不污染 `RuntimeAssistantBlock` 类型与投影逻辑。明细模式走原有逐块渲染路径，互不影响。

## 6. 设置

### 6.1 数据模型

在 `packages/shared/src/types/general-settings.ts` 的 `GeneralSettings` 增加字段：

```ts
agentMessageDisplayMode: 'minimal' | 'verbose'
```

- 同步加到 `UpdateGeneralSettingsInput`（可选字段）与 `GENERAL_SETTINGS_DEFAULTS`（默认 `'minimal'`）。

### 6.2 三层管线改动（复用现有模式）

1. **类型**：`packages/shared/src/types/general-settings.ts`（见 6.1）。
2. **Zod 校验**：`apps/sidecar/src/rpc/schemas.ts`（`updateGeneralSettingsInputSchema`，L1119 附近）加 `z.enum(['minimal','verbose'])`。
3. **持久化**：`apps/sidecar/src/services/system/general-settings-service.ts`（`getPersistedGeneralSettings` L184、`updatePersistedGeneralSettings` L201）的 sanitize/merge 识别并落盘新字段。
4. **Web state**：`apps/web/src/components/settings/general-settings-state.ts`（`mergeGeneralSettings` L60-82）透传新字段。

### 6.3 设置 UI

- `apps/web/src/components/settings/SettingsView.tsx`（L92-97）：把 `appearance` tab 的 `SettingsPlaceholder` 替换为新的 `AppearanceSettings` 组件。
- 新建 `apps/web/src/components/settings/AppearanceSettings.tsx`（+ 配套 `appearance-settings-state.ts`，参照现有 `*-settings-state.ts` 模式）。
- 内含一个分段开关：`[极简 | 明细]`，绑定 `agentMessageDisplayMode`，保存走现有 `updateGeneralSettings` IPC。

> 注：主题设置目前在 `GeneralSettings.tsx`（L183-208）。本次**不迁移**主题，只在该 tab 新增显示模式开关；主题迁移留作后续。如实现时发现 tab 结构需要调整，以最小改动为原则。

## 7. 耗时数据与实时跳动

### 7.1 单工具耗时

- 来源事件：`ToolStartedRuntimeEvent` / `ToolCompletedRuntimeEvent` / `ToolFailedRuntimeEvent`（`packages/shared/src/types/runtime-event.ts` L99/107/120），均带时间戳。
- 在投影层 `apps/web/src/components/agent/runtime-event-message-projection.ts`（必要时配合 `runtime-state-projections.ts`）为每条 `RuntimeToolCallView` 补充 `durationMs`：
  - 已完成 / 失败：`endTs - startTs`。
  - 运行中：留出 `startedAt`，由渲染层计算 `now - startedAt`。
- `RuntimeToolCallView`（`runtime-message-view.ts` L3-13）增加可选 `durationMs?: number` 与 `startedAt?: number`。

### 7.2 子代理耗时

- 已有来源：`agentSubagentRunsAtom`（现 UI 已展示如 `4.2s`），直接复用。

### 7.3 跳动机制

- 组件在当前 thread `phase === 'streaming'` 且存在运行中过程组时，用 `setInterval(1000)` 触发重渲染刷新 `⏱`；非运行态清除定时器。
- 数字使用 `font-variant-numeric: tabular-nums`，避免跳动时宽度抖动。
- **格式规则**：`< 60s` 显示 `Ns`（如 `12s`）；`≥ 60s` 用 `mm:ss`（如 `01:23`）；`≥ 1h` 用 `h:mm:ss`。
  - 运行中实时跳动按**整秒**（`12s`）。
  - 完成态总时长与单条耗时可为**小数秒**（如 `8.3s`、`0.4s`）。

## 8. 设置如何被渲染层读取

现状 web 端未把 `GeneralSettings` 放进全局 atom（设置页用组件局部 `useState`）。
渲染层需要响应式读取 `agentMessageDisplayMode`，因此：

- 新建 `apps/web/src/atoms` 下的 **`generalSettingsAtom`**（Jotai），应用启动时（与现有设置加载同处）调用 `getGeneralSettings` 加载一次并写入 atom；`updateGeneralSettings` 成功后同步更新 atom。
- `RuntimeEventContentBlock`（或新 `MinimalAssistantMessage`）通过 `useAtomValue(generalSettingsAtom)` 读取模式。

## 9. 受影响文件清单

| 改动 | 文件 | 关键位置 |
|---|---|---|
| 设置类型 | `packages/shared/src/types/general-settings.ts` | L15-25, L81-93 |
| Zod 校验 | `apps/sidecar/src/rpc/schemas.ts` | L1119 附近 |
| 持久化 | `apps/sidecar/src/services/system/general-settings-service.ts` | L184, L201 |
| Web state | `apps/web/src/components/settings/general-settings-state.ts` | L60-82 |
| 设置 UI 占位符 | `apps/web/src/components/settings/SettingsView.tsx` | L92-97 |
| 设置 nav 配置 | `apps/web/src/components/settings/settings-view-state.ts` | L40-102 |
| 新建设置组件 | `apps/web/src/components/settings/AppearanceSettings.tsx`（+ state） | 新增 |
| 设置 atom | `apps/web/src/atoms`（新增 `generalSettingsAtom`） | 新增 |
| assistant 消息渲染分发 | `apps/web/src/components/agent/RuntimeEventContentBlock.tsx` | L98-165, L500-542 |
| 工具调用视图类型（加 duration） | `apps/web/src/components/agent/runtime-message-view.ts` | L3-13 |
| 投影（补 durationMs） | `apps/web/src/components/agent/runtime-event-message-projection.ts` | 全文件 |
| 新建极简渲染组件 | `apps/web/src/components/agent/MinimalAssistantMessage.tsx`（建议） | 新增 |
| 折叠动画复用 | `apps/web/src/components/agent/AnimatedCollapsiblePanel.tsx` | 复用 |

## 10. 测试要点

- **设置**：切换 极简↔明细 持久化生效；重启后保留；新用户默认 `minimal`；zod 拒绝非法值。
- **分组**：`[text][tools][text][tools][text]` 正确产出 2 条过程行 + 3 段文字；纯文字消息无过程行；纯过程消息无文字。
- **计数**：N（非 Agent 工具）、M（Agent 子代理）统计正确。
- **耗时**：已完成工具 `durationMs` 正确；运行中 `⏱` 随秒跳动、停止后定格、数值 = 单条之和；`tabular-nums` 不抖。
- **运行态**：不出现 X/Y 总数；只显示已完成步数绝对值。
- **展开**：每行 ▸ 展开对应工具完整结果（复用 ToolResultRenderer）；默认全折叠。
- **失败**：失败工具使过程行显示 `⚠️ … · K 失败`；展开后失败行高亮。
- **明细模式回归**：切换后渲染与改动前完全一致（无回归）。

## 11. 开放问题（实现时确认）

- 主题是否随本次一并迁入「外观」tab —— 倾向**不迁**，留后续。
- 极简模式下 `task_progress` / `plan_preview` 是否需要更醒目 —— 本次保持现状。

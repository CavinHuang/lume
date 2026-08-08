# 输入队列 UI/交互对齐 Codex — 设计

> 日期：2026-08-04
> 起点：`origin/worktree-input-queue-codex-parity`（PR #7 语义层）
> 目标：把 composer 上方的消息队列从「折叠面板 + 原生拖拽」升级为 Codex 式「平铺浮层 + @dnd-kit + framer-motion」
> 关联：`docs/superpowers/plans/2026-08-03-input-queue-codex-parity.md`（PR #7 语义层计划）、记忆 `lume-input-queue-codex-parity`

## 0. TL;DR

PR #7 的三态/Resume/Retry 成果**在分支未进 main**（`77686603` 是丢失合并，`git grep main` 零命中）。本设计在 PR #7 分支基础上，做**纯 UI/交互层**的对齐：折叠面板 → 平铺浮层，原生 HTML5 拖拽 → @dnd-kit，无动画 → framer-motion，顺带修「关闭排队」菜单 bug。语义层（三态/横幅/Retry）不动。

## 1. 背景与关键事实修正

### 1.1 三条代码线
| | 位置 | 输入队列能力 |
|---|---|---|
| **Codex**（基准） | `app.asar` `webview/assets/queued-message-list-*.js` | 平铺浮层 + @dnd-kit + framer-motion + 附件汇总 + react-intl |
| **PR #7 分支** | `origin/worktree-input-queue-codex-parity` | 三态模型 + Resume 横幅 + blocked Retry + 三态切换菜单 + `summarizeQueuedMessage` 接入 + 富 steer（语义层完整） |
| **main 当前** | 工作区 | 旧版：折叠面板 + 原生 HTML5 拖拽 + 无三态/横幅/Retry |

PR #7 merge commit `77686603` 为丢失合并：分支 13 个代码文件含 `followUpQueueMode`/`retryQueuedMessage`/`agentQueueInterruptedAtom`，`main` 零命中。**记忆 `lume-input-queue-codex-parity` 须据此修正**。

### 1.2 起点选择
在 PR #7 分支继续（语义层已齐），用独立 worktree 隔离（main 有浏览器注释 WIP）。

## 2. Codex 参考实现摘要（逆向结论）

逆向 `queued-message-list-tFwRmZ8f.js`（17KB，React Compiler + rolldown）：

- **容器**：`<div class="vertical-scroll-fade-mask hide-scrollbar flex max-h-[30dvh] flex-col gap-px overflow-y-auto px-3 py-row-y">`；空队列 `return null`
- **三层**：`AnimatePresence > 滚动容器 > [interrupted 横幅] + DndContext > SortableContext > AnimatePresence > 行`
- **interrupted 横幅**：`title="Queue paused because you interrupted"` + `<Button>Resume</Button>`，队列级一等状态（中断后整队列暂停，手动 Resume 才续）
- **行级 paused**（=Lume blocked）：行首警告图标 + 双行 tooltip（「This queued message could not be sent」+「Retry, edit, or delete it to continue the queue」），主按钮变 Retry
- **正常 queued 主按钮**：Steer（「Submit without interrupting the model」），= 立即作 guidance 发送
- **拖拽**：@dnd-kit，`PointerSensor({distance:6})` + `KeyboardSensor`，`closestCenter`，`restrictToVertical`，`onDragEnd → arrayMove`
- **动画**：framer-motion `motion.div`，`initial{height:0,opacity:0}` `animate{height:auto,opacity:1}` `exit{height:0,opacity:0}` `duration:0.18`
- **行布局**：`[拖拽手柄] | [⚠] [图片预览] 文本(line-clamp-1) | [Steer/Retry] [Delete] [More]`
- **菜单**：Edit / Open in side chat / Turn off-on queueing
- **技术栈**：rolldown + Tailwind + react-intl + @dnd-kit + framer-motion

## 3. 决策摘要

| 维度 | 决策 | 理由 |
|---|---|---|
| 起点 | `worktree-input-queue-codex-parity` | 语义层已齐，避免重做 |
| 隔离 | 独立 worktree | main 有 WIP |
| 形态 | 平铺浮层 | 对齐 Codex |
| 拖拽 | @dnd-kit/core+sortable+modifiers | React DnD 事实标准，体验最贴 Codex |
| 动画 | framer-motion | height:auto + exit 动画标准方案 |
| 图片预览 | 本期不做（follow-up） | YAGNI，summarize 已汇总 |
| 文案 | 中文硬编码（不引 i18n） | Lume 全站中文，无 i18n 基建 |

## 4. 详细设计

### 4.1 组件树（折叠 → 平铺）
```
<div class="hide-scrollbar flex max-h-[30dvh] flex-col gap-px overflow-y-auto px-3 py-row-y">
  {interrupted && <InterruptedBanner onResume />}
  <DndContext sensors collisionDetection modifiers onDragEnd>
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <AnimatePresence initial={false}>
        {queuedMessages.map(item => <SortableQueuedRow key={item.id} ... />)}
      </AnimatePresence>
    </SortableContext>
  </DndContext>
  {pendingGuidance.map(item => <GuidanceRow ... />)}   // 引导区，置列表底部
</div>
```
空队列（无 queued 且无 guidance）`return null`。**移除折叠头部 / `expanded` / `defaultExpanded`**。

### 4.2 拖拽（@dnd-kit）
- `PointerSensor({activationConstraint:{distance:6}})` + `KeyboardSensor`
- `closestCenter`；`restrictToVerticalElement` + `restrictToParentElement`
- `useSortable({id})`：手柄作 activator（`setActivatorNodeRef`），避免误触行内按钮
- `onDragEnd({active,over})` → `arrayMove` → `onReorder(orderedIds)`

### 4.3 动画（framer-motion）
`AnimatePresence initial={false}` 包列表；每行 `motion.div`：
```
initial  {height:0, opacity:0}
animate  {height:'auto', opacity:1}
exit     {height:0, opacity:0}
transition {duration: 0.18}
```
拖拽中 `isDragging` → `opacity-60`。`motion.div` 接 `setNodeRef`（ref 转发，与 Codex `me.div ref=ie` 同款）。

### 4.4 行布局与状态
```
[⋮⋮手柄] [⚠blocked+tooltip]  文本(summarize,line-clamp-1)  [重试?] [引导] [🗑] [⋯]
```
| 状态 | 视觉 | 主操作 |
|---|---|---|
| 正常 queued | 手柄 + 文本 | 引导（=Codex Steer） |
| blocked | 行首 ⚠ 图标 + 双行 tooltip | 重试 |

- 替换行尾「已暂停」红色徽章 → 行首警告图标 + tooltip「发送失败：{reason}。重试、编辑或删除以继续队列」（对齐 Codex `pausedTooltip`/`pausedTooltipRemedy`）
- 文本沿用 `summarizeQueuedMessage(item)` + `line-clamp-1`

### 4.5 interrupted 横幅
列表顶部一等横幅：「队列已暂停（你中断了当前输出）」+「继续」按钮（`onResume`），warning 色。

### 4.6 Bug 修复
「关闭排队」菜单项 `onClick`：`onRemove()`（删消息，错）→ `onFollowUpModeChange('steer')`（切默认到引导，对齐 Codex `Turn off queueing`）。

### 4.7 props 契约
- **变更**：`onReorder: (draggedId, targetId, placement) => void` → `onReorder: (orderedIds: string[]) => void`
- **移除**：`defaultExpanded`
- **保留**：`onRemove` / `onEdit` / `onPromoteToGuidance` / `onRetry` / `interrupted` / `onResume` / `followUpMode` / `onFollowUpModeChange`
- 同步改 `AgentInput.tsx` 的 `handleQueueReorder`
- `reorderQueuedMessages` 纯函数 → 新增/改为 `applyOrderByIds(snapshot, orderedIds)`，配套测试

## 5. 测试策略（bun:test）
- 更新 `AgentMessageQueueList.contract.test.tsx`：平铺直渲染（无折叠）、interrupted 横幅在顶、blocked 重试、`onReorder(orderedIds)` 触发；移除折叠/`defaultExpanded` 断言
- 新增 `applyOrderByIds` 纯函数测试（`agent-message-queue-state.test.ts`）
- 沿用 `agent-message-queue-summary.test.ts`（不动）
- dnd-kit 拖拽：契约测试用 fire `onDragEnd` 断言 `onReorder` 被以正确 orderedIds 调用（不测真实指针）

## 6. 依赖
`bun add @dnd-kit/core @dnd-kit/sortable @dnd-kit/modifiers framer-motion`
（仓库 bun@1.3.13，React 18.3.1，@dnd-kit 兼容 16-18，framer-motion 11 兼容 18-19）

## 7. 落地步骤概览（writing-plans 细化）
1. 基于 `worktree-input-queue-codex-parity` 开 worktree
2. `bun add` 4 依赖
3. 重写 `AgentMessageQueueList.tsx`（平铺 + dnd-kit + framer-motion + 行布局 + 横幅）
4. 改 `AgentInput.tsx`：`handleQueueReorder` 适配 `onReorder(orderedIds)`，移除 `defaultExpanded` 传参
5. `agent-message-queue-state.ts`：新增 `applyOrderByIds`
6. 更新契约测试 + 纯函数测试
7. 视觉走查 + 交互验证（拖拽/动画/三态/横幅/重试）

## 8. Follow-ups（本期不做）
- 图片/附件行内预览（summarize 已汇总计数）
- i18n 文案体系（待 Lume 引入 i18n 基建）
- interrupt 软中断原语（kernel 暂停队列语义，PR #7 follow-up，非 UI 层）
- guidance 进 transcript / `summarizeGuidanceAttachments` 收敛（PR #7 follow-up）

## 9. 验收标准
- 队列以平铺浮层显示在 composer 上方，`max-h-[30dvh]` 滚动，空队列不占位
- 拖拽手柄重排有 transform 动画 + 键盘可达，6px 激活阈值，锁垂直
- 入队/出队有 height+opacity 动画（0.18s）
- interrupted 时顶部横幅 + 继续按钮
- blocked 行有重试按钮 + 警告 tooltip
- 「关闭排队」正确切 followUpMode（不再删消息）
- 契约测试 + 纯函数测试通过（bun:test）

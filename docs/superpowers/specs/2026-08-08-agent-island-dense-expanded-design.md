# Agent Island 高密度展开态设计

> **状态**：用户已确认
> **日期**：2026-08-08
> **分支**：`worktree-input-queue-codex-parity`

## 目标

将 Windows Electron 灵动岛的展开态改为高密度信息列表，同时修复透明窗口的异常阴影和紧凑态无法拖动的问题。

## 已确认界面

- 保持窗口宽度 `420px`，紧凑态高度 `32px`。
- 展开态顶部栏高度 `32px`，标题 `10.5px`，摘要 `8.5px`。
- 顶部操作使用 `24px` 的 shadcn 图标按钮和 Tooltip，不再显示大段按钮文案。
- 活跃会话使用 `30px` 单行列表：状态点、标题、模型/Token 摘要、阶段状态。
- 会话之间用 `1px` 分隔线，不再使用独立圆角卡片。
- 待办和提醒使用无卡片的全宽分组，标题 `24px`，条目 `28px`。
- 展开总高度由内容实测，三会话加一待办目标约 `189px`。

## 内容规则

- 标题为空、等于 thread ID 或本身是 UUID 时，显示 `未命名会话 · <前 6 位 ID>`。
- 会话摘要只保留模型短名和 Token；列表不再显示成本与活动摘要。
- 顶部摘要显示会话数和 planning 条目总数。
- `dueAt` 仅在有限且可转换为有效日期时格式化；无效值直接省略，禁止显示 `Invalid Date`。

## 交互规则

- 紧凑态除右侧展开按钮外，整条为 `-webkit-app-region: drag`。
- 右侧展开按钮为 `no-drag`，是紧凑态唯一展开入口。
- 展开态顶部空白区域可拖动，所有图标按钮为 `no-drag`。
- 会话、待办和提醒条目继续保留现有点击与键盘行为。

## 窗口外观

- 删除 `.island-surface` 的 CSS `box-shadow`。
- 保留现有透明 BrowserWindow 的 `hasShadow: false` 和 `1px` 边框。
- 不修改主进程窗口创建或尺寸反馈逻辑。

## 文件边界

- `apps/web/src/components/agent-island/AgentIslandSurface.tsx`：结构、图标操作、摘要、标题与时间兜底。
- `apps/web/src/components/agent-island/agent-island.css`：紧凑态拖动区、32px 顶部栏、30px 会话行、28px planning 行和无阴影。
- `apps/web/src/components/agent-island/AgentIslandSurface.test.tsx`：标题与时间兜底、紧凑态拖动/展开按钮契约。

## 验证

- 新增纯 helper 测试，先确认标题和非法时间用例失败，再实现通过。
- 运行 Agent Island 两个相关测试文件，区分本次回归与分支原有失败。
- 运行 `@lume/web` typecheck。
- 在 Windows Electron dev 窗口手工验证紧凑态拖动、展开按钮、无阴影和展开密度。

## 范围外与风险

- 不改 sprite 动画实现；动画仍需在实际 Electron 窗口独立验证。
- 不改 Agent Island service、shared 数据类型或原生 macOS helper。
- 该功能分支不包含当前 `origin/main`，后续 PR 需要单独处理 Agent Island 文件已在 main 删除的历史差异。


# Lume 主界面体感优化设计

**日期**: 2026-07-03
**状态**: 待用户审阅
**范围**: `apps/web` 主界面视觉 token、暗黑层级、主路径组件状态与轻量动效

## 背景

当前主界面存在三类问题：

1. 视觉 token 没有形成统一约束，组件里仍散落 `dark:bg-zinc-*`、硬编码颜色和局部状态样式。
2. 暗黑模式层级偏糊，框架区、内容区、输入区、浮层之间缺少稳定的 surface 关系。
3. 主路径缺少明确的体感语言，hover、active、selected、focus、panel 切换和 composer focus 的反馈节奏不一致。

用户确认本轮目标是 **简洁、丝滑、用户体感好**。因此本次不是换皮，也不是强品牌装饰，而是先让主界面成为长期使用不累、暗黑模式舒服、交互反馈自然的 AI 工作台。

## 目标

1. 让暗黑模式具备清晰、柔和、可持续的 surface 层级。
2. 用 Lume 语义 token 收敛主路径里的颜色、边界、文字、强调色和阴影。
3. 统一主路径组件的 hover、active、selected、focus、disabled、loading 状态。
4. 让 composer 成为稳定的视觉锚点，输入、附件、工具栏、发送按钮状态保持一致。
5. 降低消息区、事件块、附件、工具调用状态的视觉噪音，让正文阅读优先。
6. 保持实现边界小，不改变业务行为、数据流和信息架构。

## 非目标

- 不重做路由、数据模型、Agent 行为或 Electron 主进程逻辑。
- 不一次性覆盖市场页、设置页、所有历史页面和边缘组件。
- 不新增设计系统包、token 构建工具或动画依赖。
- 不做强品牌插画、背景大渐变、玻璃拟态、夸张动效。
- 不为了样式变更补写无意义测试。

## 选定方案

采用 **主界面体感优先** 方案。

曾讨论的三个层级：

1. Token 统一优先: 风险低，但只能改善表层一致性，体感提升有限。
2. 主界面体感优先: 同时处理 token、暗黑层级、主组件状态和轻量动效，收益最大。
3. 完整设计语言重建: 覆盖最完整，但范围过大，容易演变成全应用重设计。

本轮选择第二种，先集中改善日常最高频路径，再把沉淀出的规则扩展到其他页面。

## 设计语言

本轮视觉语言命名为 **Soft Control Surface**。

它是一套低噪音的深色桌面软件界面：不靠装饰制造记忆点，而是通过稳定层级、克制边界、清晰状态和自然反馈形成质感。

核心规则：

1. 背景分层，而不是全局一块黑。
2. 边界少而准，只在可操作、选中、浮层、resize 分隔等位置出现。
3. 强调色只做状态和引导，不做大面积装饰。
4. 暗黑不使用纯黑和刺眼纯白，文字、状态色和边界都降低疲劳感。
5. Composer 是主路径视觉锚点，必须比普通面板更稳定、更清楚。

## Token 设计

保留现有 shadcn 基础变量，但新增或整理 Lume 自己的语义 token。实现时优先替换主路径组件里的散落颜色。

### Surface

- `--lume-bg-app`: 整窗最底层背景。
- `--lume-bg-rail`: 左侧栏、标题栏等应用框架区域。
- `--lume-bg-panel`: 聊天区、右侧面板等主要阅读面。
- `--lume-bg-elevated`: composer、popover、菜单、浮层。

### Border And Shadow

- `--lume-border-subtle`: 默认低噪音边界。
- `--lume-border-strong`: hover、selected、resize、popover 等强化边界。
- `--lume-shadow-panel`: 浮层和 composer 的柔和层级阴影。

### Text

- `--lume-text-primary`: 正文和主要标题。
- `--lume-text-secondary`: 次级说明、元信息。
- `--lume-text-muted`: 占位、空态、弱提示。

### Accent And State

- `--lume-accent`: 当前 tab、focus、发送按钮、重要状态点。
- `--lume-accent-soft`: 选中底色、轻提示背景。
- `--lume-accent-foreground`: 强调色上的文本或图标。
- `--lume-focus-ring`: 统一键盘与输入 focus。
- `--lume-danger`: 危险状态。
- `--lume-success`: 成功状态。
- `--lume-warning`: 警告状态。

## 组件范围

第一轮只覆盖主路径组件，避免扩散。

### `AppShell`

统一整窗背景、主区域 surface 层级和暗黑底色。确保 sidebar、main area、right panel 不再像多个视觉系统拼接在一起。

### `TitleBar` / `WindowButtons`

减少标题栏视觉噪音。窗口按钮 hover 和 active 状态要细，不抢正文和 composer 的注意力。

### `LeftSidebar` / `LumeSidebar`

统一线程列表、分组、当前项、hover 项、运行中或未读状态。当前线程要明确，但不使用大面积高饱和色。

### `TabBar` / `MainArea`

当前 tab 使用 accent 细节或柔和底色强化。非当前 tab 降低对比。tab 切换时保持背景层级稳定，避免整页闪烁感。

### `AgentMessages`

提高消息正文阅读优先级。事件块、附件、工具调用状态默认降噪，展开或聚焦时再显示更多细节。

### `AgentInput` / `LumeComposer`

作为主路径核心锚点，统一容器、focus、边框、工具栏、附件、发送按钮、loading 和 disabled 状态。Composer focus 应该让用户感到进入输入状态，但不能突然抢屏幕。

### `RightPanelWorkspace`

与聊天区共享 surface 体系。出现、隐藏、resize 时不破坏聊天区阅读节奏。

## 交互体感

### 状态规则

- `hover`: 轻微提亮或边界增强，不改变尺寸。
- `active`: 背景略沉，图标或文字略亮，形成按下感。
- `selected`: 比 hover 明确，可使用 accent 细条、柔和底色或文字强化。
- `focus`: 输入、菜单、键盘可达控件统一使用 `--lume-focus-ring`。
- `disabled` / `loading`: 降低对比，不改变布局尺寸。

### 动效规则

- 常规状态切换: `120ms` 到 `160ms`，使用 `ease-out`。
- 面板展开收起、composer focus、tab 切换: `180ms` 到 `220ms`，使用稳定的 cubic-bezier 曲线。
- 禁止夸张弹跳、长动画、大面积 blur 过渡。
- 尊重 `prefers-reduced-motion`，减少非必要 transform 和 transition。

## 实现约束

1. 不新增依赖。
2. 不改变业务行为和数据流。
3. 优先删除或替换散落样式，不引入单次使用抽象。
4. 使用现有 Tailwind、CSS token 和组件结构完成。
5. 改动应小而可回滚，按主路径组件分批推进。
6. 如更新 token 合约测试，应明确说明这是设计 token 的预期变化。

## 验收标准

1. 暗黑模式能清楚分出 app、rail/sidebar、panel/content、elevated/composer/popover。
2. 主界面高频区域属于同一套设计语言，不再像多个局部样式拼接。
3. hover、active、selected、focus、disabled、loading 状态一致且不突兀。
4. Composer 在视觉上稳定、清楚，是主路径输入锚点。
5. 消息区阅读优先，事件块、附件、状态信息不抢正文。
6. 主路径组件不再继续依赖散落的 `dark:bg-zinc-*` 和硬编码 hex。
7. 布局结构和业务行为保持不变。

## 验证策略

本轮属于纯 UI 与 token 调整。实现阶段不需要为了证明完成而执行全量测试。

建议验证方式：

1. 对涉及 token 合约的变更运行对应 contract test。
2. 对主界面做暗黑和亮色手动视觉检查。
3. 如改动影响布局稳定性，使用浏览器截图检查桌面宽屏、普通桌面和较窄视口。
4. 如改动触及可交互状态，手动检查 hover、focus、selected、panel resize、tab 切换、composer focus。

## 执行顺序建议

1. 收敛 `apps/web/src/index.css` 的 Lume token。
2. 迁移应用框架层: `AppShell`、`TitleBar`、`WindowButtons`。
3. 迁移导航与 tab 层: `LeftSidebar`、`LumeSidebar`、`TabBar`、`MainArea`。
4. 迁移工作区核心: `AgentMessages`、`AgentInput`、`LumeComposer`、`RightPanelWorkspace`。
5. 做一次视觉清扫，删除主路径遗留的硬编码暗黑颜色和重复边界。

## 风险

1. 现有 token 合约测试锁定具体色值，更新语义 token 时需要同步调整测试预期。
2. 主路径组件里可能存在业务状态与视觉状态混写，迁移时要避免改动行为。
3. 暗黑优先可能导致亮色主题被动跟随，需要在实现阶段保留亮色基本可用性。
4. 如果一次性覆盖太多边缘组件，容易扩大 diff，本轮应坚持主路径边界。

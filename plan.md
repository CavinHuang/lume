# Lume 下一步完善计划

## 目标

把当前已经铺开的能力收束成更完整、可验证的产品闭环。优先识别半成品，不急着新增大功能；先让已有路径更可信、更少误导、更容易继续开发。

## 当前半成品盘点

### 1. Plan / Task 执行闭环

现状：
- 任务审批、TaskRun、TaskReport 已经存在。
- 旧的 PlanModePhase / fallback 执行桥接仍在和新 TaskRun 模型并存。
- 审批横幅已支持拒绝反馈输入，但 sidecar 目前只返回 feedback，没有把反馈喂回 agent 触发重新规划。
- `查看计划`按钮有 UI，但缺少点击行为。

风险：
- 用户以为“拒绝并反馈”会让 agent 修改计划，但实际可能只是关闭审批。
- Plan 与 TaskRun 的状态来源分散，后续容易出现 UI 显示和 runtime 状态不一致。

### 2. Plan 文件路径契约

现状：
- `TaskContractWrite` 要求 agent 在 `sessions/{threadId}/plans/...` 写 Markdown 计划。
- SDK `Write` 工具描述要求写绝对路径。
- 前端自动打开 `planFilePath` 时把它当 workspace 文件处理。

风险：
- agent 可能写到错误位置。
- 前端可能打不开真实 plan 文件。
- 审批流程的“可读计划文件”体验不稳定。

需要先决策：
- plan.md 是线程工作区文件、workspace shared 文件，还是 runtime session 文件？
- `planFilePath` 应该存绝对路径还是受控相对路径？

### 3. Runtime 恢复、handoff、后台子代理管理

现状：
- RunState、Trace、Interruption、部分 resume 已经落地。
- 架构文档明确当前不是 full post-restart resume。
- in-flight shell/process 不能恢复。
- handoff 只有记录能力，还没有完整控制权转移 UI。
- 背景子代理管理 UI 仍偏基础。

风险：
- 用户会把“可恢复”理解成所有中断都能继续，但当前只支持部分 checkpoint。
- 长任务、工具审批、重启恢复的产品预期需要更清晰。

### 4. 自动化入口与 dashboard 成熟度

现状：
- sidebar 自动化入口可点击，但仍带“即将推出”。
- 自动化管理页、run list、pending approval 已有实现。
- 架构文档仍标记“没有 full automation dashboard rewrite”。

风险：
- 导航文案和功能状态不一致。
- 用户可能不知道自动化当前能做什么、哪些能力还受限。

### 5. 设置页信息架构

现状：
- `外观`仍是 placeholder。
- `文件与同步`实际渲染 SkillsSettings。
- `快捷键`实际渲染 AutomationSettings。

风险：
- 设置页导航和内容错位，影响可信度。
- 后续功能继续往这里塞会让 IA 更难维护。

### 6. 明确技术债

代码中有三处显式 TODO：
- Chat / Agent tool 体系长期统一。
- Agent message versioning 复杂度评估。
- Memory service 转发层是否删除。

建议：
- 不把这些作为第一优先级，除非当前工作正好碰到对应模块。
- 优先删除真实阻碍产品闭环的桥接和误导性 UI。

## 推荐优先级

### P0: 收束 Plan / Task / plan.md 审批闭环

这是当前最值得先做的一条线，因为它连接了 agent 规划、用户审批、任务执行、进度展示和文件预览，是 Lume 的核心体验。

目标：
- 明确 plan 文件存储契约。
- 让 `查看计划`和自动打开计划文件可靠工作。
- 让拒绝反馈真正触发重新规划。
- 减少旧 Plan execution fallback 和新 TaskRun 的状态分叉。

成功标准：
- Plan 模式下 agent 生成可读 Markdown 计划。
- 用户能在审批前打开并阅读计划。
- 批准后自动进入 TaskRun 执行。
- 拒绝并填写反馈后，agent 能基于反馈重新生成计划。
- TaskProgressPanel 只表达执行进度，不再承载重复审批语义。

### P1: 修正设置页和自动化入口的产品状态

目标：
- 移除或补齐明显 placeholder。
- 自动化入口不再显示“即将推出”，或者如果能力不完整，就明确标注当前支持范围。
- 设置页 nav 与实际内容一致。

成功标准：
- 每个设置 tab 的名称、描述和内容一致。
- 没有“可点击但说即将推出”的入口。
- 外观页要么有真实设置，要么从 nav 中暂时移除。

### P2: Runtime 恢复与 handoff 路线

目标：
- 把 resume 边界产品化：哪些可恢复、哪些必须重试、哪些需要重新规划。
- 为 handoff / background subagent 做最小可用管理视图。

成功标准：
- 重启后用户看到明确、可信的恢复状态。
- 不可恢复的运行有清楚的下一步操作。
- 后台子代理不只是运行记录，也能被用户理解和管理。

## 建议下一份正式 spec

题目：
`Plan 文件与任务审批闭环`

范围：
- plan 文件路径与打开逻辑。
- 审批横幅交互。
- 拒绝反馈到 agent 重新规划。
- TaskProgressPanel 职责收束。
- 最小删除旧桥接或标记兼容边界。

非目标：
- 不做完整 runtime resume。
- 不重写 automation dashboard。
- 不重构整个 message versioning。
- 不新增依赖。

## 初步实施顺序

1. 先写清 plan 文件契约。
2. 修正 sidecar / web 对 `planFilePath` 的读写和打开方式。
3. 补上 `查看计划`点击行为。
4. 让 reject feedback 触发 agent 重新规划。
5. 收束 TaskProgressPanel 的审批残留语义。
6. 针对 Plan / Task 相关逻辑跑 focused tests。

## 剩余风险

- 当前仓库已有一个未跟踪文件 `.deleted-files.txt`，后续改动时不要误处理。
- 旧文档中很多 checklist 仍是 unchecked，但代码已经部分实现，不能只按文档判断完成度。
- 如果 plan 文件位置选错，后续会影响文件预览、历史追溯和 runtime session 清理策略。

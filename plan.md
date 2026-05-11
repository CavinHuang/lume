# Lume 下一步完善计划

## 目标

把当前已经铺开的能力收束成更完整、可验证的产品闭环。优先识别半成品，不急着新增大功能；先让已有路径更可信、更少误导、更容易继续开发。

## 当前半成品盘点

### 1. Plan 审批闭环

现状：
- 结构化任务审批、TaskRun、TaskReport 已经存在。
- Agent 已经可以通过 TaskContractWrite 提交待审批任务契约。
- 审批横幅已支持批准、拒绝和反馈输入。
- 计划文件预览已经有雏形：前端会根据 `planFilePath` 自动打开一个文件 tab。

风险：
- 审批阶段还没有形成稳定的“可阅读计划 -> 批准/拒绝 -> 执行/重规划”闭环。
- 用户拒绝并填写反馈后，sidecar 目前只是返回 feedback，没有把反馈喂回 agent 触发重新规划。
- `查看计划`按钮有 UI，但缺少点击行为。
- 审批、计划预览、执行进度的职责边界还不够清楚。

目标契约：
- Plan 模式下，agent 先收集信息，再通过 TaskContractWrite 提交 `planMarkdown` 和结构化 TaskContract。
- TaskContractWrite 负责把 `planMarkdown` 写成线程工作区内的 Markdown 计划文件，读回验证后才创建审批请求。
- 普通回复和审批横幅都必须暴露计划文件路径与验证状态，不能只显示工具调用。
- 审批横幅只负责审批动作：查看计划、批准执行、拒绝并反馈。
- 批准后创建或继续 TaskRun，TaskProgressPanel 只展示执行进度。
- 拒绝并反馈后，系统把反馈作为重新规划输入交回 agent，而不是只关闭审批。
- 旧 PlanModePhase / fallback 桥接只作为兼容边界存在，不能继续承担新执行模型的主状态来源。

### 2. plan.md 文件契约

现状：
- `TaskContractWrite` 要求 agent 提供 `planMarkdown`，sidecar 负责写入线程计划文件。
- Plan 模式不需要开放通用 `Write` 工具来生成计划文件。
- 前端自动打开 `planFilePath` 时把它当 thread 文件处理，并在审批横幅展示路径。

风险：
- agent 可能写到错误位置。
- 前端可能打不开真实 plan 文件。
- 审批流程的“可读计划文件”体验不稳定。

目标契约：
- Markdown 计划属于线程工作区文件，不属于 workspace shared resources，也不属于 runtime 内部 session dir。
- 推荐路径：线程工作区内的 `plans/{contractId}.md`，必要时可扩展为 `plans/{YYYY-MM-DD}-{short-title}.md`。
- `planFilePath` 存线程内受控相对路径，例如 `plans/contract-123.md`。
- `planVerified` 来自 sidecar 读回验证结果；没有 verified plan file 时不能进入审批。
- 前端打开计划时使用 `fileSource: 'thread'`，传入 `threadId` 和 `planFilePath`。
- sidecar 负责把 `planFilePath` 解析到线程工作目录，并做路径越界保护。

取舍：
- 不选 runtime session dir：它是运行时内部状态，适合存 RunState / Trace / Interruption，不适合暴露成用户要审阅的文件。
- 不选 workspace shared resources：plan 是某次线程任务的审批产物，默认不应该污染跨线程共享资料区。
- 选择线程工作区：最符合“计划属于这次任务”的心智，也能复用现有 thread file preview 能力。

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

### P0: 收束基于线程 plan.md 的审批闭环

这是当前最值得先做的一条线，因为它连接了 agent 规划、用户审批、任务执行、进度展示和文件预览，是 Lume 的核心体验。

目标：
- 将 Markdown 计划固定为线程工作区内的受控文件。
- 让 `查看计划`和自动打开计划文件都走 thread file preview。
- 让拒绝反馈真正触发 agent 重新规划。
- 审批阶段只处理“审阅/批准/拒绝”，执行阶段只由 TaskRun / TaskProgressPanel 表达。
- 减少旧 Plan execution fallback 和新 TaskRun 的状态分叉。

成功标准：
- Plan 模式下 agent 生成可读 Markdown 计划。
- TaskContractWrite 返回 `planFilePath` 和 `planVerified: true`，agent 普通回复必须告诉用户这个路径。
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
`线程 plan.md 与任务审批闭环`

范围：
- 线程工作区内 plan 文件路径与打开逻辑。
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

1. 先把 plan 文件契约固定为线程工作区相对路径。
2. 修正 TaskContractWrite 的工具说明、`planMarkdown` 写入和 `planFilePath` 校验语义。
3. 修正前端自动打开计划文件：从 workspace file tab 改为 thread file tab。
4. 补上 `查看计划`点击行为。
5. 让 reject feedback 触发 agent 重新规划。
6. 收束 TaskProgressPanel 的审批残留语义。
7. 针对 Plan / Task 相关逻辑跑 focused tests。

## 剩余风险

- 当前仓库已有一个未跟踪文件 `.deleted-files.txt`，后续改动时不要误处理。
- 旧文档中很多 checklist 仍是 unchecked，但代码已经部分实现，不能只按文档判断完成度。
- 如果线程工作区后续有清理策略，需要明确 plan.md 是否跟随线程一起归档或删除。

# Plan: 重设计 Lume Task 工具
_Locked via grill — by Codex + 用户_

## Goal

将 Lume 收敛为一套 Claude Code 风格的持久化 Task 列表：Task 是主 Agent 管理的独立任务项，通过 `blocks/blockedBy` 组成依赖图；Task 只负责状态、依赖、认领和审计，不主动创建或调度 subagent。Subagent 保持独立能力，由主 Agent 自行决定是否调用，并通过可选引用与 Task 关联。TodoWrite 继续作为主 Agent 的短期串行进度清单，和 Task 完全隔离。

## Approach

1. 以 Claude Code V2 Task 为基准，建立唯一的 Lume Task 工具链：`TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet`、`TaskStop`，并在 sidecar 主 Agent 的工具组中显式 wiring；工具工厂绑定 `sessionDir`、thread-derived `taskListId`、服务端 actor 和 runtime event emitter。
   - `TaskCreate` 只创建一个 `pending` Task，不接受依赖、owner 或 executor 参数。
   - `TaskUpdate` 负责修改描述、状态、owner、metadata，以及通过 `addBlocks/addBlockedBy` 建立依赖。
   - `TaskList/TaskGet` 提供列表摘要和完整 Task 查询。
   - 不新增 Task 流程容器、TaskRun、TaskWait 或 Task 自动执行器；`TaskStop` 是 Task 层的取消请求：原子地递增 claim generation、撤销当前 claim 并将公开状态回到 `pending`，同时记录带旧 claim token 的取消请求。它不等待、也不依赖 executor 确认；独立 executor-control adapter 可异步请求终止并记录 ack，旧执行器晚到结果因 token/revision fencing 被拒绝。若旧 executor 仍可能写共享工作区，则保留服务端内部 execution fence，阻止任何新的 Task claim，直到收到终止确认。
   - TaskUpdate/TaskStop 是非并发安全控制工具；主 Agent 必须先完成认领，再在后续工具调用中 dispatch Agent。runtime 若发现同一 assistant turn 同时包含 TaskStop 与 task-linked Agent/Delegate，必须拒绝该批次或显式按 TaskStop 先行处理，禁止未定义执行顺序。
   - 每个 owner-sensitive transition 必须携带服务端返回的 opaque claim token 和 expected revision/attempt；过期 executor 的迟到结果必须被拒绝。

2. 将 Task 持久化改为按任务列表隔离的文件结构：
   `<sessionDir>/tasks/<taskListId>/.lock`、`.highwatermark` 和每个 Task 的独立 JSON 文件。
   - 默认 `taskListId` 为主 Agent 的 thread/session ID。
   - 创建使用任务列表锁和递增字符串 ID；删除后不复用 ID。
   - 单 Task 更新使用任务文件锁；涉及 owner 忙碌检查和依赖变更时使用任务列表锁。
   - 任务列表锁使用独占创建、renewable heartbeat、fencing token、固定超时、stale lock 恢复和统一加锁顺序；不能只依据经过时间抢占仍存活的 writer。taskListId 与 Task ID 只接受安全路径段，并验证解析路径仍位于 session task root 下。
   - 所有 mutation（创建、ID/highwatermark、普通更新、owner/claim、依赖、删除、事件 revision）通过同一个 idempotent write-ahead transaction journal 记录 prepare/commit；启动或下一次 mutation 前恢复未完成事务，避免状态、事件和 highwatermark 分裂。
   - TaskStore 提供唯一的 `mutate()` 入口：在同一事务中校验、写 snapshot、追加 revision、分配 `(taskListId, sequence)` 事件序号并触发 live notification；入口强制校验服务端 actor/context 必须是当前主线程（`threadType === main`），且 `taskListId` 必须等于该主线程推导值。启动恢复、executor-control ack 等非模型写入使用受限的 trusted `system/recovery` context，必须绑定相同的主线程 `taskListId`、服务端来源和允许的 mutation 类型，不能成为绕过权限的通道。事件 envelope 显式记录 `origin: agent | system | recovery`，TaskList 保持纯读。
   - 不使用模块级全局 Map，也不读取旧 `task-contracts/`、`task-runs/` 数据。

3. 保持 Claude Code 风格的公开 Task schema：
   `id`、`subject`、`description`、`activeForm`、`owner`、`status`、`blocks`、`blockedBy`、`metadata`。
   - 公开状态只有 `pending`、`in_progress`、`completed`。
   - Lume 特有的 executor 引用、尝试次数、最近错误、产物和验证信息放在 `metadata._lume`。
   - metadata 使用 Claude Code 风格的浅层增量合并语义：普通字段覆盖、数组整体替换、`null` 删除；限制 metadata 总大小并校验允许的结构。
   - `_lume` 中的 claim、attempt、错误来源、事件引用等服务端字段由服务端保留，普通 TaskUpdate 不能伪造或删除。

4. 实现主 Agent 独占的认领和修改边界。
   - 只有主 Agent 可以调用 Task 工具；subagent 不暴露 Task 工具。
   - `in_progress` 更新必须通过原子校验：依赖全部完成、owner 未被占用、调用方权限有效；`in_progress` 必须有服务端派生的 owner/claim token。
   - 每个 Task list 同时最多只有一个 `in_progress` Task；主 Agent 自己最多认领一个，不能通过不同 subagent owner 分散运行多个 Task。Task 图仍可保存多个 pending 项及并行依赖关系，但下一项必须等当前 Task 释放 claim/fence 后再认领。
   - owner 从当前 thread/run 或经校验的 subagent 身份派生，模型不能伪造任意 owner。
   - claim 保存 actor、parent run、claim token、claimedAt 和 lease 状态；stale claim 只能由 startup reconciliation 或显式 TaskStop/TaskUpdate mutation 恢复，TaskList 不得写状态。TaskStop 先撤销 claim 并把公开状态回到 pending，但 execution fence 对新的 Task claim 具有权威性：旧 executor 未终止确认前不能重新认领；ack 只释放 fence，不再改变公开状态，旧 claim 由 token/revision fencing 作废。
   - Task 不创建、唤醒、等待或验收 subagent。
   - `Agent` 是否创建 subagent、使用哪个 subagent，由主 Agent 单独决定；Task 不因此获得 subagent 生命周期。

5. 保持 Task 与 Subagent 两套独立生命周期。
   - 主 Agent 可以先将 Task 设置为 `in_progress`，由 runtime 生成 claim，再在后续工具调用中调用 `Agent`；如果要把 owner 指向新 subagent，Agent bridge 使用无副作用的 identity reservation，再原子绑定 claim，启动失败时执行补偿释放，Task 不主动创建 subagent。
   - `Agent` 和 `Delegate` 可接收独立的结构化 `task_ref: { taskListId, taskId, claimToken }`；bridge 必须校验 `task_ref.taskListId` 精确等于父主线程当前推导的 `taskListId`，使用自己的 subagent session/run ID，不修改 Task 状态，也不复用现有 SubagentCoordinator 的 `task_id`。
   - subagent 执行器引用写入服务端管理的 `metadata._lume.executorRef`。
   - Agent/Delegate 输入改为 discriminated union：带 `task_ref` 时拒绝 `task_id`、`new_task` 及其它旧 coordinator 字段，避免混入旧 SubagentCoordinator 路径；不带 `task_ref` 的 standalone Agent 保留旧路径。带 `task_ref` 的路径走直接 executor-control adapter。
   - executor-control adapter 统一处理 Agent 与 Delegate 的取消、终止确认、claim token 和结果回写关联；每个 claim 通过 CAS 只能绑定一个 active executor/attempt，重复使用同一 `task_ref` 或 claim token 的 dispatch 必须拒绝，只有 terminal ack 才能清除 binding。subagent 完成后，主 Agent 根据返回结果调用 `TaskUpdate`。
   - execution fence 保存 cancellation deadline、executorRef 和 recovery state。deadline 到期后，trusted recovery 必须通过 executor-control adapter 确认或强制终止 executor；只有 verified terminal/forced-termination result 才能释放 fence，否则保持 fence 并报告 recovery failure，不能为恢复吞掉安全约束。
   - Task-linked Agent/Delegate 调用在 runtime 分批阶段默认进入串行队列；只有显式的 adapter-controlled queue 在调用前已确认 executor 为只读时才允许并发，不能依赖 Agent/Delegate 静态 `isConcurrencySafe` 或同轮模型意图。由于一个 Task list 同时只有一个 active Task，Task 之间不并行；独立、无 `task_ref` 的 Agent 能否并行仍由现有服务端只读判定控制。
   - subagent 失败时由主 Agent 清除 owner、恢复 `pending`，并将错误与结果写入服务端管理的 `metadata._lume`。

6. 实现依赖和动态修改规则。
   - TaskCreate 不隐式推断依赖；依赖必须通过 TaskUpdate 显式声明。
   - `blocks`/`blockedBy` 两端原子更新，并在写入前拒绝循环依赖。
   - 主 Agent 可以修改 pending Task、追加 Task；已完成 Task 不覆盖。
   - pending Task 可以删除；in_progress Task 由 TaskStop 原子撤销 claim 并把公开状态恢复 pending，但其 execution fence 在 executor-control adapter 返回 verified terminal/forced-termination result 前阻止重新认领；该确认只释放 fence，不是公开 Task 状态转换前置条件；completed Task 不允许删除。
   - 删除时通过事务 journal 原子清理其他 Task 的依赖引用。
   - 重试通过恢复 pending 并增加 `metadata._lume.attempts` 记录，不覆盖历史结果。

7. 保留 Claude Code 风格的完成校验和只读展示。
   - `TaskUpdate(status: completed)` 在提交 snapshot 之前运行阻塞式完成校验；若现有 hook registry 支持则复用，否则提供 TaskUpdate 的 pre-commit validator，校验失败时保持原状态并返回原因。
   - 每次成功 mutation 同时写入当前 Task JSON 和任务列表 append-only event/revision log；启动回放由新 TaskStore 提供，不再读取 `task-runs/`；live/replay/deduplication 都使用 `(taskListId, sequence)`，不依赖 runId。
   - 复用现有 `task.progress` 事件通道，但去除对 `contractId/TaskRun` 的依赖，展示 Task 列表、依赖、owner 和 metadata 摘要；同步更新 shared 类型、sidecar replay、事件去重和 web 消费者。
   - UI 只读展示，不提供创建、修改、认领、删除或重试入口。

8. 处理并行执行的资源边界。
   - Task 不实现文件级 scheduler；主 Agent 只对只读任务并行调用 Agent。
   - 共享工作区中的写入 Task 默认串行；现有 workspace writer lease 继续保护单次写工具调用，但不被宣称为完整任务级读改写隔离。
   - `expectedFiles` 只作为提示和审计信息，不作为安全锁；第一版不承诺共享 worktree 的并行写入或 worktree 隔离。

9. 更新提示词、权限和工具元数据，并完成旧链路切断。
   - Task 与 TodoWrite 同时暴露，但不共享状态、不自动同步、不互相复制条目。
   - TodoWrite 用于短期、简单、串行的小目标；Task 用于持久化任务、依赖、认领和并行委派。
   - 新增五个工具的精确权限元数据，并在所有 subagent tool assembly（静态、dynamic、required tools）中集中移除完整 task-management deny set：`TaskCreate/TaskUpdate/TaskList/TaskGet/TaskStop/TaskOutput` 及旧 SDK Task 工具；`resolveDynamicTools` 必须传递 thread/actor context，嵌套 SDK AgentTool 必须应用同一 deny set，并由装配后的断言拒绝任何残留 Task 名称；仅 coordinator-bound standalone `TaskReport` 可例外保留。
   - 保留 `Agent/Delegate/FinishAgentTask` 的 standalone subagent 兼容语义；新 Task 不使用 `FinishAgentTask`。
   - 废弃 SDK 模块级 Map 作为 Task 状态源，但先将 Bash 后台 job 的停止句柄、输出读取等用途迁移到模型不可见的 `ProcessJobRegistry`，并将旧 `TaskStop/TaskOutput` 改名为内部 `ProcessStop/ProcessOutput`，同步更新 Bash、exports、权限、事件和测试。
   - 旧 TaskContract 计划审批链、runtime orchestrator、approval service、RPC continue/retry/skip handler、旧 replay、主 Agent 的 `taskReportTool` 和旧 TaskProgressPanel 控件必须整体移除或隔离到明确的 legacy compatibility boundary；仅保留 coordinator-bound standalone subagent `TaskReport`，新 Task 工具不能意外进入旧链路。

## Key decisions & tradeoffs

- **采用 Claude Code 的 Task 项模型，而不是 TaskRun 工作流容器。** 这样工具语义简单、持久化边界清楚，也符合“Task 与 Subagent 分离”的要求；Task list 同时只运行一个 Task，独立 Agent 的只读并行不由 Task 隐式派生。
- **Task 与 Todo 同时暴露但完全隔离。** Claude Code 的 V1/V2 互斥切换不适合 Lume 的产品目标；Lume 通过提示词区分用途，而不是隐藏工具。
- **只允许主 Agent 修改 Task。** 这是对 Claude Code 多 teammate 认领模型的有意收紧，牺牲跨 Agent 直接更新换取单一编排责任和更少竞态。
- **公开状态保持三态。** `failed/blocked/cancelled` 不进入 Task 的长期公开 schema；失败恢复为 pending，依赖阻塞由 `blockedBy` 表示，诊断信息放入 `_lume` metadata。
- **Task 不主动创建 subagent。** 主 Agent 自己决定是否调用 Agent，Task 只记录 owner 和关联信息，避免 Task/Agent 互相拥有生命周期；TaskStop 的执行栅栏只保护共享资源，不把 executor ack 变成 Task 状态机的一部分。
- **保留 Claude Code 的每 Task 独立 JSON，但增加统一 mutate、事务 journal 和事件日志。** 这保留了用户选择的文件模型，同时补足双向依赖、highwatermark、回放和崩溃一致性。
- **不迁移旧数据。** 现有 TaskContract/TaskRun 文件保留但不再读取；旧运行时代码必须先完成切断，否则“保留但不读取”只是计划性声明而非真实行为。

## Risks / open questions

- 当前 Lume 的 `TaskContract`、`TaskRun`、runtime orchestration、RPC 和 UI 测试覆盖多条旧链路，删除旧链路时需要逐处确认不会影响普通 Agent 回合；Bash ephemeral jobs 不能被误删。
- 主 Agent 调用 Agent 与 TaskUpdate 之间存在短暂不一致窗口：Agent 创建失败或主 Agent 中断时，Task 可能暂时保持 `in_progress`；claim lease、stale recovery 和后续 TaskList 修复必须明确。
- 文件锁、事务 journal 和任务列表锁需要避免跨文件更新时的死锁，并保证依赖双端写入不会产生半更新。
- `task.progress` 事件现有消费者依赖 `taskRunId` 和 `contractId`，事件 schema 调整需要同步 sidecar、shared、replay 和 web。
- 失败恢复为 pending 简化了公开模型，但 UI/Prompt 必须能展示最近失败原因；服务端 metadata provenance 不能被普通 TaskUpdate 伪造。
- 独立 Agent 的共享工作区仍存在读改写冲突风险；第一版只承诺服务端确认的只读并行，Task-linked 调用和写入执行保守串行。

## Out of scope

- 用户直接创建、修改、认领、删除或重试 Task 的 UI/API。
- Task 自动创建 subagent、自动选择 subagent、Task 内部 scheduler、TaskWait 或嵌套 Task。
- 跨 thread/workspace 默认共享 Task 列表。
- 旧 TaskContract/TaskRun 数据迁移。
- 文件级并行写入优化和 worktree 隔离；第一版只实现共享 worktree 写入串行，并继续复用现有 workspace writer lease。
- 新增依赖或新的执行器类型。

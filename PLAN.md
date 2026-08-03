# Plan: 为 Lume 增加持久化 Planning Todo 能力

_Locked via grill — by Codex + user_

## Goal

为 Lume 增加一套面向用户、可跨任务长期积累的 Todo 能力，并与 Agent 运行时已有的 `TodoWrite` 执行清单、`Task*` 任务编排严格区分。

最终能力应满足：用户可以从主界面、Quick Input、对话和 IM 快速记录 Todo；Agent 可以在明确授权和项目作用域内查询、更新 Todo；Todo 可启动或继续一个 Agent 任务；所有数据由 sidecar 在独立 SQLite 数据库中持久化；交互和工具执行结果复用 Lume 当前的 UI 语言与运行时事件体系。

## Approach

1. **定义独立的 Planning Todo 领域契约**
   - 在 `packages/shared` 新增 Planning Todo 类型和校验契约，并从 shared 公共入口导出。
   - 使用以下稳定术语：
     - 产品/UI：`Todo`、`待办`
     - 持久领域：`Planning Todo`
     - Agent 工具：`PlanningTodoList/Get/Create/Update/Complete/Reopen/Delete/Restore`
     - 现有 `TodoWrite`：`执行清单`
     - 现有 `Task*`：线程内任务编排
   - Todo 数据模型包含：`id`、`title`、`normalizedTitle`、`description`、`status`、`priority`、`workspaceId`、日期型截止日或精确截止时间、`revision`、创建/更新时间、完成时间、软删除时间。
   - `status` 仅存储 `open | completed`；执行中、等待、失败等状态由关联任务的运行状态派生，不写回 Todo。
   - 截止时间采用互斥表示：
     - `dueDate`：用户所在本地时区中的 `YYYY-MM-DD`，适合“周五前”这类日期语义；
     - `dueAt` + `dueTimezone`：UTC 时间戳与创建时的 IANA 时区，适合“周五 14:00”这类精确时间；
     - Agent 不得为仅提供日期的用户输入猜测具体时刻。
   - 新增精确定义、版本化的用户消息 part：`{ type: 'planning_todo_ref', schemaVersion: 1, uri: 'lume://planning/todo/<uuid>', todoId: UUID, relation: 'mentioned' | 'primary', displayText: string }`。`uri` 与 `todoId` 必须相互匹配，`displayText` 是有长度上限的发送时快照；它不复用 `capability_ref`，不进入 capability authorization，也不依赖纯文本解析。
   - 消息协议必须端到端接通，而非只改 shared 类型：同步更新 `packages/shared/src/types/agent.ts`、`apps/sidecar/src/rpc/schemas.ts`、`agent-user-message-parts.ts`、web 编辑器序列化、消息持久化与历史投影。具体 normalization 规则为：
     - `userMessage` 按 part 顺序用 `&<displayText>` 还原可见文本，不暴露隐藏 ID；
     - `modelMessage` 只包含有清晰数据边界的引用占位和 displayText，最新 Todo 快照由 `ContextAssembler` 另行读取并注入；
     - 单条消息按 `todoId + relation` 去重并保留首次出现，同一 Todo 同时出现 primary/mentioned 时由可信 start flow 的 primary 胜出；普通 renderer 不能自行创建 primary；
     - 新写入严格校验 schema/URI/ID；旧历史中的无效或已不可访问 part 投影为不可用的 displayText chip，不让整条历史消息解析失败；
     - capability projection 只消费 `capability_ref`，通过穷尽类型分支证明 Planning part 不生成 skill/plugin grant。
   - `agent-service.ts` 在 sidecar 入站边界强制 relation 权限：普通 send 即使 schema 合法也拒绝任何 `primary` part；只有 Planning start service 的内部调用携带已持久化且匹配 todoId/threadId 的 trusted start operation context 时才接受 primary。normalization 的“primary 胜出”只处理可信 start payload 内去重，不承担授权。
   - 扩展项目删除影响摘要，加入受影响 Todo 数量和对应变更结果。

2. **建立 sidecar 独占的 SQLite 存储**
   - 数据库路径为 `~/.lume/planning/planning.sqlite`，不混入 submissions、memory 或 desktop 数据库。
   - 沿用仓库现有 SQLite 驱动兼容方式和迁移习惯，不引入 ORM或新依赖；仅在现有适配代码无法直接复用时抽取最小公共 helper。
   - 数据库启用 `WAL`、外键、`busy_timeout`，使用 `PRAGMA user_version` 管理迁移，并在初始化时执行 `quick_check`。
   - 建立三张表：
     - `planning_todo`：Todo 当前快照；
     - `planning_todo_link`：Todo 与 thread/message/run 的 `primary | mentioned` 关系及首次/最近引用时间；
     - `planning_todo_event`：创建、编辑、完成、重开、删除、恢复、移动项目、关联线程等审计事件。
   - 约束包括：字段枚举检查、日期/精确时间互斥、非负递增 revision、外键和索引；使用表达式部分唯一索引（例如 `COALESCE(workspace_id, '<unassigned>'), normalized_title`）约束“未删除且 open”的同作用域标题，明确覆盖 `workspaceId IS NULL`，不用 SQLite 会放过多个 NULL 的普通 UNIQUE 语义。
   - `planning_todo_link` 不对含 NULL 的宽元组使用普通 UNIQUE，而是定义 relation-specific CHECK/索引：
     - 所有 link 的 `thread_id` 必填；
     - `primary` 必须 `message_id IS NULL`，通过 `UNIQUE(thread_id) WHERE relation='primary'` 保证每个 thread 永远最多一个 primary，同一 Todo 可 primary 到多个 thread；
     - `mentioned` 必须 `message_id IS NOT NULL`，通过 `UNIQUE(todo_id, message_id) WHERE relation='mentioned'` 去重同一消息内的同一 Todo；
     - nullable `run_id` 只是关联属性，在 run 创建后幂等补写，不参与唯一键。
   - thread/message/run 属于外部存储，因此 link 只保存稳定 ID，不伪造跨库外键；链接增加目标生命周期标记。线程进回收站时链接保留，永久删除时标记为 tombstone，历史 event 仍可审计；用户永久清理 Todo 时在单一事务删除 Todo、links 和 events。
   - 标题规范化仅用于去重：Unicode 规范化、去除首尾空白、合并连续空白、统一大小写；保留用户原始展示标题。
   - 写操作使用 `BEGIN IMMEDIATE`，事件与当前快照在同一事务提交。除 Create 外，所有写入必须携带 `expectedRevision`，冲突返回最新服务端快照和明确的 conflict 类型。
   - Create 在唯一约束冲突时返回已有 open Todo，并标记 `deduplicated: true`；不静默覆盖字段。
   - Delete 为软删除；Restore 回到删除前状态。永久清理由用户在回收站二次确认后触发，V1 不向 Agent 暴露硬删除工具。
   - `planning_todo_event` 使用数据库生成的单调自增序号；变更通知在事务提交后携带该序号发布，禁止进程内计数器。event 还保存 operation ID/phase，为跨存储操作提供可恢复的幂等记录。
   - List 使用稳定排序和游标分页：逾期、今日到期、未来到期、优先级、最近更新；`Today` 包含已逾期和今日截止。
   - 日期筛选统一由 sidecar 使用当前机器的 IANA 时区计算，所有 surface 共用同一查询时区：`dueDate` 作为 floating local date 与该时区的当前日期比较，`dueAt` 作为绝对时刻转换到该查询时区后分类，`dueTimezone` 仅用于保留原始输入和展示。时钟/时区作为 store 查询依赖注入以便测试，不接受模型或任意 message metadata 决定权限或日期边界。
   - 将 Planning 数据库纳入 `packages/shared/src/types/data-management.ts` 对应的扫描、导出、迁移、删除与大小统计，包含 SQLite 主文件和 WAL/SHM；sidecar shutdown 显式 checkpoint/close，避免形成数据管理不可见的孤岛。

3. **通过类型化 RPC 暴露存储能力并提供实时同步**
   - renderer 可调用的公开 Planning RPC 仅包括经过桌面会话和 workspace 校验的 list/get/create/update/complete/reopen/delete/restore/purge、项目计数和 start/continue。链接写入、operation phase、receipt reconciliation、tombstone 与项目生命周期批处理是 sidecar service 内部方法，不注册到 `createRpcHandlers()` 的公开 handler map。
   - 所有公开 RPC 输入在边界处校验；renderer 不直接访问 SQLite。公开 CRUD/start 基于 sidecar 解析出的当前桌面会话/workspace 权限执行，不能提交任意 thread ownership 或 internal operation phase；start 只接受 todoId、expectedRevision、目标 workspace（需要时）和 idempotency key，thread/link ownership 全由服务端决定。
   - 写入成功后发布带持久 event 序号、Todo ID 和作用域信息的 Planning change event。页面、侧栏计数和已展示详情收到事件后按 ID 失效并重新拉取，避免维护第二套真相。
   - renderer 的 desktop API 只提供类型化调用和订阅封装，遵循现有错误映射、连接恢复及 atom/query 模式。Quick Input 是独立 renderer，不共享主窗口 Jotai/tab 状态；同步通过 sidecar change event，打开主窗口 Todo 则通过现有 desktop 窗口间导航事件/API。
   - 范围 grant 不走通用 `sidecar_call`：在 `apps/desktop/src/main.ts` 增加专用 IPC，主进程按 `webContents`/BrowserWindow 注册表验证调用来自 main 或 Quick Input 窗口，再调用 sidecar 内部 grant endpoint；同一主进程路径把 opaque grant token 放入受信任的 agent-send transport envelope，禁止 renderer 放入 `messageMetadata`。Sidecar 只接受来自 desktop 主进程连接的该内部字段。
   - 可信 surface 也不依赖 grant 是否存在：扩展现有 `agent:send-thread-message` 主进程路径，对每一次普通 main/Quick Input 发送都按 sender `webContents` 注入受信任的 `surface=main|quick-input`；sidecar 忽略客户端同名字段。IM router、Routine/Automation runner、subagent launcher 和 recovery service 分别在内部直接创建其 surface context，因此无 grant 的普通 run 也能执行工具可用性矩阵。
   - 断线重连后执行一次作用域级 refetch；事件只用于加速刷新，不作为持久数据源。

4. **实现受来源和作用域约束的 Agent 工具**
   - 在 sidecar Agent runtime 中实现八个 `PlanningTodo*` 工具，经现有 `ToolRuntime`、`ToolRegistry`、`ToolResolver` 注册并提供准确 metadata，复用权限、风险等级、审计和 runtime event 机制，不把它们混入 SDK 的 `TodoWrite` 实现。
   - 新建 sidecar-owned、不可由模型或 renderer 任意字段伪造的 `ExecutionSurfaceContext`，由可信入口创建并贯穿 RPC handler、IM router、Automation runner、runtime `run.ts` 和 `ToolRuntime`。包含 `surface`（`main | quick-input | im | routine | automation | subagent | recovery`）、可信 workspace/thread、run ID、可选 continuation operation 和 sidecar-issued `planningScopeGrants`；客户端 `traceContext.origin`、`threadType` 和 `messageMetadata` 继续只用于展示/关联，不能作为授权依据。
   - `PlanningScopeGrant` 是 sidecar 保存的短生命周期记录，外部只拿不可猜 token。run 前先绑定 `{clientSubmissionId, surface, scope, workspaceId?, allowedOperations, mode, expiresAt}`；`allowedOperations` 是 `list|get|create|update|complete|reopen|delete|restore|start` 的非空闭合集合。Agent service 接受 submission 并生成 runId 时，在同一 sidecar 临界区把它原子换绑为 runId。`mode=turn` 可在同一 run 内供分页和多个“范围与 operation 都匹配”的 Planning tool call 复用，`mode=tool_call` 额外绑定 toolCallId 并只消费一次；二者都不能跨 run、scope、workspace 或 operation 使用。
   - grant 来源与能力固定为：main/Quick Input 范围选择默认只签发 `list|get`；现有工具权限确认只签发该次请求的具体写 operation；Routine todo_review 只签发全局 `list|get`；显式 `planning_todo_ref` 为对应 Todo ID 签发 `get|update|complete|reopen|delete|restore`；start flow 只签发该 Todo 的 `get|start`；从本轮 List/Get 获得的 authorized ID 可用于用户已允许 surface 上的后续 mutation，但仍需该 mutation 的现有风险/权限确认。普通消息文本、模型参数、IM metadata 均不能签发 grant；任何 read-only grant 用于 write 都在 Planning service 二次拒绝。IM 若请求 all/global，V1 必须通过可交互的工具确认，否则要求缩小范围。
   - 未绑定 grant 超时或 submission 被拒绝即删除；绑定后在 run 完成/取消时失效。renderer/transport 断线但 run 仍执行时 grant 仍仅绑定该 run，不能被复用；sidecar 重启会丢弃未绑定的临时 grant，已持久 operation 的 recovery 重新按 operation 权限建立 continuation，不恢复普通范围 grant。
   - 可用性矩阵：
     - 主窗口 Agent、Quick Input 对话、IM：完整工具集；
     - Routine、Automation：仅 List/Get；
     - subagent：不注册 Planning Todo 工具；由主 Agent 显式传递所需上下文；
     - recovery：不是伪造一个新 thread type，而是在可信 execution context 中携带由 sidecar 签发/查回的 continuation operation ID；只允许恢复该 operation 已记录的动作，不允许由旧上下文发起新写入。
   - 默认作用域：项目线程使用当前 workspace；无项目线程使用 unassigned；Quick Input 使用当前选择的 workspace。查询 all/global 或创建 unassigned 必须明确指定。
   - 跨项目写入按 ID 仍需授权：目标必须属于可信当前 workspace，或该 ID 来自本轮用户显式 `planning_todo_ref`，或来自本轮工具 List/Get 的结果。每次 run 在 `ToolRuntime` 旁建立短生命周期的 authorized Todo ID 集合，不进入 tool singleton、不跨轮复用；all/global 和从项目线程写入 unassigned 必须消费匹配的 `PlanningScopeGrant`，不能以“模型判断用户有明确意图”或 tool 参数代替可信 grant。
   - Agent 行为规则：
     - 用户明确说“记个待办 / 稍后做 / 加到 Todo”时直接创建，不重复确认；
     - Agent 推断出的未来事项先用现有 `AskUserQuestion` 确认；
     - 运行内部步骤、失败重试和调试过程不得自动积累为 Planning Todo；
     - 完成 Agent 任务不自动完成 Todo，必须在验证目标确实完成后读取最新 revision，再显式调用 Complete；
     - Task 或 TodoWrite 完成不联动 Planning Todo 状态。
   - 所有工具返回统一版本化结构：`{ schemaVersion, operation, todo, deduplicated }`，List 可在同一 envelope 中返回分页 items；UI 不解析自然语言结果。
   - 写工具的结果事件包含 operation、前后 revision 和可逆操作所需信息，以支持审计与安全撤销。

5. **注入安全、最新且最少的 Todo 上下文**
   - 在系统提示中写明 Planning Todo、TodoWrite、Task 的边界、工具选择规则、确认策略和完成策略。
   - `&` 提及生成 `planning_todo_ref` part；发送前只保存 Todo ID 与展示快照。`ContextAssembler` 在每次 run 开始时按 ID 读取最新数据、校验 Todo 存在性、可信 workspace 和本轮权限，再把结果作为“不可信用户数据”注入上下文。
   - 普通 `&` 引用建立 `mentioned` 关系，只在当前轮注入，可多选；默认限制单轮引用数量和描述长度，超限时给出可理解的 UI 提示。
   - 由 Todo 启动的专用 thread 最多有一个 `primary` Todo。只要 Todo 仍为 open，每轮和上下文压缩后都重新注入它的最新快照；Todo 完成后保留链接和历史 chip，但停止自动注入。
   - Todo 内容不得被拼接为系统指令；使用结构化边界和明确的不可信标记，防止标题或描述中的提示注入改变 Agent 权限。

6. **实现幂等的“开始处理 / 继续处理”编排**
   - 在 sidecar 提供单一 Planning start service，对接 `agent-submission-store.ts`、`agent-service.ts` 和现有发送消息流程，复用 thread 创建、消息提交和幂等 submission receipt；renderer 不自行串联多个脆弱 RPC。
   - 第一次开始时创建当前 workspace 下标题为 `处理：<title>` 的 thread，将 Todo 设为该 thread 的唯一 `primary`，并发送结构化 `planning_todo_ref`。
   - 已有关联 thread 时，主操作为“继续处理”：
     - 最近 thread 正在运行则只打开它，不重复发送；
     - 空闲则打开并发送继续处理消息；
     - 菜单允许显式创建新的关联 thread，Todo 可关联多个 thread 并记录最近使用项。
   - unassigned Todo 第一次开始前要求用户选择 workspace，并在同一编排中保存 workspace 归属。
   - 使用客户端 idempotency key 防止双击产生重复 thread 或消息，具体恢复协议为：
     1. 在 `planning_todo_event` 事务内写入唯一 `(operationId, requested)`，冻结 todoId、expectedRevision、目标 workspace 和意图；重复 key 返回现有状态；
     2. 新 thread 带 sidecar-owned `createdByPlanningOperationId` 标记创建，发送消息时复用 operation ID 派生的 `clientSubmissionId`；
     3. Agent submission receipt 接受成功后，在 Planning 事务内写入/更新 link 和 `(operationId, linked)` event；若进程在两者之间退出，重试或启动时 reconciler 根据 receipt 补齐 link；
     4. 预接受失败时，仅当 thread 仍带同一 ownership 标记、没有任何 accepted submission/message 且未被用户复用，才回收该空 thread；否则保留并记录需人工恢复的失败 event；
     5. 接受后的响应丢失从 submission receipt 与 Planning operation event 恢复结果，不重复创建 thread 或发送消息。
   - start、项目移除和 thread delete 使用 shared 中的 discriminated operation union，公共 envelope 为 `{ schemaVersion, operationId, kind, status, phase, recoverable, compensation, todoId?, threadId?, error?, updatedAt }`：
     - `status` 闭合为 `pending | running | completed | partial | failed | reconciling | compensated`；
     - `compensation` 闭合为 `none | pending | completed | failed`；
     - `kind=start` phase：`reserved | thread_created | submission_accepted | link_committed | compensating | reconciled | finalized`；
     - `kind=continue` phase：`reserved | submission_accepted | link_touched | reconciled | finalized`；
     - `kind=project_keep_history | project_delete_lume_data` phase：`prepared | planning_committed | threads_processed | workspace_removed | compensating | finalized`；
     - `kind=thread_delete` phase：`prepared | links_tombstoned | index_removed | files_removed | cleanup_pending | compensating | finalized`。
   - 合法状态迁移由每个 kind 的 reducer 集中校验：reserve=`pending`，执行阶段=`running`，崩溃待查=`reconciling`，有已提交副作用的失败=`partial`，reserve 后但无副作用且不可重试=`failed`，补偿完成=`compensated`，finalized=`completed`。operation 在持久 event 中 reserve 后，即使 RPC 后续失败也返回/可查询该 envelope；只有 reserve 前的输入校验失败使用普通 RPC error。UI 必须把 pending/running/reconciling/partial 显示为非终态或“可能已部分执行”，提供按 operationId 轮询、重试恢复/查看详情，不能解释成“什么都没发生”。
   - 所有开始消息只携带 Todo ID；Agent 侧重新读取最新数据，不把 UI 中可能过期的标题/描述直接当作指令。

7. **新增符合 Lume 现有设计的 Todo 主页面**
   - 为现有 tab/sidebar 架构加入 Todo tab，完整接入 `tab-atoms.ts`、`TabContent.tsx`、`TabBar.tsx`、tab 持久化/恢复和项目删除时的 tab 清理；侧栏“待办”入口显示当前项目 open 数量，打开主内容区而非独立 Electron 窗口。
   - 页面默认当前项目和 Open 视图，顶部提供项目范围、搜索、单行快速创建；可切换 current/all/unassigned，以及 Open/Today/Upcoming/Completed/Trash。
   - 列表按服务端稳定规则排序；行内主操作为开始/继续处理，完成、重开为轻量操作，移动项目和删除放入菜单。
   - 桌面宽度使用右侧详情 inspector，窄宽度改为 overlay。详情支持标题、描述、优先级、截止时间和项目归属。
   - 新增交互控件必须复用 `apps/web/src/components/ui` 的全局 shadcn 原子组件；只为缺失的通用控件补全全局组件，不在业务页面手写整套视觉样式。
   - Create、Complete、Reopen 做乐观更新，失败时回滚并显示页面 toast。详情自动保存使用 revision CAS：
     - 保存中/已保存状态可见；
     - 多字段编辑以 dirty-field patch 合并，不用旧快照覆盖未修改字段；
     - 冲突时保留本地草稿，展示服务端最新值，并提供“重新载入”或“基于最新版本覆盖”的明确选择。
   - 回收站 Restore 为普通操作，永久清理必须二次确认。

8. **接入现有工具展示、对话输入与 Agent Header**
   - 在现有 `RuntimeEventContentBlock -> ToolResultRenderer` 注册 Planning Todo 的结构化结果 renderer，沿用工具卡片、最小行、状态、耗时和风险标识。工具调用及其版本化结果继续由现有 run observer/message projection 持久化，使用稳定 call/block ID 跨轮重建；renderer 以结果快照首屏展示，再按 todoId/revision 拉取最新状态。
   - Create/Update/Complete/Reopen/Delete/Restore 展示状态、标题、项目、优先级、截止时间，并在仍有效时提供“打开”或撤销动作；撤销 Create 等价于对最新 revision 软删除，撤销 Complete 等价于对最新 revision Reopen。revision 已变化时禁用撤销并引导打开最新 Todo。
   - List 使用紧凑列表，Get 使用详情卡；Agent 工具成功不额外叠加 toast，避免卡片与 toast 重复反馈。Planning 变更不得投影为现有 TodoWrite 专用的 `todo.state_updated`；未知 schemaVersion 使用现有 raw result fallback，不破坏历史消息。
   - 对话输入增加 `&` suggestion：当前项目 open Todo 优先，支持模糊搜索和切换全部范围；插入独立 Todo mention chip，历史消息可点击打开，已删除或无权限时显示“不可用”。
   - 专用 thread 的 AgentHeader 显示 primary Todo chip；底部 `TodoPanel` 继续只展示 TodoWrite 执行清单，Task 继续使用原面板。

9. **让 Quick Input 和命令面板承担低摩擦收集**
   - 复用现有 Quick Input 窗口，加入 Chat/Todo 本地模式，默认仍为 Chat；输入开头 `/todo` 直接切换 Todo 模式，不调用模型。
   - Todo 模式只展示必要字段：标题、当前项目/未分配、可选截止日期、优先级。Enter 保存；成功后清空并保留窗口以便连续录入；Esc 关闭。
   - Quick Input 直接调用 Planning RPC，因此用户明确捕获不需要 Agent 二次确认；它只消费 sidecar Planning events 更新自身局部状态，不读写主窗口 tab atom。
   - 命令面板增加 Todo 搜索结果和“以当前查询创建 Todo”动作；打开结果复用 Todo tab 与详情 inspector，不另造导航机制。

10. **替换 Routine 的非结构化 Todo 来源并处理项目生命周期**
   - Planning Todo 成为 Lume 唯一结构化待办来源。Routine generator 直接从 Planning store 计算用户级全局 `unfinishedTodos`（所有 workspace + unassigned 的未删除 open Todo），但保留现有执行模型：`todo_review` 仍由 `routine-activities.ts` 创建 Automation job/prompt，并由 `routine-executor.ts` 执行，不另造一条 Routine 结果管线。
   - Routine 内部创建 todo_review Automation job 时，在 sidecar-owned job record 写入不可由公共 create/update schema 设置的 immutable provenance：`{ kind: 'routine_todo_review', routineId, activityId }`；prompt 和 `messageMetadata.automationJobId` 只作内容/关联，不构成 provenance。Automation runner 每次实际执行（包括延迟执行和 sidecar 重启后）重新读取 job record，验证对应 Routine/activity 仍有效，再现场签发仅该 run 有效的全局只读 `PlanningScopeGrant`。其可信 `surface=automation` runtime 只注册 PlanningTodoList/Get，按截止时间、逾期和优先级生成带项目标签的回顾。其他 Automation 默认限定 thread workspace 或 unassigned，V1 不提供全局范围配置。
   - Memory 仍保存背景、偏好和历史知识，不再作为 Todo 结构化来源；不自动迁移旧 Memory 中可能存在的待办文本，避免误识别和重复创建。
   - 项目移除预览显示受影响 Todo 数，并同时接入 Sidebar 与 Settings 两个删除入口：
     - `keepHistory`：open/completed Todo 均清空 `workspaceId`，转为 unassigned，保留状态、链接和事件；
     - `deleteLumeData`：open/completed Todo 均清空 `workspaceId` 并软删除到 Todo 回收站；
     - 恢复 thread 不自动恢复或重新绑定 Todo。
   - `keepHistory` 移入 unassigned 时若撞上已有 open Todo 的规范化标题，不合并或丢弃任一 Todo：为迁入项追加稳定、可见的原项目后缀（重名时再加序号），在 impact 预览中报告冲突数，并在 event 保存原标题以支持补偿。
   - 把 Planning 作为 `agent-project-lifecycle-service.ts` 中一个明确的 prepare/commit/compensate participant，而不是宣称跨 JSON、Wiki、thread index 和 SQLite 原子提交：
     1. prepare 在 Planning 事务中计算影响、标题冲突方案和 before snapshot，写入唯一 operation event，但不改变 Todo；
     2. 现有生命周期先 drain runtime 并完成各阶段预检；在 workspace/thread 索引最终删除前执行 Planning commit；
     3. commit 事务完成 keepHistory 或 deleteLumeData 变更并记录 after snapshot；通知只在该事务提交后发布；
     4. 后续阶段失败时执行幂等 Planning compensate，并明确报告现有生命周期中无法逆转的外部阶段（例如已完成的 Wiki 归档），不伪造“最终项目事件即原子提交”；
     5. `trashAgentThreads()` 只保留链接并标记目标在回收站；`agent-thread-manager.ts` 的统一 `deleteAgentThread()` 为每个 thread 获取生命周期互斥锁，并使用 `thread_delete` operation：在任何 index mutation 前，Planning 事务保存 before snapshot 并把 links 幂等提交为 tombstone；随后删除 thread index，再清理 submission/session 文件。index 删除失败时在同一锁内 compensate links；index 已删除而文件清理失败时，thread 已逻辑删除且 tombstone 正确，operation 返回 `partial + cleanup_pending`，启动/定时 reconciler 继续清理残留文件而不复活 index。这样 direct delete、`emptyTrash()`、过期回收站清理和项目删除后清理都覆盖同一顺序。恢复 thread 不自动恢复/重绑 Todo。
   - 项目移除与直接 thread 删除共享一个最小 `AgentLifecycleLockManager`，不建立通用事务框架：项目移除先获取 `workspace:<id>` 独占锁，再按 threadId 排序获取其 thread 锁，并在锁内重读 impact/索引后执行 prepare/commit；直接永久删除先从 index 解析 workspace，再获取同一 workspace 锁和 thread 锁并重验归属。unassigned 使用稳定 sentinel key。`clearWorkspaceFromAgentThreads()`、`trashAgentThreads()` 和 `deleteAgentThread()` 的内部 mutation 需要 lock token/assertion，禁止绕开顺序；固定 workspace→sorted threads 的顺序避免与并发删除死锁。

11. **按风险建立聚焦验证**
   - Store 测试：首次建库、迁移、quick check 失败、CRUD、assigned/unassigned 标题去重、并发 create、CAS 冲突、日期约束和可注入时区、软删除/恢复/清理、primary/mentioned 的 relation CHECK 与 NULL 不绕过唯一索引、外部目标 tombstone、持久 event 序号、事务提交后通知、分页排序、WAL/SHM 数据管理扫描与关闭。
   - 工具测试：每次普通 agent send 都由 desktop main/内部 runner 注入可信 surface，伪造 origin/threadType/metadata/surface 不提权；PlanningScopeGrant 经 desktop main 的 submissionId→runId 原子换绑、allowedOperations 二次校验、read grant 写入拒绝、turn 分页复用/toolCall 单次消费、超时/拒绝/完成/取消/断线/重启失效语义；以及默认作用域、跨项目 run-local 授权集合、直接创建/推断确认、结构化返回、subagent 禁用、recovery operation 限制、stale revision 和撤销失效。
   - RPC 测试：公开 handler map 不暴露 link/phase/reconcile/tombstone 内部方法；公开 CRUD/start 不能伪造 thread ownership、workspace 或 operation phase；桌面范围选择只获得绑定 scope 的短期 grant。
   - 上下文测试：`planning_todo_ref` 的精确字段、URI/ID 一致性、去重/primary 优先规则、普通 send 伪造 primary 被拒且 trusted start 可通过、userMessage/modelMessage normalization，以及它在 shared schema、RPC、编辑器序列化、持久化和历史投影中的往返；无效历史 part 降级、capability projection 隔离、最新快照解析、历史引用不授权当前 run、权限失败、primary 自动注入/完成后停止、引用数量与长度上限、恶意标题/描述不能提升为指令。
   - 编排测试：首次开始、继续运行中 thread、空闲继续、新 thread、unassigned 选项目、并发/双击幂等、进程在 receipt 与 link 之间退出、提交前失败仅回收自有空 thread、响应丢失恢复、启动 reconciler，以及所有 kind 的闭合 phase/状态迁移和 pending/running/completed/partial/failed/reconciling/compensated UI 解释。
   - UI 测试只覆盖可测试交互逻辑：范围/筛选、乐观回滚、autosave dirty patch、冲突保留草稿、工具卡撤销、`&` 搜索、Quick Input `/todo` 模式和项目删除影响提示；纯样式不补仪式性测试。
   - Routine 和项目生命周期增加集成测试，证明 generator 全局统计、todo_review 仍走 Automation job、公共 job API 不能伪造 immutable Routine provenance、延迟/重启后 runner 现场签发一次性全局只读 grant、两个删除入口 impact、keepHistory 的 unassigned 重名改名、deleteLumeData、direct/emptyTrash/expired/project 四类永久 thread 删除在 index mutation 前 tombstone、index 失败补偿、文件清理失败 reconciliation；另以并发测试证明 project removal 与 direct delete 使用同一 workspace→sorted-thread 锁序、mutation helper 不能无 token 调用，以及 operation envelope 与 link 状态一致。
   - 仅运行上述相关测试和受影响 shared/sidecar/web 公共接口的定向 typecheck；不执行与改动无关的全量检查。

12. **按可回滚切片交付**
   - 建议实现顺序为：shared 契约与 store → RPC → Agent 只读工具 → 写工具与权限 → 消息引用/上下文 → 主页面 → 工具卡 → start service → Quick Input/命令面板 → Routine/项目生命周期。
   - 每个切片保持 schema version 和 feature surface 向后兼容；在 UI 入口启用前先让存储、RPC 和恢复路径通过测试。
   - 不迁移或删除现有 TodoWrite/Task 数据，不改变它们的 API；如需回滚，只隐藏 Planning UI/工具并保留独立数据库，避免影响 Agent 现有执行能力。

## Key decisions & tradeoffs

- **独立领域而非扩展 TodoWrite。** TodoWrite 是单次 Agent 运行的执行清单；Planning Todo 是用户拥有、跨任务持久化的承诺。分开会增加一组类型和工具，但避免状态语义、权限和 UI 互相污染。
- **SQLite 而非 JSON/Memory。** SQLite 提供唯一约束、事务、CAS 和审计所需的可靠性；独立数据库让故障域和迁移边界清晰，代价是需要处理 sidecar 生命周期和多运行时驱动兼容。
- **只持久化 open/completed。** 简化 Todo 领域并避免把 Agent 运行状态复制为容易失真的字段；代价是列表若要显示“处理中/失败”必须实时关联 thread 状态。
- **明确意图直写，推断意图确认。** 让用户说“记下来”时足够顺滑，同时防止 Agent 将讨论内容和内部步骤污染为长期 Todo。
- **乐观 UI + revision CAS。** 提供快速反馈但不牺牲多窗口/多渠道一致性；冲突交互比最后写入获胜更复杂，但能避免静默丢失用户编辑。
- **软删除和事件日志。** 支持工具卡撤销、回收站和项目删除恢复；付出少量存储与清理逻辑，换取可审计和可恢复性。
- **专用消息 part 和结构化结果。** 避免依赖易碎的自然语言解析，并允许历史引用稳定打开；需要同步修改 shared、renderer 与 sidecar 的消息协议。
- **单一 start service。** 跨 thread、submission、Planning DB 的操作不能依赖 UI 多步调用；服务端编排与幂等补偿增加实现复杂度，但显著降低重复 thread 和半完成关联。
- **复用 Quick Input、AskUserQuestion、RuntimeEvent 和 shadcn。** 不新增独立窗口、候选卡片系统、通知系统或第二套工具 UI，以最少新概念覆盖核心体验。
- **Routine 只读 Planning Todo。** 统一结构化 Todo 真相源；不自动迁移 Memory 中的模糊文本，接受上线初期旧待办仍需用户手动整理。

## Risks / open questions

- **跨存储原子性：** thread 索引、Agent submission、Wiki 与 Planning SQLite 无法使用同一数据库事务。计划以持久 operation event、submission receipt、提交顺序、reconciler 和有限补偿保证可恢复的最终一致；实现时必须用故障注入测试每个边界，并向调用方暴露 partial/recovery 状态，不能宣称真正的 ACID 原子性。
- **SQLite 运行时差异：** Lume 同时存在 Bun/Node SQLite 路径。迁移、事务错误码和部分唯一索引行为需在实际打包运行时验证，尤其是 Windows 文件锁和进程退出重开。
- **跨项目授权缓存：** “本轮已查询 ID”必须绑定单次 Agent run，不能落入长生命周期 tool singleton；否则可能意外扩大后续轮次权限。
- **自动保存冲突：** 快速连续输入、远端 IM 更新和详情切换可能造成乱序响应。实现需要为每个 Todo 串行提交 patch，并丢弃早于当前 revision 的响应。
- **工具卡撤销时效：** 卡片展示的是历史 revision；任何后续更新都会使原撤销动作失效。UI 必须显式禁用并拉取最新值，不能强行覆盖。
- **项目删除补偿：** 现有删除流程本身包含不可完全逆转的外部阶段。Planning participant 只承诺自身幂等补偿和清晰的 partial 状态；若无法安全进入 commit，应在 Planning 变更前失败，而不是隐藏中间状态。
- **规模与搜索：** V1 采用 SQLite 索引和分页，不引入全文搜索依赖。若真实数据量使 `LIKE` 模糊搜索不足，再以测量结果决定是否启用 SQLite FTS。

## Out of scope

- 重复规则、外部日历同步和外部任务系统同步。
- 将 Todo 自动拆成 Task、自动生成 TodoWrite，或由 Task/TodoWrite 完成状态自动关闭 Planning Todo。
- 由 Agent 永久清除 Todo；V1 永久清理由用户在回收站确认。
- subagent 直接查询或写入 Planning Todo。
- 为 inferred Todo 新建候选卡片协议；继续使用 `AskUserQuestion`。
- 新建独立 Todo Electron 窗口或系统托盘捕获器；继续复用主内容区和 Quick Input。
- 从 Memory、历史对话、Proma 数据库或其他应用自动迁移 Todo。
- 离线移动端体验。

## Scope addendum — Calendar and reminders (2026-08-01)

用户在实现审查阶段明确要求继续对齐 Proma 的日程能力，因此以下内容取代上面的原始 V1 排除项：

- 在同一 `planning.sqlite` 中增加独立 Calendar Event、Planning Group、Tag 和 Reminder 表；Calendar Event 与 Todo 可选关联，但不把 Event 降格为 Todo 的一种状态。
- Calendar Event 支持标题、备注、开始/结束时间、全天、项目、关联 Todo、日程分组、标签和 revision CAS；提供类型化 CRUD RPC 与资源级变更通知。
- Todo 和 Calendar Event 均可持有提醒；Todo 的精确 `dueAt` 默认同步一条系统来源提醒，完成 Todo 时结束未处理提醒。提醒支持确认和 1–10080 分钟稍后提醒。
- sidecar 每 30 秒以 SQLite claim 方式获取首次到期或 snooze 后再次到期的提醒；desktop main 负责原生系统通知，renderer 使用常驻提醒条恢复未确认提醒。
- Todo 主页面增加 Todo/日程切换；日程提供月/周视图、创建、详情自动保存、删除、分组、标签、Todo 关联和 Automation 只读叠加。新增控件继续复用 Lume 全局 shadcn 原子组件。
- 不迁移 Proma 数据；不实现重复日程、外部日历同步、邀请参与者、会议室或移动端离线提醒。
- 通用 ORM、跨数据库事务框架或与本功能无关的 SQLite 基础设施重构。

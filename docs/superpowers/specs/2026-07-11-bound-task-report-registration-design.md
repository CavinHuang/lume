# Bound TaskReport Runtime 注册修复设计

## 问题

绑定 Subagent Run 会向模型暴露 `TaskReport`，但当前实现是在 `ToolRuntime.resolveDynamicTools` 完成后才将绑定工具追加到返回数组。模型因此能生成 `TaskReport` 调用，权限网关却无法在 Runtime descriptor 表中找到它，持续返回“工具未注册到 Runtime descriptor: TaskReport”。完成守卫随后反复要求提交报告，直到耗尽 turns。

## 根因证据

- 真实子会话 transcript 中存在多次 `TaskReport` tool use。
- 每次调用对应的 tool result 都是 descriptor missing。
- 同一 Run 最终执行到 Turn 80，仍未产生结构化报告。
- 绑定工具当前在动态 resolver 返回之后追加，未经过 descriptor 注册和 runtime wrapper。

## 修复设计

### 统一绑定身份

在创建 Runtime session 时解析一次 validated bound identity。`subagentRunId` 与 `subagentTaskId` 必须同时存在且非空，或者同时缺失；绑定子会话只有一个经过校验的 `{ runId, taskId }` 对象。工具创建、系统提示和 completion guard 全部使用该对象，禁止各自判断不同的可选字段。

字段只出现一个时立即拒绝创建 session，不进入模型循环，避免“有 guard、无绑定工具”的不可完成状态。

### 宿主必需工具

绑定的 `TaskReport` 作为宿主必需工具交给 `ToolRuntime.resolveDynamicTools`。普通工具先经过角色、plan 和 toolPolicy 可见性过滤；必需工具随后按 canonical name 覆盖合并，再统一注册 session descriptor 并应用 runtime wrapper。

必需 descriptor 仅对当前绑定实例标记 `allowedInPlanMode: true`。普通 `TaskReport` 的全局 metadata 保持不变，工具执行仍经过 `canUseTool`、guardrail 和权限 gateway。

删除 resolver 之后追加未注册工具的路径。显式绑定的 `TaskReport` 覆盖角色工具白名单和静态 toolPolicy，因为它是宿主完成协议，而不是角色可选能力。

### 变更语义

绑定 `TaskReport` 会调用 coordinator 写入 Run 报告，因此必须声明为非只读、非并发安全工具。descriptor metadata、runtime wrapper 和 SDK 调度看到的只读语义必须一致，确保它与其他变更工具串行执行。

## 验证

- 创建绑定 `explorer` 子会话；该角色的普通工具白名单不包含 `TaskReport`。
- 断言 active tool names 包含 `TaskReport`。
- 断言 `getRuntimeToolDescriptor(sessionId, "TaskReport")` 存在。
- 在 plan + toolPolicy deny 场景下通过真实 `ToolExecutionGateway` 授权绑定报告。
- 构造 generic 与 bound 同名工具，断言最终只保留一个且执行绑定实现。
- 使用真实 coordinator Run 验证：guard 初始阻止结束，绑定报告写入正确 Run 后 guard 解除。
- 验证 bound `TaskReport` 的 definition、descriptor metadata 与 wrapper 均为非只读。
- 验证缺失 run/task 任一字段时 session 创建立即失败。
- 保留既有子会话不允许派生 `Agent` 的断言。
- 运行 runtime-core 定向测试和 Sidecar 类型检查。

## 非目标与风险

- 不绕过权限网关的 descriptor 检查。
- 不修改 explorer/planner 等角色的静态工具配置。
- 不移除成功输出生成兜底报告的防御逻辑。
- 已经结束且持久化为 `report=null` 的历史 Run 不追溯迁移。

## 清理计划

1. 删除 `run.ts` 中分别基于 `subagentRunId`、`subagentTaskId` 的绑定工具与 guard 条件。
2. 以一个 validated bound identity 替换这些分散判定，保持非绑定会话行为不变。
3. 修正绑定报告的只读声明，删除由错误语义产生的并发可能。
4. 保留 `requiredTools` 机制，但用 collision、gateway 和 coordinator 集成测试锁定其宿主必需工具语义。
5. 不清理任何无关工具策略、历史 Subagent 实现或现有工作区改动。

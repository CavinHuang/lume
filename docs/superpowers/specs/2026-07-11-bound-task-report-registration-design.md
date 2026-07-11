# Bound TaskReport Runtime 注册修复设计

## 问题

绑定 Subagent Run 会向模型暴露 `TaskReport`，但当前实现是在 `ToolRuntime.resolveDynamicTools` 完成后才将绑定工具追加到返回数组。模型因此能生成 `TaskReport` 调用，权限网关却无法在 Runtime descriptor 表中找到它，持续返回“工具未注册到 Runtime descriptor: TaskReport”。完成守卫随后反复要求提交报告，直到耗尽 turns。

## 根因证据

- 真实子会话 transcript 中存在多次 `TaskReport` tool use。
- 每次调用对应的 tool result 都是 descriptor missing。
- 同一 Run 最终执行到 Turn 80，仍未产生结构化报告。
- 绑定工具当前在动态 resolver 返回之后追加，未经过 descriptor 注册和 runtime wrapper。

## 修复设计

当会话是绑定 Subagent Run 且拥有 `subagentRunId` 与 `subagentTaskId` 时，在调用 `ToolRuntime.resolveDynamicTools` 之前，把绑定的 `TaskReport` 合并进待解析工具集合。动态 resolver 负责统一生成 descriptor、注册 session descriptor 表并应用 runtime wrapper。

删除 resolver 之后追加未注册工具的路径。显式绑定的 `TaskReport` 仍覆盖角色工具白名单限制，因为它是宿主完成协议，而不是角色可选能力。其他工具继续遵循既有角色和全局策略。

## 验证

- 创建绑定 `explorer` 子会话；该角色的普通工具白名单不包含 `TaskReport`。
- 断言 active tool names 包含 `TaskReport`。
- 断言 `getRuntimeToolDescriptor(sessionId, "TaskReport")` 存在。
- 保留既有子会话不允许派生 `Agent` 的断言。
- 运行 runtime-core 定向测试和 Sidecar 类型检查。

## 非目标与风险

- 不绕过权限网关的 descriptor 检查。
- 不修改 explorer/planner 等角色的静态工具配置。
- 不移除成功输出生成兜底报告的防御逻辑。
- 已经结束且持久化为 `report=null` 的历史 Run 不追溯迁移。

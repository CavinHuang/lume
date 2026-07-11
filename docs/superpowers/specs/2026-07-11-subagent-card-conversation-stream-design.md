# Subagent 卡片完整会话流设计

## 背景与根因

主 Agent 中的 Subagent 卡片当前通过 `subagent-run-projection.ts` 把子线程事件压缩为一个 `publicText` 字符串。这个投影在收到每次 `assistant.final` 时直接替换字符串，并且有意忽略 thinking，只把工具事件折叠为计数和最新工具名。因此，卡片中的旧内容会被后续消息覆盖，且无法展示完整工具与思考过程。

打开子会话时使用的 `runtime-event-message-projection.ts` 已经支持完整语义：流式 delta、final 对当前片段的校正、多轮文本累积、thinking、工具开始/完成/失败以及运行终态。问题不是事件存储缺失，而是卡片选择了一个有损的专用投影。

## 目标

- 展开的 Subagent 卡片完整展示本次逻辑 Run 的任务提示、assistant 文本、thinking、工具调用与工具结果。
- 新事件按子会话中的顺序流式追加；`assistant.final` 只校正当前流式片段，不覆盖此前消息或工具块。
- 一个逻辑 Run 包含的所有 `runtimeRunIds` 都参与展示，覆盖 provider fallback 等多 attempt 场景。
- 卡片和打开子会话使用相同的消息投影与内容组件，避免两套消息语义继续漂移。
- 折叠卡片保持轻量，只显示最新活动摘要。

## 非目标

- 不在卡片中复制完整线程页面的 minimap、Todo 浮层、线程级 IPC 加载和导航框架。
- 不改变 Subagent 的消息存储格式、任务状态机或 TaskReport 协议。
- 不允许 Subagent 派生新的 Subagent。
- 不改变主 Agent 消息流的归属规则。

## 方案选择

采用“共享投影和消息内容组件”的方案：

1. 从 `childThreadId` 对应的 runtime events 中筛选本逻辑 Run 的事件。
2. 使用 `runtimeRunIds` 的集合筛选全部物理 attempt；旧数据没有映射时回退到协调 Run ID。
3. 将筛选后的事件交给现有 `applyRuntimeEventsIncremental`，得到与打开子会话一致的 `RuntimeMessageView[]`。
4. 展开卡片使用 `RuntimeEventContentBlock` 按顺序渲染这些消息。

不继续扩展扁平 `publicText` 投影，因为那会重复实现完整会话投影器已经解决的片段边界、工具更新和 thinking 顺序。也不直接嵌入 `AgentMessages`，因为它包含线程级数据加载、minimap、Todo 和外层滚动管理，放入卡片会产生重复订阅和嵌套滚动职责。

## 数据流

```text
child RuntimeEvent atom
  -> 按 logical Run 的 runtimeRunIds 筛选
  -> applyRuntimeEventsIncremental
  -> RuntimeMessageView[]
  -> RuntimeEventContentBlock
  -> Subagent 卡片内嵌会话流
```

事件仍只存储在子线程 atom 中。主线程只持有 Run/Task/Session 链接，卡片按链接读取，不复制子消息到主消息列表。

## 投影边界

- 保留 `message.user.submitted`，因此卡片会显示主 Agent 派发给子 Agent 的完整任务提示。
- 保留 `assistant.delta`、`assistant.thinking_delta`、`assistant.final`。
- 保留工具开始、完成、失败与结果预览。
- 保留 run completed、failed、cancelled 和 turn-limited 状态。
- 保留同一逻辑 Run 的所有物理 attempt，并按原事件顺序展示。
- 排除属于其他逻辑 Run 的事件，即使它们复用了同一个持久化子线程。

## 渲染与滚动

- 展开卡片使用独立、有限高度的滚动容器。
- 首次展开运行中的卡片定位到底部，以便看到当前输出。
- 当用户位于底部附近时，新事件继续自动贴底。
- 用户主动向上滚动后停止自动拉回；再次滚到底部后恢复。
- 折叠态不挂载完整 Markdown、thinking 或工具组件，只根据最后一条可见活动生成摘要。

## 完成与错误展示

- 完成后保留完整消息时间线，并在其后展示 TaskReport 摘要，不用单个“结果已完成”正文替换时间线。
- 失败时保留失败前已经产生的文本、thinking 和工具结果，再在末尾展示错误。
- 没有事件时保留“等待 Subagent 输出”的占位状态。

## 代码边界

- `subagent-run-projection.ts`：改为筛选逻辑 Run 事件并生成完整 `RuntimeMessageView[]`；不再维护正文拼接状态。
- `SubagentInlinePanel.tsx`：消费完整消息数组，复用 `RuntimeEventContentBlock`，保留卡片头、任务信息、状态和 TaskReport 区域。
- `runtime-event-message-projection.ts`：继续作为唯一的消息语义实现，仅在复用需要时暴露已有增量接口，不复制逻辑。

## 测试策略

- 投影测试：两段 assistant 输出之间插入工具调用，后段 final 不得覆盖前段。
- 投影测试：thinking、工具开始/完成和文本保持原始顺序。
- 投影测试：同一逻辑 Run 的多个 `runtimeRunIds` 全部保留，其他 Run 被排除。
- 组件测试：展开卡片渲染任务提示、thinking、工具和全部文本；完成/失败不移除既有时间线。
- 边界回归：子事件仍不进入主 Agent 的消息投影。
- 运行 Web 类型检查和相关定向测试，不执行无关全量测试。

## 风险与约束

- 完整消息组件比单个 Markdown 字符串更重；通过折叠态延迟挂载和按 Run 筛选控制成本。
- 持久子线程可能包含多个逻辑任务，必须以 `runtimeRunIds` 过滤，不能直接展示整个 child thread atom。
- 历史数据若缺少 runtime attempt 映射，只能按协调 Run ID 回退；该兼容路径可能无法恢复早期未建立映射的事件。

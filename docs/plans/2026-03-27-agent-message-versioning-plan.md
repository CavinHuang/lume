# 2026-03-27 Agent 消息版本切换实现计划

## 1. 目标

为 Lume Agent 消息列表增加“版本记录与切换查看”能力，支持类似 `5/5` 的版本导航条，让用户在以下场景中查看同一消息组的历史版本：

- 用户消息重发
- 用户消息编辑后重发
- assistant 回复的多次生成结果切换

要求：

- 版本历史可持久化，不依赖前端内存态
- 默认消息列表仅展示当前可见版本，不污染主时间线
- 可在单条消息内切换查看版本
- 不破坏现有 `Tauri desktop + Next.js web + Bun sidecar + shared packages` 架构边界

## 2. 当前现状

当前 Agent 消息重发链路基于“截断并重发”：

- Web 侧调用 `truncateAgentMessagesFrom`
- Sidecar 删除指定消息及其后续消息
- 新消息重新写入会话

这意味着：

- 旧版本在数据层被物理删除
- `AgentMessage` 没有版本链字段
- UI 无法构造版本组，也无法展示 `n/m`

结论：该能力不是单纯前端 UI 问题，必须同步改造 shared contract、sidecar 存储和 web 渲染模型。

## 3. 首期范围

首期只覆盖 Agent 消息版本，不扩展到 Chat。

首期支持：

- user message 的版本历史
- 与该 user message 对应的 assistant message 版本历史
- 单线性版本链，不做分叉树视图
- 当前版本/历史版本切换查看

首期暂不支持：

- 可视化分支树
- 不同版本间 diff 视图
- 跨 session 的版本聚合
- Chat 模块版本统一

## 4. Contract 设计

### 4.1 `AgentMessage` 扩展字段

在 `packages/shared/src/types/agent.ts` 为 `AgentMessage` 增加版本相关字段：

- `versionGroupId?: string`
- `versionIndex?: number`
- `versionCount?: number`
- `supersedesMessageId?: string`
- `supersededByMessageId?: string`
- `isLatestVersion?: boolean`

建议语义：

- `versionGroupId`: 同一逻辑消息链共享的组 ID
- `versionIndex`: 当前消息在组内的 1-based 序号
- `versionCount`: 当前组总版本数
- `supersedesMessageId`: 当前版本替代了哪条旧消息
- `supersededByMessageId`: 当前版本被哪条新消息替代
- `isLatestVersion`: 是否当前可见版本

### 4.2 查询接口语义

保留现有：

- `agent:get-messages`

并扩展语义为：

- 默认仅返回当前可见版本链

新增建议接口：

- `agent:get-message-versions`
  - 输入：`sessionId`, `versionGroupId`
  - 输出：同组全部版本，按时间顺序排列

可选增强：

- `agent:get-visible-messages`
- `agent:get-message-version-group`

首期可不强制拆新接口，只要现有消息列表返回当前版本，且单独能查询版本组即可。

## 5. Sidecar 持久化改造

### 5.1 现有问题

当前 truncate 直接删除消息，不保留历史版本。

### 5.2 新语义

将“删除后续消息”改成：

- 保留旧消息原记录
- 将被替代消息标记为非最新版本
- 新写入消息指向旧消息，形成版本链
- 重新计算当前可见链

### 5.3 持久化策略

基于 MVP 阶段的文件存储，建议：

- 保持 JSONL 为主存储
- 为每条消息增加版本字段
- 会话索引或读取层负责“筛出当前可见版本”

如需额外索引，可增加轻量索引文件，但不应破坏现有读取链路。

### 5.4 兼容原则

- 旧消息默认视为单版本消息
- 没有版本字段时，读取层回填：
  - `versionGroupId = message.id`
  - `versionIndex = 1`
  - `versionCount = 1`
  - `isLatestVersion = true`

## 6. 发送与重发流程

### 6.1 首次发送

- user message 创建新的 `versionGroupId`
- assistant 回复创建独立的 assistant `versionGroupId`

### 6.2 用户重发

- 不再物理删除旧 user/assistant 消息
- 新 user message 继承旧 user message 的 `versionGroupId`
- 新 assistant 回复继承旧 assistant 组或建立同轮关联组
- 旧版本标记 `isLatestVersion = false`

### 6.3 编辑后重发

与重发一致，但新 user message 的 content 为编辑后的内容。

### 6.4 assistant 流式完成

- streaming 阶段仍由前端本地状态驱动
- 完成后将最终 assistant 消息落为该版本组的新版本
- 将工具活动快照、thinking duration 等绑定到该版本
- 避免因为全量 reload 导致消息抖动

## 7. 查询与组装

### 7.1 默认消息列表

`getAgentSessionMessages(sessionId)` 返回：

- 每个版本组仅一条当前可见版本
- 顺序与当前主会话时间线一致

### 7.2 版本组查询

`getMessageVersions(sessionId, versionGroupId)` 返回：

- 当前组全部版本
- 顺序为旧 -> 新

这样前端可以直接渲染：

- 左箭头 / 右箭头
- `n/m`
- 当前查看的是第几个版本

## 8. Web 状态层设计

### 8.1 状态模型

在 web 侧引入版本组视图模型：

- `visibleMessages`: 当前主时间线
- `messageVersionsByGroup`: 版本组缓存
- `selectedVersionIndexByGroup`: 当前 UI 正在查看的版本索引

### 8.2 原地替换原则

避免在以下场景整表刷新：

- assistant 流式完成
- 仅有一条消息版本切换

优先做：

- 局部替换当前消息版本
- 缓存版本组
- 保持消息列表布局稳定

### 8.3 fallback

以下情况才允许整表 reload：

- 丢失最终 assistant message
- 本地状态与落盘状态校验不一致
- watchdog 检测到事件链缺失

## 9. UI 设计

### 9.1 版本导航条

在消息头部或消息底部增加版本导航条，样式参考目标图：

- 复制按钮
- 重做/恢复按钮（按最终交互需要）
- 上一版
- `n/m`
- 下一版
- 更多菜单

### 9.2 展示规则

- `versionCount <= 1` 时不显示版本条
- 有多个版本时显示导航
- 切换版本只影响当前消息组，不影响整条会话滚动位置

### 9.3 适用对象

首期建议：

- user message 支持版本切换
- assistant message 支持版本切换
- 两者作为独立消息组处理

## 10. 流式与版本组结合

需要重点处理：

- streaming user temp message -> 最终 user message 的替换
- streaming assistant preview -> 最终 assistant version 的提交
- toolActivities / thinkingDuration / message metadata 绑定到正确版本

目标：

- 流式完成后不丢版本信息
- 不因完成时 reload 整表而抖动
- 工具卡片时间、状态、版本信息一致

## 11. 测试计划

### 11.1 Shared / Contract

- `AgentMessage` 版本字段类型测试
- 兼容旧消息读取测试

### 11.2 Sidecar

- 首次发送创建单版本消息
- 重发后生成第二版本，不删除旧版本
- 编辑后重发生成新版本，并正确链接旧版本
- 查询当前可见版本列表正确
- 查询版本组列表正确

### 11.3 Web

- 版本组 UI 渲染正确
- `n/m` 切换正确
- 切换版本不触发整表抖动
- 流式完成后当前版本正确提交
- temp user message 不丢失

### 11.4 Smoke

- 首次发送 user -> assistant
- 用户重发
- 编辑后重发
- 刷新页面后仍可查看版本
- 流式完成后工具卡片/消息版本不重复

## 12. 分阶段执行顺序

### Phase 1：Contract 与持久化基础

1. 扩展 `AgentMessage` shared type
2. 改 sidecar message store，支持版本字段
3. 保留旧消息，不再物理删除

### Phase 2：查询接口与版本链

1. 改 `getAgentSessionMessages` 为仅返回当前可见版本
2. 新增 `getMessageVersions`
3. 补版本组读取测试

### Phase 3：Web 状态接入

1. 消息列表按版本组渲染
2. 加入版本缓存与当前索引状态
3. 流式完成改为原地提交

### Phase 4：UI 与交互

1. 增加版本导航条
2. 实现上一版/下一版切换
3. 对齐视觉样式与快捷操作

### Phase 5：回归与打磨

1. 验证首次发送/重发/编辑后重发
2. 验证刷新恢复
3. 验证无抖动、无重复消息、无丢失用户消息

## 13. 风险与注意事项

- 这是跨 shared / sidecar / web 的联动改造，不适合只改一个层
- 现有 truncate 语义会被重新定义，必须补迁移说明
- 版本组和当前可见链若设计不严谨，会引入重复消息或顺序错乱
- 流式完成的最终 assistant message 提交必须和版本组逻辑统一，否则会再次出现抖动和丢时间问题

## 14. Definition of Done

满足以下条件才算完成：

- Agent 消息重发/编辑后重发不再删除旧版本
- 消息列表默认只显示当前可见版本
- 单条消息可显示 `n/m` 并切换历史版本
- 刷新页面后版本历史仍存在
- 流式完成不靠整表 reload 才能得到正确最终消息
- 无明显 UI 抖动
- 无重复消息、无消息丢失
- 关键测试与 smoke 通过

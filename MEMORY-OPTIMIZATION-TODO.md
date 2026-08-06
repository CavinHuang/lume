# Lume 记忆优化 TODO

## PR2 主 Agent 写入

- [x] 让 `memory.remember` 暴露 `explicitCorrection`，并验证 Claim supersede 与 Activation 继承。
- [x] 将 Agent 的 `sourceMessageIds` 转换为持久化 `evidenceRefs`。
- [x] 变更反馈展示摘要、作用域、来源、查看条目和 revision-safe 撤销。
- [x] 移除 Agent/UI 对旧 `kind` 选择的公开暴露，仅保留兼容解析。

## PR3 后台提取

- [x] 保持受限记忆工具边界，同时支持完整的私有多轮提取 transcript。
- [x] 后台通知支持逐条查看记忆和证据来源。
- [x] 持久化提取任务重启恢复，失败只在成功或明确跳过后推进游标。

## PR4 召回

- [x] 删除 profile/voice 的固定预加载分支，统一使用 Claim、Facet、Activation 和 Query Plan。
- [x] 保留精确 Claim 优先、stale 降权、语义失败回退和 10%/1200 token 预算。

## PR5 整理与管理

- [x] 整理 Agent 支持最多 20 轮 manifest、近期证据、Capsule、Brief、Persona 读取。
- [x] 整理 Agent 通过 CommandService 完成版本合并、重复 supersede 和过期处理。
- [x] 自动 Job 重启后按幂等键恢复，手动 external ingest 保留重试。
- [ ] 管理 UI 展示所有后台 Job、阶段、扫描/处理/变更文件和完成详情。
- [x] 全部记忆补齐 source、facet、更新时间过滤；详情已有编辑、归档、版本链和 revision-safe 撤销，编辑提交按显式纠正创建新 Claim 版本。

## 后续高风险项

- [x] 将后台提取接入真正独立的 `SubagentCoordinator` 运行时。子线程使用隐藏 `sendAgentMessage`、独立 transcript 和 `memory.search/read` 白名单；模型不可用时保留 provider loop 作为兼容回退。

## 验收

- [x] 运行 memory-v2、runtime event、MemorySettings 和 sidecar 类型检查。
- [x] 提交并推送当前记忆优化 PR。

第二阶段验证记录：sidecar 类型检查通过；extraction/job/coordinator 相关测试 `40 pass`。

验证记录：sidecar/shared/web 类型检查通过；memory extraction、command service、retrieval、user-message-prefix、organizer、job、consolidation、runtime projection 相关测试通过。

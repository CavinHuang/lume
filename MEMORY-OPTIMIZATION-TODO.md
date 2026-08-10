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

- [x] 整理 Agent 支持最多 20 轮 manifest、近期证据、Capsule、Brief、关于我、原始对话和工具结果读取。
- [x] 整理 Agent 通过 CommandService 完成补充遗漏、版本替换、元数据更新、重复 supersede 和过期处理。
- [x] 自动 Job 重启后按幂等键恢复，手动 external ingest 保留重试。
- [x] 管理 UI 展示所有后台 Job、阶段、扫描/处理/变更文件、停止操作和完成详情。
- [x] 全部记忆补齐 source、facet、更新时间过滤；详情已有编辑、归档、版本链和 revision-safe 撤销，编辑提交按显式纠正创建新 Claim 版本。

## AutoDream 完整闭环

- [x] 自动门槛按 24 小时和 5 个不同私聊主线程统计，排除群聊、频道和 subagent。
- [x] 任务捕获带 run 顺序的证据上界；成功或无变更才推进，失败和取消保留游标，同毫秒 trailing run 不丢失。
- [x] 每轮限制 20 个线程、100 个 run，剩余证据自动追加 trailing job。
- [x] 自动与手动整理共用独立 SubagentCoordinator 运行时、作用域锁、取消、恢复、重试和结果契约；删除旧 provider-only 重复整理器。
- [x] Dream 只暴露记忆读取、私有证据读取和工作区 Read/Glob/Grep/ls；拒绝写入、Shell、网络、MCP、桌面控制和新建 Agent。
- [x] Assistant-only 证据不能创建记忆；单条明确用户表述或两个 run 的用户证据才可自动提交，弱证据进入待处理。
- [x] 明确纠正生成新版本；普通 Claim 冲突进入待处理；合并保留 Evidence、Facet、Activation、Pin，过期仅标记 suspected_stale。
- [x] Capsule、Workspace Brief、关于我和 MEMORY.md 返回真实变更文件；索引限制 200 行、25KB，并避免仅时间戳变化的重写。
- [x] 后台任务展示会话/证据数量、逐项前后快照、证据来源、查看记忆和 revision-safe 撤销。

## 后续高风险项

- [x] 将后台提取接入真正独立的 `SubagentCoordinator` 运行时。子线程使用隐藏 `sendAgentMessage`、独立 transcript 和 `memory.search/read` 白名单；模型不可用时保留 provider loop 作为兼容回退。
- [x] 后台提取独立运行时限制为最多 5 轮，整理 Agent 限制为最多 20 轮；取消信号在写入前阻止提交。
- [x] 自动提取和 AutoDream Job 在 sidecar 启动时按持久化 payload 与幂等键恢复，不再依赖先打开设置页。

## 验收

- [x] 运行 memory-v2、runtime event、MemorySettings 和 sidecar 类型检查。
- [x] 提交并推送当前记忆优化 PR。

第二阶段验证记录：sidecar 类型检查通过；extraction/job/coordinator 相关测试 `40 pass`。

验证记录：sidecar/shared/web 类型检查通过；memory extraction、command service、retrieval、user-message-prefix、organizer、job、consolidation、runtime projection 相关测试通过。

最终收尾验证：记忆相关定向测试、后台任务 UI 测试、受限工具解析和运行时轮数测试通过；同步最新 `origin/main` 后发现既有 `SubagentDefaultModelPanel.test.ts` 单测独立失败，与本次记忆改动无关。

AutoDream 闭环验证：shared 类型检查通过；sidecar/web 的记忆相关类型无错误（完整类型检查仍被 main 中缺失的 IM/Link 可选依赖阻塞）；Dream 证据、命令服务、游标、派生视图、持久 Job、SubagentCoordinator、任务 UI 和 RuntimeEvent 共 96 项定向测试通过。

# Bash 工具输出前台流式实施计划

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bash 执行期间 UI 实时增量显示输出尾部（仅前台阶段），并补齐 pi 对照出的两个缺口：行数维度 tail 截断 + 截断 footer、运行中 elapsed 计时。

**Architecture:** 复用 #285 live 直通通道与线程事件总线，零新基建。载荷语义取**快照**而非 delta（对齐 pi）：bash 每 ~150ms 发累积 tail 全量，下游幂等替换。web 侧以稳定 id 原地替换，事件数组每运行中 bash 恒占 1 条。

**Tech Stack:** bun workspace / bun:test / @lume/shared。

**Spec:** `docs/plans/2026-08-24-bash-output-streaming-design.md`（权威依据）

**参考实现:** `D:\workspace\projects\ai-projects\pi\packages\coding-agent\src\core\tools\bash.ts:338-407`（尾沿节流）、`output-accumulator.ts`（tail 截断语义）

## Global Constraints

- 分支 `feat/bash-output-streaming`（已建，基于 origin/main）；改动经 PR 合并，禁直推 main
- commit emoji 前缀 + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 类型校验用 `bun run typecheck`（rtk tsc 会吞错误，实测教训）；测试按文件跑（全目录 bun test 有本地卡死前科）
- 流式阶段=工具 call() 未返回期间；转后台后停流是 engine `toolCallActive` 门控的设计内行为（engine.ts:2261），**不要"修"它**

## 已知事实(执行者必读)

- bash chunk 产生点两处：direct 路径 `appendOutput`（bash.ts:463）/ durable 路径 `emitNewOutput`（bash.ts:720），现均走 `context.emitEvent`
- live 优先惯用法样板：promote() 心跳 `(context.emitLiveEvent ?? context.emitEvent)`（bash.ts:565/861）
- projector 分支挂点：`handleSystem`（packages/sdk/src/events/lifecycle-projector.ts:288，末尾 return []）
- web 双路消费：`apps/web/src/hooks/lifecycle-event-adapter.ts`（SdkLifecycleDetail→LumeRuntimeEvent 映射）+ `useGlobalAgentListeners.ts`（跳过清单，新类型需放行）
- web 事件态:`apps/web/src/hooks/runtime-event-state.ts`（orderedAppend/appendOrMergeRuntimeEvent）;投影:`apps/web/src/components/agent/runtime-event-message-projection.ts`（applyRuntimeEvent,upsertToolCallBlock 幂等模式）
- 工程红线：tool.output 为瞬态事件，persisted 投影（run-item-events.ts）**不加**此类
- boundedPreview 内含 redactSensitiveText——新截断 helper 必须同样先 redact 再截断

---

### Task 1: shared 协议与类型扩展

**Files:**
- Modify: `packages/shared/src/types/sdk-protocol.ts`（`SDKLocalCommandOutputMessage` + 可选 `tool_use_id: string`）
- Modify: shared lifecycle/runtime-event 类型定义文件（`SdkLifecycleDetail` 加 `ToolOutputDetail { type: 'tool.output'; toolCallId: string; chunk: string }`；`LumeRuntimeEvent` 加 `{ type: 'tool.output'; toolCallId: string; chunk: string }`）

**Interfaces:**
- Produces: Task 2/3/4/5 的类型地基；`chunk` 字段名沿用 MessageUpdateDetail.delta 家族之外的独立命名（快照非增量，避免误读）

- [ ] Step 1: 三处类型落地；不新增枚举档位以外字段（YAGNI）
- [ ] Step 2: `bun run typecheck` 绿
- [ ] Step 3: commit `✨ feat(shared): local_command_output 带 tool_use_id + tool.output 瞬态事件类型`

### Task 2: SDK bash 快照节流 + tail 截断透明度

**Files:**
- Modify: `packages/sdk/src/tools/bash.ts`
- Modify: 截断 helper 落点（bash.ts 内部或 `utils/`，与现有 boundedPreview 同居一处优先）
- Test: `packages/sdk/src/tools/bash.test.ts`

**Interfaces:**
- Produces:
  - `tailTruncate(text, {maxLines≈500, maxBytes≈现有量级})`: 行数或字节双维度保尾部 + `{ content, truncated, totalLines, shownLines }` 元信息（内部 redact 先行）
  - 流式节流器：dirty flag + 尾沿 timer ~150ms（pi scheduleOutputUpdate 同款）；finish 前 flush
  - footer 格式化：truncated 时 `[Showing last N lines of M. Full output: <outputFile>]`

- [ ] Step 1: 失败测试先行——节流窗口合并为单事件、事件带 `tool_use_id`、走 emitLiveEvent 优先、finish flush 残留、tail 截断双维度、footer 文本
- [ ] Step 2: 实现；direct/durable 两路 emit 点统一换 `(context.emitLiveEvent ?? context.emitEvent)` + 快照节流；终态 `formatShellResult`/preview 改 tail 语义 + footer
- [ ] Step 3: 既有断言同步（stdoutPreview 中段截断→tail 截断的文本差异）；`bun test packages/sdk/src/tools/bash.test.ts` 绿 + `bun run typecheck` 绿
- [ ] Step 4: commit `✨ feat(sdk): bash 输出流式快照(带 toolUseId)+行级 tail 截断与全量路径 footer`

### Task 3: lifecycle-projector 投影分支

**Files:**
- Modify: `packages/sdk/src/events/lifecycle-projector.ts`（handleSystem）
- Test: `packages/sdk/src/events/lifecycle-projector.test.ts`

**Interfaces:**
- Produces: subtype=`local_command_output` 且带 `tool_use_id` → `[emit('run','event',null,{type:'tool.output',toolCallId,chunk})]`；无 id 维持 `[]`（向后兼容旧消息）

- [ ] Step 1: 测试——有 id 投影、无 id 忽略、subagent 标记仍被入口拦截
- [ ] Step 2: 实现 + 绿 + typecheck
- [ ] Step 3: commit `✨ feat(sdk): projector 投影 local_command_output→tool.output 领域事件`

### Task 4: web 事件态 replace-by-id + 适配器接线

**Files:**
- Modify: `apps/web/src/hooks/lifecycle-event-adapter.ts`（tool.output 映射；id 固定 `` `${runId}:tool-output:${toolCallId}` ``）
- Modify: `apps/web/src/hooks/useGlobalAgentListeners.ts`（跳过清单放行 tool.output，若该清单机制覆盖此类型）
- Modify: `apps/web/src/hooks/runtime-event-state.ts`（同 id 已存在则原地替换，否则追加）
- Test: 对应测试文件

**Interfaces:**
- Produces: 运行中同一 bash 的连续快照在 events 数组恒占 1 条；不同 toolCallId 不互串；run 结束后迟到快照随常规 trim 自然淘汰（无需专门清理）

- [ ] Step 1: 测试——replace 幂等（连发两条同 id 数组长度不变且内容为后者）、跨 toolCallId 隔离、与其他事件交错后仍能命中替换（findIndex 非 tail-only）
- [ ] Step 2: 实现 + 绿 + typecheck
- [ ] Step 3: commit `✨ feat(web): tool.output 适配器接线+事件态按稳定 id 替换`

### Task 5: web 投影渲染 + elapsed 计时

**Files:**
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`（applyRuntimeEvent 加 tool.output 分支：running 卡 `streamedOutput = snapshot` 替换；找不到 running 卡忽略迟到快照；completed/failed 分支不带 streamedOutput 即自然清除）
- Modify: `RuntimeToolCallView` 类型所在文件（加可选 `streamedOutput?: string`）
- Modify: 工具卡渲染组件（streamedOutput 渲染 max-height + overflow-auto pre 块；运行中本地 setInterval 显示 `Elapsed N.Ns`，完成切换 durationMs）
- Test: `runtime-event-message-projection.test.ts` 及组件测试

**Interfaces:**
- Consumes: Task 4 的 tool.output 事件
- Produces: 运行中卡片实时增量显示；完成被 resultPreview 整体替换

- [ ] Step 1: 测试——running 卡快照替换、completed 后到达的 tool.output 不复活卡片、completed 覆盖清 streamedOutput
- [ ] Step 2: 实现（UI 排版遵循语义字号 token 规范）+ 绿 + typecheck
- [ ] Step 3: commit `✨ feat(web): 运行中 Bash 卡片流式输出展示+elapsed 计时`

### Task 6: 端到端验证与收尾

- [ ] Step 1: 全链路单测回归（sdk/shared/web 三包相关文件）+ `bun run typecheck`
- [ ] Step 2: 手动冒烟清单记录到 PR 描述：长输出命令（如 `bun run typecheck`）运行中卡片增量出现 tail、15s 转后台后停止追加、完成后整体替换为结果、截断 footer 含可读路径
- [ ] Step 3: push 分支开 PR（base main），CI 判定对比 main baseline（平台测试长期红为已知基线）

# Bash 工具输出前台流式设计

日期：2026-08-24
状态：已确认（用户逐节批准）

## 背景

Bash 工具执行期间，UI 要等工具调用整体结束才显示输出。根因是全链路缺口，不是 UI 不刷新：

1. `packages/sdk/src/tools/bash.ts` 的 chunk 事件（`local_command_output`）走 `context.emitEvent` **缓冲通道**（工具批次结束后才流出），且不带 `tool_use_id`
2. engine 已有直通通道 `emitLiveEvent`（#285），但 bash 未使用
3. `lifecycle-projector.handleSystem` 对 `local_command_output` 返回 `[]`，不进事件总线
4. web 端 `LumeRuntimeEvent` 无工具输出增量类型，工具卡只有 running → completed 两态

管道每一环的挂点均已存在（live 通道、总线 run/event 相位、投影 upsert 机制），无需新基建。

## 决策记录

| 决策点 | 结论 | 备选与否决理由 |
|---|---|---|
| 展示形态 | 仅增量追加 + 最大高度限制 | 尾部滚动预览/可展开终端被否 |
| 流式阶段 | 仅前台（≤15s 或快速完成）；转后台后自动停流 | 后台续流需放开 engine `toolCallActive` 门控，后续再迭代 |
| 通道 | 方案 A：复用 live 通道 + projector 投影进总线 | 旁路直推（违背 #285/#387 单源总线裁定）、前端轮询文件（跨进程/远程模式不可用）被否 |
| 载荷语义 | **快照**而非 delta（对齐 pi）：每次发累积输出的有界 tail 全量，下游幂等替换 | delta 需相邻合并+乱序处理，复杂且脆弱 |
| 截断透明度（pi 对照缺口 #2） | 纳入本次：行数+字节双维度 tail 截断 + 显式 footer | — |
| 运行中 elapsed 计时（pi 对照缺口 #3） | 纳入本次：web 卡片本地计时器 | — |

## 设计

### 1. 流式快照链路

```
bash stdout/stderr chunk
  → bash.ts: 尾沿节流 ~150ms，发「累积 tail 快照」（有界 ~16KB）
    事件带 tool_use_id，走 emitLiveEvent ?? emitEvent（promote() 心跳同惯用法）
  → lifecycle-projector.handleSystem: local_command_output → tool.output domain event
    (kind 'run' / phase 'event'，task_progress 同款)
  → 线程事件总线 publish（现有链路零改动）
  → web runtime-event-state: 稳定 id `${runId}:tool-output:${toolCallId}` 原地替换
    ——每个运行中 bash 在事件数组恒占 1 条，2000 上限零压力
  → projection: running 卡片 streamedOutput = snapshot 替换；completed 整体覆盖
```

### 2. 分层改动

| 层 | 文件 | 改动 |
|---|---|---|
| SDK | `packages/sdk/src/tools/bash.ts` | direct/durable 两路共用节流 helper；快照事件加 `tool_use_id`、改 live 优先；`finish()` 前 flush 残留 |
| 协议 | `packages/shared/src/types/sdk-protocol.ts` | `SDKLocalCommandOutputMessage` 加可选 `tool_use_id` |
| 投影 | `packages/sdk/src/events/lifecycle-projector.ts` | `handleSystem` 加分支：带 `tool_use_id` 的 → `ToolOutputDetail{ type:'tool.output', toolCallId, chunk }`；无 id 维持忽略（向后兼容） |
| 类型 | shared runtime events | 新增 transient 事件 `tool.output` |
| web state | `apps/web/src/hooks/runtime-event-state.ts` | 同 toolCallId 按 id 替换（replace-by-id） |
| web 投影 | `runtime-event-message-projection.ts` + 工具卡组件 | running 卡渲染 `streamedOutput`（max-height pre 块）；completed/failed upsert 已整体覆盖 |
| SDK | bash.ts 结果格式化 | 缺口 #2，见下 |

### 3. 截断透明度（缺口 #2）

- 新增 tail 截断 helper：行数上限（~500 行）或字符上限（UTF-16 code units，量级沿用现有预算）双维度保尾部，替换 `boundedPreview` 的字符中段截断语义；每流预算为最终结果预算的一半，使分流 footer 先于组装级预算触发
- 终态结果文本追加 footer（仅截断时）：`[Showing last N lines of M. Full output: <outputFile>]`
- 流式快照纯 tail 文本，不带 footer
- 影响面：`formatShellResult` / execution metadata preview 语义变化，既有测试断言同步更新

### 4. 运行中 elapsed 计时（缺口 #3）

web 工具卡本地 `setInterval`（1s）显示运行中耗时 `Elapsed N.Ns`；完成时切换到已有 `durationMs`。零协议改动。

### 5. 边界行为

- **转后台**：engine `toolCallActive=false` 自动关 live 通道，流自然停止（即"仅前台"决策），零代码
- **并发多命令**：按 `toolCallId` 分卡，天然隔离
- **安全**：chunk 沿用 `redactSensitiveText`
- **hydrate/replay**：persisted 源来自 run items 投影，不含 `tool.output`；历史回放不受影响。tool.output 为瞬态事件（与 task_progress 同类）

### 6. 测试

- `bash.test.ts`：尾沿节流合并、`tool_use_id` 附着、finish 前 flush、tail 截断 helper 双维度、footer 格式
- `lifecycle-projector.test.ts`：投影分支 + 无 id 忽略
- `runtime-event-state` 测试：replace-by-id 幂等
- projection 测试：running 快照替换、completed 覆盖清 streamedOutput

## Follow-ups（不在本次范围）

- 转后台后输出续流（需放开 live 通道生命周期门控）
- 其他工具（web-request 等）复用 tool.output 通道——架构上已免费支持，待有真实需求接入

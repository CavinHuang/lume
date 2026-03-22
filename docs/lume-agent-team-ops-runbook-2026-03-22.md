# Lume Agent Team 运维手册（2026-03-22）

## 1. 适用范围

本手册覆盖 Lume `Agent Team` 子任务编排链路（`sessions_spawn` + `subagents_*`）。

运行数据默认落盘路径：
- `~/.lume/agent/subagent-runs.json`

---

## 2. 如何查询 run 状态

### 2.1 在 Agent 内通过工具查询

1. 查询当前会话可控子任务：
```json
{"tool":"subagents_list","args":{"limit":50}}
```

2. 按状态过滤：
```json
{"tool":"subagents_list","args":{"status":"running","limit":100}}
```

3. 查询单个 run：
```json
{"tool":"subagents_list","args":{"runId":"<run-id>"}}
```

### 2.2 在前端/调试侧通过 IPC 查询

- IPC 方法：`agent:list-subagent-runs`
- 入参：
  - `ownerSessionId?`
  - `runId?`
  - `status?` (`accepted|running|completed|errored|aborted|timed_out|canceled`)
  - `limit?`（默认 50）
- 返回：
  - `count`
  - `runs`
  - `statusSummary`

Web 侧封装：`listSubagentRuns(input)`（`apps/web/lib/desktop-api.ts`）。

---

## 3. 如何控制子任务

### 3.1 停止子任务

```json
{"tool":"subagents_kill","args":{"runId":"<run-id>","cascade":true}}
```

- `cascade=true` 时会级联终止后代 run。
- 被终止 run 会进入 `canceled`，并写入 `errorCode=SUBAGENT_CANCELED`。

### 3.2 继续发指令

```json
{"tool":"subagents_send","args":{"runId":"<run-id>","message":"继续执行...","timeoutSeconds":60}}
```

### 3.3 重定向目标（steer）

```json
{"tool":"subagents_steer","args":{"runId":"<run-id>","message":"改为...","runTimeoutSeconds":0}}
```

- 旧 run 会被取消，新建 run 继续执行。

---

## 4. 日志排障

核心日志上下文：
- `subagent-run-registry`
- `subagent-announce`

关键字段（已统一）：
- `runId`
- `parentRunId`
- `rootSessionId`
- `sessionId`（父会话）
- `parentSessionId`
- `childSessionId`
- `deliverySessionId`
- `requestedAgentId`
- `resolvedAgentId`
- `status`
- `errorCode`

建议检索：
- 先按 `runId` 聚合链路；
- 再看 `event=run_status_changed/announce_*` 观察终态与回传是否成功。

---

## 5. 回滚开关与应急处理

### 5.1 总开关（推荐首选）

设置环境变量：
- `ENABLE_SUBAGENT_TEAM_V2=false`

效果：
- `sessions_spawn` 与 `subagents_*` 工具返回 `status=unavailable`，阻断新子任务链路。

### 5.2 限流降载

- `LUME_SUBAGENT_MAX_DEPTH`：限制最大深度（默认 3）
- `LUME_SUBAGENT_MAX_FANOUT`：限制父会话并发扇出（默认 6）

### 5.3 事故处置建议顺序

1. 先关闭 `ENABLE_SUBAGENT_TEAM_V2` 防止新增扩散。
2. 用 `agent:list-subagent-runs` 导出当前 `running` run。
3. 对异常链路执行 `subagents_kill`（必要时 `cascade=true`）。
4. 检查日志中对应 `runId` 的 `announce_*` 与 `run_status_changed`。
5. 恢复后逐步放开（先小 fanout，再恢复默认）。

---

## 6. 已知限制与后续演进

已知限制：
1. 当前 `thread binding` 为 sidecar 抽象层，尚未接入外部渠道原生线程资源。
2. Team 面板暂未接入 inbox 轮询与 teammate 全量 telemetry。
3. `subagent-runs.json` 为文件存储模型，超高并发场景后续需评估 SQLite 迁移。

后续演进建议：
1. 增加 Team inbox 聚合读模型（跨会话任务通知）。
2. 增加 teammate 维度运行指标（latency/token/cost）并接入面板。
3. 增加 run 级别审计导出能力（按时间窗口导出 JSON）。

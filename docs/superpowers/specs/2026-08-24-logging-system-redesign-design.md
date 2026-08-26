# Lume 日志系统重设计 — 设计规格

- 日期：2026-08-24
- 状态：已经用户批准设计方向
- 分支：`feat/logging-system-redesign`（单一专题 PR）

## 1. 背景与问题

现有自研日志系统骨架完整（schema v2、关联 ID、批量传输 + 背压、NDJSON 按天轮转、脱敏截断、应用内查看器），但相对目标「**dev 控制台 + 正常运行日志中都能看到关键动作的参数、结果、过程**」存在缺口：

| # | 缺口 | 现状锚点 |
|---|------|---------|
| G1 | dev 终端默认只放行 warn+ 与约 10 条白名单 info，trace spine / rpc 往返默认不可见 | `logging-service.ts` writeTerminal 过滤；TERMINAL_INFO_EVENTS |
| G2 | IPC/RPC 只记「发生了」，不记参数与结果 | `rpc.completed` 仅 method + durationMs；`dispatchCommand` 无统一埋点 |
| G3 | renderer 约 214 处 console.error/warn 与统一体系脱节，Release 下永久丢失 | 仅 7 处显式 writeWebLog |
| G4 | desktop-host / node-repl source 已定义但无生产者，Rust 宿主只有 eprintln 文本 | `desktop-host-supervisor.ts` 当纯文本处理 |
| G5 | store/settings/窗口等正常路径只在失败时有日志 | — |
| G6 | quiet 名单、敏感键清单在 main/sidecar 双端各自维护，规则漂移 | main.ts:192 / sidecar index.ts:128 等 |
| G7 | 无日志约定文档 | — |

## 2. 已确认的决策

1. **dev 默认 trace**：非打包运行时 consoleLevel 默认 `trace`，生产保持 `info`；env 覆盖能力不变。
2. **截断预览**：内容类字段不再整体 `[redacted]`，改为 ≤200 字符截断预览；凭据类字段仍完全脱敏。全文诊断继续走既有加密 diagnostic-content-store。
3. **范围全量补齐**：G1–G7 全部在本 PR 完成。

## 3. 方案取舍记录

- **埋点方式 = 边界集中包装**（而非 48+ 调用点逐点埋点）：主进程在 `dispatchCommand` 进出口一处包装统一记录；个别需要领域细节的命令再补显式事件。
- **Rust 宿主 = `LUMELOG ` 前缀 JSON 行协议**（而非引入 log/tracing）：零新依赖（serde_json 两 crate 已有）；显式前缀避免 REPL 用户代码打印 JSON 造成误判。

## 4. 分项设计

### 4.1 dev 可见性（G1）

- `LoggingService` 构造时以 `!app.isPackaged` 判定 dev，consoleLevel 缺省值取 `'trace'`（生产仍 `'info'`）。`LUME_LOG_CONSOLE_LEVEL` env 覆盖优先级不变。
- sidecar spawn env 显式转发主进程生效的 fileLevel（当前未转发）；dev 下转发 `'trace'`——sidecar 源头门槛只影响传输量，落盘仍由主进程 fileLevel 把关。

### 4.2 脱敏拆分与摘要工具（G6 前半）

- SENSITIVE_KEYS 拆为两组常量（进 shared）：
  - `REDACT_KEYS`：token/password/apikey/authorization/secret 等凭据键 → 一律 `[redacted]`（行为不变）。
  - `CONTENT_PREVIEW_KEYS`：body/prompt/content/message/text 等内容键 → 截断为 ≤200 字符预览串。
- **行为变化声明**：此前日志中这些内容字段为 `[redacted]`，此后带前 ~200 字符预览（文件与控制台一致）。凭据永不出现。
- shared 新增 `summarizeArgs(payload)` / `summarizeResult(result)`：
  - 先按 REDACT 处理凭据键；
  - 字符串 >200 截断并附原长标注；对象/数组 → 浅层骨架（type/keys/length）+ JSON 切片预览；
  - 复用现有深度/键数/字符串上限规整化。
- 预览长度 200 为 shared 常量，单一来源。

### 4.3 IPC/RPC 参数结果埋点（G2）

- 主进程：包装 `lume:invoke` 的 `dispatchCommand` 调用，记 debug 级事件 `desktop.ipc/command.completed`（含 command、argsSummary、resultSummary、durationMs）与 `command.failed`（含错误 name/message/stack 摘要）。quiet 名单排除高频命令（healthcheck/list 类）——失败始终记录。
- 其余独立 `ipcMain.handle` 注册用同一小 wrapper 统一补齐。
- sidecar：扩展现有 rpc.completed/rpc.failed 记录点，补充 params/result 摘要（复用同一 summarize 工具）。

### 4.4 renderer console 桥接（G3）

- `apps/web/src/main.tsx` 最早处拦截 console.error / console.warn → `writeWebLogEvent(context:'console')`，带 message + stack。
- 限流 ~30 条/分钟固定窗口，溢出丢弃并在窗口结束时汇总一条 dropped 计数事件；writeWebLog 自身 fire-and-forget 不经 console，无回环。
- 存量 214 处调用零改动即被观测。

### 4.5 store / 生命周期埋点（G5）

- 规则一句话：**状态变更动作 = info，读取/高频操作 = debug**。
- info 级事件同样附带 summarize 参数/结果摘要——生产日志文件（fileLevel=info）对「关键动作的参数与结果」的可见性由本项承载；4.3 的全量 IPC 往返（debug）面向 dev 排查。
- 覆盖 workspace、submission、settings、窗口/托盘生命周期等约 10–20 个显式事件点；精确清单在实现计划阶段枚举定稿。

### 4.6 Rust 宿主 LUMELOG 协议（G4）

- Rust 侧输出单行到 stderr：`LUMELOG {"level":"info","context":"...","event":"...","message":"...","data":{...}}`（serde_json 序列化，替换现有 eprintln）。
- `desktop-host-supervisor.ts` 收到行输出时：`LUMELOG ` 前缀 → 解析为正式结构化事件（source 由宿主归属决定 desktop-host / node-repl，沿用既有 schema 校验与查看器支持）；解析失败或无前缀 → 回退现有 raw_output 文本路径。

### 4.7 常量收敛（G6 后半）

- 双端两份 quiet RPC 名单 diff 核对后合并为一份（语义取并集，失败路径不受 quiet 影响）；
- REDACT/PREVIEW 键清单、preview 长度、quiet 名单全部收敛至 packages/shared 单一模块，双端引用。

### 4.8 约定文档（G7）

- 新增中文文档 `docs/logging.md`：schema 速览、context/event 命名规则、级别使用规则（含 4.5 规则）、脱敏与预览规则、quiet 名单政策、新增埋点步骤、dev 下如何看日志（默认行为 + env 覆盖表）。

## 5. 测试与验证

- 单测（最小必要）：
  - redact/preview 拆分与 summarizeArgs/Result 截断（shared）
  - dispatchCommand 包装的 completed/failed 事件与 quiet 排除（desktop）
  - console 桥接限流与防回环（web）
  - supervisor 对 LUMELOG 行解析与回退（desktop）
  - Rust 侧行格式化函数单测（cargo test）
- 手动验收清单：`bun run dev` 启动后，dev 终端默认可见 agent 全链路 trace spine、IPC/RPC 往返参数结果摘要、console.error 上报；LogSettings 查看器过滤/实时订阅正常；生产配置（打包判定 false 分支模拟）行为不回归。
- 提 PR 前：`bun run verify:pr`（typecheck + test:core + smoke）全绿。

## 6. 流程约定

1. worktree 分支开发（已建：`feat/logging-system-redesign`），spec 与实现同属一个专题 PR。
2. 实现完成后派 code-reviewer subagent 对照本规格 review 分支 diff，按结果修复并复审，循环直至无发现。
3. 经 PR review 合并回 main，禁止本地直接 merge。

## 7. 非目标

- 不改传输层/轮转/加密存储架构，不引入第三方日志库。
- Rust crate 不引入 log/tracing 框架。
- renderer 业务代码逐点改造埋点不在本期（console 桥接兜底，关键路径由 4.3/4.5 覆盖）。

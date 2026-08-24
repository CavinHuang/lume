# Lume 日志系统指南

本文档是 Lume 日志系统的约定与使用指南。架构规格见 `docs/superpowers/specs/2026-08-24-logging-system-redesign-design.md`。

## 1. 总览（数据流）

```
产生者                                   处理（LoggingService，主进程）            输出
─────────────────────────────────       ───────────────────────────────    ─────────────────────────
main     writeMainLog / emit      ──▶   accept(): 校验/去重/脱敏/截断  ──▶  ① dev stderr 控制台
sidecar  createLogger/writeLogRecord    规整化(深度6·键30/100·8K字符)        ② ~/.lume/logs/
         ── 批量 RPC system.log-batch ─▶                                     lume-YYYY-MM-DD.ndjson(.N)
renderer writeWebLogEvent                                                    ③ 应用内查看器
         ── 批量 IPC write_web_log_batch ─▶                                  (设置 → 日志)
Rust 宿主 eprintln!("LUMELOG {json}")
         ── supervisor/manager 行解析 ─▶
```

关键代码位置：
- schema 与共享规则：`packages/shared/src/types/logging.ts`、`packages/shared/src/logging/index.ts`
- 主进程枢纽：`apps/desktop/src/logging/logging-service.ts`
- sidecar logger：`apps/sidecar/src/services/infra/logger.ts`
- renderer logger：`apps/web/src/lib/desktop-api/logger.ts`；console 桥接：`apps/web/src/lib/console-bridge.ts`
- Rust 协议：`crates/lume-desktop-host/src/logging.rs`、`crates/lume-node-repl-host/src/logging.rs`

## 2. Schema v2 速览

- 级别 6 档：`trace < debug < info < warn < error < fatal`
- 来源 5 种：`main | sidecar | renderer | desktop-host | node-repl`
- kind：`log`（普通）/ `trace`（链路 spine，无视文件级别一律落盘且不被队列丢弃）
- 关联 ID（可选）：traceId / spanId / runId / threadId / messageId / submissionId / rpcRequestId / toolCallId 等
- 常用字段：`durationMs`、`status(started|ok|error|cancelled|unknown)`、`data`、`error{name,message,stack,…}`

## 3. 命名规则

- context 用「域.子域」：`desktop.ipc`、`rpc.server`、`browser.workspace`、`logging.config`、`agent.run`。
- event 用点分短语（名词.动词过去式/状态）：`command.completed`、`command.failed`、`tab_closed`、`settings_updated`。

## 4. 级别使用规则

| 场景 | 级别 |
|---|---|
| 状态变更的关键动作（workspace 变更、日志设置热更、宿主启停） | `info` —— 生产日志文件的可见性由它承载 |
| 读取/高频操作、全量 IPC/RPC 往返（参数结果摘要） | `debug` —— 面向 dev 排查 |
| 可恢复异常、降级、重试 | `warn` |
| 操作失败（附 error 字段） | `error` |
| 链路 spine（message.accepted / agent.run.* 等） | 任意级别 + `kind:'trace'` |

quiet 名单（`QUIET_RPC_METHODS`，shared 单一来源）只豁免**成功路径**的 debug 记录；失败永远记录。新增高频命令时把方法名加进该集合即可。

## 5. 脱敏与预览

键分类在 `packages/shared/src/logging/index.ts` 的 `classifyLogKey`，三端 normalizer 与 `summarizeValue` 共用：

- **REDACT_KEY_PARTS**（子串命中，归一化后包含即命中）：token / secret / password / apikey / authorization / cookie / setcookie / accesstoken / refreshtoken / grant → 一律 `[redacted]`，永不落盘。
- **CONTENT_PREVIEW_KEYS**（归一化后精确命中）：body / prompt / content / message 类载荷键 → 截断为前 200 字符预览（`clipLogPreview`，超长标注 `…(+N)`）。
- 其余键照常记录（字符串 >200 同样截预览；对象限深 2、键数 30；TypedArray 输出 `{type, byteLength}` 骨架）。

新键名归类：凭据类放进 REDACT_KEY_PARTS 或确认子串已覆盖；正文类确认精确名进 CONTENT_PREVIEW_KEYS。全文诊断走加密 diagnostic-content-store，不走普通日志。

## 6. 新增一个埋点的步骤

1. 选 context/event（按 §3）。
2. 选级别（按 §4：状态变更 info，高频 debug）。
3. data 用 `summarizeValue(payload)` 或显式挑选的字段；自查敏感键（§5）。
4. 主进程：`writeMainLog(level, context, event, message, { data })`；sidecar：`writeLogRecord(...)`；renderer：`writeWebLogEvent(...)`；Rust 宿主：`emit_log(...)`（见 §7）。
5. 若是高频命令，评估加入 `QUIET_RPC_METHODS` / `QUIET_IPC_COMMANDS`。

注意：主进程经 `lume:invoke` 分发的命令已由 `logIpcCommand` 自动记录 completed/failed，**无需重复埋点**；只有需要领域细节（如关联 ID）时才补显式事件。

## 7. Rust 宿主协议

宿主向 stderr 输出单行：

```
LUMELOG {"level":"warn","context":"host.pipe","event":"client.disconnected","message":"..."}
```

- desktop-host 的输出由 `apps/desktop/src/desktop-host-supervisor.ts` 行缓冲解析 → 结构化事件（source=`desktop-host`）；node-repl 的输出由 `node-repl-runtime-manager.ts` 解析（批协议限制下 source 保持 `sidecar`，用 context `node-repl.host` 过滤）。
- 无前缀或解析失败的行回退纯文本路径（`[desktop-host] ...` / `.stderr` 诊断缓冲）。
- level 允许 trace..fatal；`fatal` 在两侧都映射为 `error`。

## 8. dev 怎么看日志

dev 构建（非打包运行）控制台默认 **trace**——启动 `bun run dev` 即可在终端看到全量关键动作流（含 agent spine、IPC/RPC 往返）。持久化设置等于默认值视为「未自定义」，同样放行 dev trace；显式改过级别则以用户为准。

环境变量覆盖（优先级高于一切默认值）：

| 变量 | 作用 |
|---|---|
| `LUME_LOG_CONSOLE_LEVEL=debug\|info\|…` | 收紧/放开终端可见级别 |
| `LUME_LOG_FILE_LEVEL=debug` | 放开落盘级别 |
| `LUME_LOG_FORMAT=json` | 终端整行 JSON |
| `LUME_LOG_CONSOLE=false` | 关闭终端输出 |

生产排查：应用内 设置 → 日志（过滤级别/来源/关键字/traceId、实时订阅、导出），或直接看 `~/.lume/logs/lume-*.ndjson`（按天轮转，保留 14 天 / 总量 500MB 上限）。

已知预期行为：renderer 的 console.error/warn 经桥接进入统一日志（限流 30 条/分钟，溢出汇总为 `console.dropped`），与全局错误 toast 对同一失败可能各出一条事件——context 不同、信息互补，属预期。

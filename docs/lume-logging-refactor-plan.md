# Lume 日志系统重构实现方案

## 1. 背景与问题

当前 Lume 的日志系统存在几个核心问题：

1. `desktop` 和 `sidecar` 各自维护日志逻辑。
2. `sidecar` 使用 TS / pino / console / stderr 等多套输出方式。
3. `desktop` 使用 Rust 侧日志系统，并且会二次包装 `sidecar stderr`。
4. 日志等级不统一，`debug / info / warn / error` 的语义不稳定。
5. 日志格式不统一，导致 Log Viewer 只能做文本解析。
6. 开发者排查问题时，无法快速按 `source / context / requestId / runId / toolName` 定位。

之前考虑过维护一套 `LogEvent` 协议，但这会引入 TS 和 Rust 双端协议同步成本。

最终建议采用：

> 抽出一个统一的 Rust 日志 crate，作为 Lume 唯一日志实现；desktop 直接调用，sidecar 通过 napi 调用，webview 通过 desktop command 调用。

---

## 2. 目标

### 2.1 架构目标

- 只有一套日志实现。
- 只有一套日志等级。
- 只有一套日志配置。
- 只有一套落盘格式。
- `desktop / sidecar / webview` 都只是不同日志来源，不再各自维护日志系统。
- `sidecar stderr` 只作为兜底，不再作为主日志通道。
- Log Viewer 基于结构化日志读取，不再猜文本格式。

### 2.2 开发体验目标

开发者可以快速回答这些问题：

- 刚才 Agent 为什么失败？
- 某个工具到底有没有被调用？
- sidecar 是不是启动失败？
- desktop 到 sidecar 的 RPC 是否超时？
- 某个 thread / run / tool 的完整日志在哪里？
- 某个错误发生前后的上下文是什么？

---

## 3. 总体架构

```text
crates/lume-logger
  ├─ 统一日志核心实现
  ├─ 统一日志等级
  ├─ 统一日志格式
  ├─ 统一日志脱敏
  ├─ 统一日志轮转
  ├─ 统一日志读取
  └─ 统一日志导出

apps/desktop/src-tauri
  └─ 直接依赖 lume-logger

packages/native-logger
  └─ napi wrapper
      └─ 依赖 crates/lume-logger

apps/sidecar
  └─ 通过 @lume/native-logger 写日志

apps/web
  └─ 通过 tauri command 写日志
```

最终运行链路：

```text
desktop Rust  ───────────────┐
                             │
sidecar TS ── napi ──────────┼── lume-logger ── logs/lume-2026-06-09.ndjson
                             │
webview TS ── tauri command ─┘
```

---

## 4. 新增模块设计

### 4.1 新增 Rust crate

新增目录：

```text
crates/lume-logger
```

职责：

1. 初始化日志配置。
2. 创建 logger。
3. 写入结构化日志。
4. 统一脱敏。
5. 统一日志文件命名。
6. 统一日志轮转。
7. 提供日志读取 API。
8. 提供日志导出 API。

建议结构：

```text
crates/lume-logger
  ├─ Cargo.toml
  └─ src
      ├─ lib.rs
      ├─ config.rs
      ├─ level.rs
      ├─ logger.rs
      ├─ event.rs
      ├─ writer.rs
      ├─ redact.rs
      ├─ rotation.rs
      ├─ reader.rs
      └─ export.rs
```

---

## 5. 日志等级规范

统一使用以下等级：

```rust
pub enum LumeLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}
```

语义约定：

| Level | 使用场景 |
|---|---|
| `trace` | 极细粒度内部流程，默认不展示 |
| `debug` | 开发者排查信息，例如 RPC 成功、工具调用开始、状态切换 |
| `info` | 重要生命周期事件，例如 app 启动、sidecar 启动、模型切换 |
| `warn` | 可恢复异常，例如重试、超时、降级、权限拒绝 |
| `error` | 功能失败，例如工具执行失败、RPC 失败、文件读取失败 |
| `fatal` | 进程级不可恢复错误 |

关键约束：

```text
RPC 成功不应该是 info。
工具调用开始不应该是 info。
普通状态流转不应该是 info。
只有真正对开发者有阶段意义的事件才是 info。
```

---

## 6. 统一日志事件结构

虽然不把它作为跨语言协议维护，但 Rust 内部仍然需要结构化事件。

```rust
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct LumeLogEvent {
    pub ts: String,
    pub level: LumeLogLevel,
    pub source: LumeLogSource,
    pub context: String,
    pub message: String,

    pub request_id: Option<String>,
    pub method: Option<String>,

    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    pub workspace_id: Option<String>,

    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    pub mcp_server: Option<String>,

    pub status: Option<LumeLogStatus>,
    pub duration_ms: Option<u64>,

    pub data: Option<Value>,
    pub error: Option<LumeLogError>,
}

#[derive(Debug, Clone, Serialize)]
pub enum LumeLogSource {
    Desktop,
    Sidecar,
    Webview,
    SidecarRuntime,
}

#[derive(Debug, Clone, Serialize)]
pub enum LumeLogStatus {
    Started,
    Sent,
    Completed,
    Failed,
    Timeout,
    Cancelled,
    Blocked,
}

#[derive(Debug, Clone, Serialize)]
pub struct LumeLogError {
    pub name: Option<String>,
    pub message: String,
    pub stack: Option<String>,
    pub code: Option<String>,
}
```

落盘格式使用 NDJSON：

```json
{"ts":"2026-06-09T08:00:00.000Z","level":"info","source":"desktop","context":"app.boot","message":"desktop started"}
{"ts":"2026-06-09T08:00:00.231Z","level":"info","source":"sidecar","context":"sidecar.boot","message":"sidecar started"}
{"ts":"2026-06-09T08:00:01.120Z","level":"debug","source":"desktop","context":"sidecar.rpc","message":"sidecar request started","method":"agent.run","request_id":"42"}
{"ts":"2026-06-09T08:00:02.441Z","level":"warn","source":"sidecar","context":"agent.tool.call","message":"tool call failed","tool_name":"read_file","status":"failed"}
```

---

## 7. 统一日志配置

配置文件建议放在：

```text
~/.lume/logging.json
```

内容：

```json
{
  "level": "debug",
  "format": "jsonl",
  "file": true,
  "console": false,
  "retentionDays": 14,
  "maxFileSizeMB": 20,
  "redactKeys": [
    "token",
    "secret",
    "password",
    "apiKey",
    "authorization",
    "cookie"
  ]
}
```

Rust 配置结构：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LumeLoggerConfig {
    pub level: LumeLogLevel,
    pub format: LumeLogFormat,
    pub file: bool,
    pub console: bool,
    pub retention_days: u32,
    pub max_file_size_mb: u32,
    pub redact_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum LumeLogFormat {
    Jsonl,
}
```

约束：

```text
不再由 sidecar 单独读取 LUME_LOG_FILE。
不再由 sidecar 单独读取 LUME_LOG_CONSOLE。
不再由 sidecar 单独决定日志目录。
不再让 pino / console / stderr 共同参与主日志链路。
```

---

## 8. Rust logger API 设计

### 8.1 初始化

```rust
use lume_logger::{init_logger, LumeLoggerConfig};

fn main() {
    init_logger(LumeLoggerConfig {
        level: LumeLogLevel::Debug,
        format: LumeLogFormat::Jsonl,
        file: true,
        console: false,
        retention_days: 14,
        max_file_size_mb: 20,
        redact_keys: vec![
            "token".into(),
            "secret".into(),
            "password".into(),
            "apiKey".into(),
            "authorization".into(),
        ],
    })?;
}
```

### 8.2 创建 logger

```rust
let log = lume_logger::logger("desktop.sidecar.rpc");
```

### 8.3 写日志

```rust
log.debug("sidecar request started")
    .field("request_id", request_id)
    .field("method", method)
    .status("started")
    .emit();

log.warn("sidecar request timeout")
    .field("request_id", request_id)
    .field("method", method)
    .status("timeout")
    .duration_ms(duration_ms)
    .emit();

log.error("sidecar request failed")
    .field("request_id", request_id)
    .field("method", method)
    .error(&error)
    .status("failed")
    .emit();
```

---

## 9. desktop 改造方案

### 9.1 当前问题

desktop 现在大量使用：

```rust
info!("xxx");
warn!("xxx");
error!("xxx");
```

并且会把 sidecar stderr 包装成：

```rust
info!("[sidecar] {}", line);
```

这会导致 sidecar 的原始日志等级和结构化信息丢失。

### 9.2 改造目标

desktop 只使用 `lume-logger`。

示例：

```rust
let log = lume_logger::logger("desktop.sidecar.lifecycle");

log.info("sidecar spawned")
    .field("pid", pid)
    .emit();

log.warn("sidecar exited unexpectedly")
    .field("pid", pid)
    .field("code", code)
    .emit();
```

### 9.3 sidecar RPC 日志等级调整

将当前 RPC 日志规则调整为：

| 事件 | 旧等级 | 新等级 |
|---|---|---|
| RPC started | info | debug |
| RPC sent | info | trace / debug |
| RPC succeeded | info | debug |
| RPC timeout | warn | warn |
| RPC failed | warn | warn / error |
| sidecar exited | warn / error | warn / error |

示例：

```rust
let log = lume_logger::logger("desktop.sidecar.rpc");

log.debug("sidecar request started")
    .field("request_id", request_id)
    .field("method", method)
    .status("started")
    .emit();

log.debug("sidecar request completed")
    .field("request_id", request_id)
    .field("method", method)
    .status("completed")
    .duration_ms(duration_ms)
    .emit();

log.warn("sidecar request failed")
    .field("request_id", request_id)
    .field("method", method)
    .status("failed")
    .duration_ms(duration_ms)
    .error(&error)
    .emit();
```

---

## 10. sidecar 改造方案

### 10.1 新增 napi package

新增目录：

```text
packages/native-logger
```

建议结构：

```text
packages/native-logger
  ├─ package.json
  ├─ index.ts
  ├─ native
  │   ├─ Cargo.toml
  │   └─ src
  │       └─ lib.rs
  └─ npm
      ├─ darwin-arm64
      ├─ darwin-x64
      ├─ win32-x64-msvc
      └─ linux-x64-gnu
```

### 10.2 napi 暴露 API

```rust
use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn init_logger(config_dir: String) -> Result<()> {
    lume_logger::init_from_config_dir(config_dir)
        .map_err(|err| Error::from_reason(err.to_string()))
}

#[napi]
pub fn log_event(input: JsLogInput) -> Result<()> {
    lume_logger::emit_from_js(input)
        .map_err(|err| Error::from_reason(err.to_string()))
}

#[napi(object)]
pub struct JsLogInput {
    pub level: String,
    pub source: String,
    pub context: String,
    pub message: String,
    pub data: Option<String>,
}
```

### 10.3 TS logger wrapper

`apps/sidecar/src/services/infra/logger.ts` 保留现有调用体验，但内部不再用 pino。

```ts
import { logEvent } from "@lume/native-logger";

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface Logger {
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  fatal(message: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(context: string, baseData: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, message: string, data?: Record<string, unknown>) => {
    logEvent({
      level,
      source: "sidecar",
      context,
      message,
      data: JSON.stringify({
        ...baseData,
        ...data,
      }),
    });
  };

  return {
    trace: (message, data) => emit("trace", message, data),
    debug: (message, data) => emit("debug", message, data),
    info: (message, data) => emit("info", message, data),
    warn: (message, data) => emit("warn", message, data),
    error: (message, data) => emit("error", message, data),
    fatal: (message, data) => emit("fatal", message, data),
    child: (bindings) =>
      createLogger(context, {
        ...baseData,
        ...bindings,
      }),
  };
}
```

### 10.4 sidecar 删除内容

逐步删除 sidecar 内部日志实现：

```text
pino
pino-pretty
LUME_LOG_FILE
LUME_LOG_CONSOLE
shouldWriteLogFile
resolveLogsDir
getCurrentLogFileName
formatStructuredLogLine
createConsoleBackend
pino/file transport
```

sidecar 的 `console.log` patch 不再作为主日志方案。

---

## 11. webview 日志方案

webview 不直接调用 napi。

webview 通过 tauri command 调用 desktop：

```ts
import { invoke } from "@tauri-apps/api/core";

export function createWebLogger(context: string) {
  return {
    debug(message: string, data?: Record<string, unknown>) {
      return invoke("write_web_log", {
        level: "debug",
        context,
        message,
        data,
      });
    },
    info(message: string, data?: Record<string, unknown>) {
      return invoke("write_web_log", {
        level: "info",
        context,
        message,
        data,
      });
    },
    warn(message: string, data?: Record<string, unknown>) {
      return invoke("write_web_log", {
        level: "warn",
        context,
        message,
        data,
      });
    },
    error(message: string, data?: Record<string, unknown>) {
      return invoke("write_web_log", {
        level: "error",
        context,
        message,
        data,
      });
    },
  };
}
```

Rust command：

```rust
#[tauri::command]
pub async fn write_web_log(
    level: String,
    context: String,
    message: String,
    data: Option<serde_json::Value>,
) -> Result<(), String> {
    lume_logger::emit_web_log(level, context, message, data)
        .map_err(|err| err.to_string())
}
```

---

## 12. stderr 的定位

sidecar stderr 仍然保留，但只作为兜底，不再作为主日志通道。

stderr 用于：

```text
native logger 初始化失败
napi 加载失败
Bun runtime 错误
sidecar crash 前输出
第三方库直接写 stderr
```

desktop 读取 stderr 后，统一写成：

```rust
let log = lume_logger::logger("sidecar.runtime.stderr");

log.warn("sidecar stderr output")
    .field("line", line)
    .emit();
```

不再写：

```rust
info!("[sidecar] {}", line);
```

---

## 13. Log Viewer 改造方案

### 13.1 数据来源

Log Viewer 不再直接按文本读取文件，而是调用 `lume-logger` 提供的查询能力。

desktop command：

```rust
#[tauri::command]
pub async fn list_log_files() -> Result<Vec<LogFileMeta>, String> {
    lume_logger::list_log_files().map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn query_logs(query: LogQuery) -> Result<LogQueryResult, String> {
    lume_logger::query_logs(query).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn export_logs(query: LogQuery) -> Result<String, String> {
    lume_logger::export_logs(query).map_err(|err| err.to_string())
}
```

查询结构：

```rust
#[derive(Debug, Deserialize)]
pub struct LogQuery {
    pub file: Option<String>,
    pub levels: Option<Vec<LumeLogLevel>>,
    pub sources: Option<Vec<LumeLogSource>>,
    pub context: Option<String>,
    pub keyword: Option<String>,
    pub request_id: Option<String>,
    pub thread_id: Option<String>,
    pub run_id: Option<String>,
    pub tool_name: Option<String>,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}
```

### 13.2 UI 维度

Log Viewer 第一版需要支持：

```text
时间
等级
来源 source
上下文 context
关键词
requestId
threadId
runId
toolName
```

建议顶部快捷过滤：

```text
全部
只看错误
当前会话
当前 Agent Run
工具调用
MCP
Sidecar RPC
前端错误
```

日志条目展示：

```text
15:32:11.218  WARN  sidecar / agent.tool.call
tool call failed · tool=read_file · duration=812ms
```

展开后展示完整 JSON。

---

## 14. 日志文件设计

建议日志目录：

```text
~/.lume/logs
```

文件命名：

```text
lume-2026-06-09.ndjson
```

轮转策略：

```text
按天切分
超过 maxFileSizeMB 后追加序号
保留 retentionDays
```

示例：

```text
lume-2026-06-09.ndjson
lume-2026-06-09.1.ndjson
lume-2026-06-09.2.ndjson
lume-2026-06-10.ndjson
```

---

## 15. 脱敏规则

统一在 `lume-logger` 内部完成。

默认脱敏字段：

```text
token
secret
password
apiKey
authorization
cookie
set-cookie
accessToken
refreshToken
```

脱敏前：

```json
{
  "authorization": "Bearer abcdefg",
  "apiKey": "sk-xxx"
}
```

脱敏后：

```json
{
  "authorization": "[REDACTED]",
  "apiKey": "[REDACTED]"
}
```

脱敏必须发生在落盘前，而不是 Log Viewer 展示时。

---

## 16. 构建与发布

### 16.1 napi 构建

使用 `napi-rs` 生成平台包。

需要支持：

```text
darwin-arm64
darwin-x64
win32-x64-msvc
linux-x64-gnu
linux-arm64-gnu
```

package 结构建议：

```text
@lume/native-logger
@lume/native-logger-darwin-arm64
@lume/native-logger-darwin-x64
@lume/native-logger-win32-x64-msvc
@lume/native-logger-linux-x64-gnu
@lume/native-logger-linux-arm64-gnu
```

### 16.2 Bun 注意事项

sidecar 当前使用 Bun，因此需要验证：

```text
bun dev 下可以加载 .node
bun build --compile 后可以正确包含 .node
打包后的 sidecar 可以找到对应平台 native binary
```

如果 `bun build --compile` 对 `.node` 处理不稳定，兜底方案是：

```text
不要把 .node 嵌入 sidecar 单文件
将 native binary 放入 sidecar 资源目录
运行时按平台路径加载
```

---

## 17. 分阶段实施计划

### P0：先止血

目标：减少当前日志混乱和信息缺失。

任务：

1. 修复 desktop 初始启动 sidecar 时未读取 stderr 的问题。
2. sidecar stderr reader 不再统一包成 `info`。
3. 降低 desktop sidecar RPC 成功日志等级，从 `info` 改为 `debug`。
4. Log Viewer 默认过滤自身产生的日志读取请求。

结果：

```text
日志不再因为 Log Viewer 自己刷新而大量污染。
sidecar stderr 不再完全丢失。
RPC 成功日志不再挤占 info。
```

---

### P1：抽出 Rust 日志核心

目标：先让 desktop 使用统一日志核心。

任务：

1. 新增 `crates/lume-logger`。
2. 实现统一配置读取。
3. 实现统一日志等级。
4. 实现 NDJSON 写入。
5. 实现脱敏。
6. 实现基础读取 API。
7. desktop 接入 `lume-logger`。
8. 替换 desktop 中关键 `info! / warn! / error!`。

结果：

```text
desktop 日志先完成统一。
Log Viewer 可以先读取 lume-logger 的文件。
```

---

### P2：接入 sidecar napi logger

目标：sidecar 不再维护自己的日志系统。

任务：

1. 新增 `packages/native-logger`。
2. 使用 napi-rs 绑定 `crates/lume-logger`。
3. sidecar `logger.ts` 改成 thin wrapper。
4. 删除 pino/file 相关逻辑。
5. 删除 `LUME_LOG_FILE / LUME_LOG_CONSOLE`。
6. sidecar 所有 logger 调用保持原 API，减少业务代码改动。

结果：

```text
sidecar 和 desktop 使用同一个 native logger。
日志等级、格式、配置、脱敏全部统一。
```

---

### P3：接入 webview logger

目标：前端错误进入统一日志。

任务：

1. 新增 `write_web_log` tauri command。
2. 新增 web logger。
3. 捕获全局错误：
   - `window.onerror`
   - `unhandledrejection`
   - React error boundary
4. 关键 UI 操作写入 debug 日志。
5. Log Viewer 支持 source=`webview` 过滤。

结果：

```text
webview console 不再成为孤岛。
前端错误可以被诊断包导出。
```

---

### P4：重做 Log Viewer

目标：从文本查看器变成开发者诊断工具。

任务：

1. 支持 source 过滤。
2. 支持 context 过滤。
3. 支持 requestId / threadId / runId / toolName 过滤。
4. 支持错误快捷入口。
5. 支持当前 Agent Run 日志入口。
6. 支持复制单条 JSON。
7. 支持导出诊断包。

结果：

```text
开发者不再靠搜索大文本找问题，而是按诊断维度定位。
```

---

## 18. 关键文件改造清单

### 新增

```text
crates/lume-logger/Cargo.toml
crates/lume-logger/src/lib.rs
crates/lume-logger/src/config.rs
crates/lume-logger/src/level.rs
crates/lume-logger/src/event.rs
crates/lume-logger/src/logger.rs
crates/lume-logger/src/writer.rs
crates/lume-logger/src/redact.rs
crates/lume-logger/src/reader.rs
crates/lume-logger/src/export.rs

packages/native-logger/package.json
packages/native-logger/index.ts
packages/native-logger/native/Cargo.toml
packages/native-logger/native/src/lib.rs
```

### 修改

```text
apps/desktop/src-tauri/Cargo.toml
apps/desktop/src-tauri/src/main.rs
apps/desktop/src-tauri/src/sidecar.rs
apps/desktop/src-tauri/src/commands/logs.rs

apps/sidecar/package.json
apps/sidecar/src/services/infra/logger.ts
apps/sidecar/src/index.ts

packages/shared/src/types/logs.ts
apps/web/src/components/settings/LogSettings.tsx
```

### 删除或废弃

```text
sidecar 内部 pino/file 写入逻辑
sidecar 自定义日志文件名逻辑
sidecar 自定义日志目录逻辑
sidecar console patch 主链路
LUME_LOG_FILE
LUME_LOG_CONSOLE
```

---

## 19. 风险与规避

### 19.1 napi 增加构建复杂度

风险：

```text
不同平台需要不同 native binary。
Bun compile 后 native binary 加载可能有坑。
```

规避：

```text
先只支持开发平台验证。
再接入 CI 多平台构建。
native binary 不强制内嵌，可以随 sidecar 资源目录分发。
```

### 19.2 sidecar logger 初始化失败

风险：

```text
napi 加载失败时 sidecar 早期日志无法写入。
```

规避：

```text
sidecar logger.ts 保留 fallback stderr。
fallback stderr 只用于初始化失败。
desktop stderr reader 兜底收集。
```

### 19.3 日志过多影响性能

风险：

```text
debug / trace 过多可能影响性能。
```

规避：

```text
Rust logger 内部先做 level 判断。
低于当前等级的日志不序列化 data。
文件写入使用 buffered writer。
Log Viewer 使用分页/游标读取。
```

### 19.4 结构化字段滥用

风险：

```text
业务代码随意塞 data，导致日志难读。
```

规避：

```text
定义核心字段规范。
常用场景提供专用 helper。
例如 log_rpc_started / log_tool_failed / log_agent_run_started。
```

---

## 20. 推荐的日志上下文命名

统一使用点分命名。

```text
desktop.app.boot
desktop.sidecar.lifecycle
desktop.sidecar.rpc
desktop.window
desktop.settings

sidecar.boot
sidecar.agent.run
sidecar.agent.stream
sidecar.agent.tool
sidecar.mcp.server
sidecar.mcp.tool
sidecar.memory
sidecar.model.request
sidecar.workspace

webview.app
webview.settings
webview.chat
webview.log-viewer
webview.error-boundary
```

示例：

```rust
let log = lume_logger::logger("desktop.sidecar.rpc");
```

```ts
const log = createLogger("sidecar.agent.tool");
```

---

## 21. 最终效果

改造完成后，日志系统会从：

```text
desktop log
sidecar pino log
sidecar console log
sidecar stderr
webview console
Log Viewer 文本猜测
```

收敛为：

```text
lume-logger
  ├─ desktop source
  ├─ sidecar source
  └─ webview source
```

开发者看到的是统一的结构化日志：

```json
{"ts":"2026-06-09T08:00:00.000Z","level":"info","source":"desktop","context":"desktop.app.boot","message":"desktop started"}
{"ts":"2026-06-09T08:00:00.231Z","level":"info","source":"sidecar","context":"sidecar.boot","message":"sidecar started"}
{"ts":"2026-06-09T08:00:01.120Z","level":"debug","source":"desktop","context":"desktop.sidecar.rpc","message":"request started","method":"agent.run","request_id":"42"}
{"ts":"2026-06-09T08:00:02.441Z","level":"warn","source":"sidecar","context":"sidecar.agent.tool","message":"tool call failed","tool_name":"read_file","status":"failed"}
```

---

## 22. 结论

Lume 不应该继续维护 `desktop` 和 `sidecar` 两套日志系统，也不应该为了兼容两套系统再设计一层复杂协议。

最终方案应该是：

```text
Rust lume-logger 是唯一日志实现。
desktop 直接调用。
sidecar 通过 napi 调用。
webview 通过 tauri command 调用。
stderr 只做兜底。
Log Viewer 读取 lume-logger 的结构化日志。
```

这样能从根上解决：

```text
格式不统一
等级不统一
日志重复包装
sidecar/desktop 信息割裂
Log Viewer 只能文本搜索
开发者找不到关键信息
```

这套方案更符合 Lume 的桌面端架构，也更适合作为长期可维护的本地基础设施。

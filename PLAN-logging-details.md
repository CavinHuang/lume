# Detailed Plan Archive: 重构 Lume 统一日志与端到端 Agent 链路追踪
_Locked via grill — by Codex + user_

## Goal

把当前 Electron main、sidecar、renderer、desktop-host 与 node-repl 各自输出、重复包装和多点落盘的日志，收敛为由 Electron main 治理和写入的单一结构化事件管线；默认终端只展示关键生命周期与异常，后台轮询和成功 RPC 不再刷屏。同时让所有 Agent 入口生成可跨 renderer、Electron IPC、sidecar 队列、Agent runtime、provider、工具、子 Agent、持久化和最终交付端点的稳定 trace，使开发者能从日志或应用内 Trace 视图明确回答“一次请求到了哪里、使用了哪个 provider/model、经历了哪些步骤、回复是什么、是否真正送达”。

## Approach

1. **先锁定统一事件协议、相关 ID 与兼容边界。**
   - 在 `packages/shared` 定义版本化 `LumeLogEventV2`、批量传输类型、查询类型、日志配置类型与安全错误结构；写入格式仍为一行一个 JSON 的 NDJSON。旧 `ElectronLogEvent` 作为 v1 读取兼容类型，不再作为新写入协议。
   - 每条 v2 事件至少包含：`schemaVersion`、`eventId`、source 产生的 `emittedAt`、main 接收的 `observedAt`、main 分配的单调递增 `seq`、`kind=log|trace`、`level`、`source`、`context`、稳定点分事件名 `event`、简短 `message`、`status`、可选 `durationMs`、结构化 `data` 与统一 `error`。
   - 相关字段保持顶层可索引：`traceId`、`spanId`、`parentSpanId`、`parentTraceId`、`runId`、`threadId`、`messageId`、`submissionId`、`rpcRequestId`、`providerAttemptId`、`toolCallId`、`subagentRunId`、`origin`。ID 不是授权凭据；所有跨边界输入仍做格式和长度校验。
   - `traceId` 表示一次入口业务请求的完整链路；`runId` 表示一次 Agent 执行；provider fallback/retry 使用独立 `providerAttemptId`；工具调用沿用 `toolCallId`；跨进程阶段使用 `spanId/parentSpanId`。恢复或继续执行用 link 字段关联原 trace，不伪造为原 span 的同步延续。
   - source 统一为 `main`、`renderer`、`sidecar`、`desktop-host`、`node-repl`；context 使用点分层级，例如 `agent.dispatch`、`agent.runtime.provider`、`desktop.sidecar.lifecycle`。事件名使用稳定英文，例如 `message.submitted`、`rpc.completed`、`provider.request.completed`，人类说明可用中文。
   - 读取器继续兼容当前 v1 NDJSON、历史 pino JSON 和 plain text；不重写历史文件。所有新文件只写 v2。base URL 默认记录完整路径，但必须移除 userinfo、query、fragment，并脱敏疑似 credential 的动态路径段。

2. **在 Electron main 建立唯一日志写入器与双层安全策略。**
   - 在 `apps/desktop/src/logging/` 建立 main-owned logging service，负责协议校验、source allowlist、时间归一化、第二次递归脱敏、`observedAt/seq` 分配、sink 过滤、异步有界队列、终端格式化、NDJSON 写入、轮转、保留、查询、导出和 live subscription。
   - 使用 Node 标准库实现单写入队列，不增加依赖；删除 desktop 与 sidecar 对 `electron-log` 的日志写入依赖。文件按 `lume-YYYY-MM-DD.ndjson` 命名，20 MB 后使用 `.1/.2...` 分段；默认保留 14 天并设置 500 MB 全局上限，优先清理最旧分段。
   - main 启动时清理过期文件；写入器仅低频检查轮转和容量，不在每条事件扫描目录。正常写入异步且按 main `seq` 保序；source 自己的耗时使用单调时钟测量，跨进程展示以 main observed 顺序为准，同时保留 source 时间用于诊断时钟偏差。
   - 有界队列默认按约 50 ms 或 100 条批量落盘。队列过载依次丢弃普通 trace/debug 和非关键 info；用户业务 trace 的阶段完成事件以及 warn/error/fatal 不参与常规丢弃。发生丢弃时写聚合 `logging.events_dropped`，包含 source、等级、数量和时间范围。
   - logger 自身故障或极端溢出使用独立最小 emergency/crash 文件，避免递归调用主 logger；异常退出尽力同步 flush，但不承诺断电时最后一批绝对持久化。
   - 终端 formatter 输出单行 `time level context event ids fields`，只显示短 ID，禁止多层 `[desktop] [sidecar] [app]` 包装。默认终端显示关键 info、warn、error、fatal；trace 事件默认落盘但不自动全部打印到终端。
   - 所有 source 先按统一工具做第一次脱敏和安全摘要，main 写前再做一次。内建敏感 key 覆盖 token、secret、password、apiKey、authorization、cookie、set-cookie、access/refresh token；Error、BigInt、循环结构和超长值有确定性规范化。

3. **把各进程接入 main，而不是继续各自写文件。**
   - desktop main 的启动、sidecar host、窗口、更新、协议与 desktop-host supervisor 全部通过 main logger；`logDesktopStartup` 改成 logger context，预期 shutdown 的 `sidecar exited code=0` 记 debug，意外退出即使 code=0 也记 warn，崩溃/启动失败记 error/fatal。
   - sidecar `services/infra/logger.ts` 保留现有 `createLogger` 调用体验，内部改成薄 transport：本地 level/kind 判断、source 脱敏、批量队列、`system.log-batch` 单向通知。删除 sidecar 文件写入、`electron-log`、`formatStructuredLogLine` 主路径和当前全局 `console.*` monkey patch。
   - sidecar 在 host writer 尚未连接时使用有界启动 ring buffer；连接后按原事件时间回放。正常连接后不再与 main 同时写文件。`system.log-batch` 自身以及日志查看器内部控制事件不进入普通 RPC access log。
   - renderer `lib/logger.ts` 改成相同协议的批量 transport，经受 preload allowlist 约束的 main IPC 直接写入；加入 `window.error`、`unhandledrejection` 和现有 React error boundary 的统一捕获，不劫持普通 console。
   - desktop-host 在 stderr 使用明确前缀的单行 JSON 事件协议；`desktop-host-supervisor.ts` 按行解析并转交 main，无法解析的行才记 `raw_process_output`。不得污染 desktop-host 的业务 socket/stdout 协议。
   - node-repl host 只在 stderr 发结构化生命周期/异常事件，stdout 的 MCP/control JSON 协议保持纯净；sidecar 父层解析后批量转发。具体工具执行仍由 sidecar/SDK tool span 记录，Rust host 不重复 dump 工具正文。
   - main、sidecar、renderer、两个 Rust host 都保留只用于 logger 初始化失败和进程级 fatal 的 emergency stderr；普通第一方产品代码不再直接调用 console/eprintln。

4. **从入口创建 trace，并让排队、恢复和所有 Agent 入口保留它。**
   - 在 shared `AgentSendInput` 增加显式 `traceContext`（或等价判别类型），包含 `traceId`、`submissionId`、`origin` 与可选 parent/link。主窗口和快捷输入在调用 `agentSend` 前创建；sidecar 内的 IM、Automation/Routine、子 Agent 和其他内部入口在各自边界创建。
   - renderer 依次记录 `message.submit.started`、main 接收、sidecar RPC 接收、schema 校验、plan continuation/approval 分流、queue accepted 或 execution started。main 的 `sidecarHost.call` 为这次 RPC 分配 `rpcRequestId` 并测量耗时，但后台健康检查和列表读取只在失败、超时、慢调用或周期聚合时记录。
   - `AgentRuntimeKernel` 的 queued dispatch、持久化 guidance/continuation 与冷启动恢复数据必须保留 trace context；队列重排不换 trace，移除队列将 trace 结束为 cancelled，从队列晋升执行时沿用原 trace。
   - `sendAgentMessage` 在追加用户消息后把真实 `messageId` 绑定到 trace；记录安全预览、字符数和哈希，不记录原始附件正文。模型选择阶段记录 requested/effective modelRef、channel、provider、adapter、resolved model、选择来源和安全 base URL。
   - `LumeRunObserver.create` 接受上游 `traceId`，不再无条件创建割裂的新 trace；仍创建新的 `runId` 和 runtime root span。现有 Trace Store继续服务 run state/TracePanel，并由同一 TraceRecorder 在 span start/end 时发布统一 trace 事件，使 main 日志和 sidecar 投影共享 ID 与语义。
   - 子 Agent 使用独立 trace/run，通过 `parentTraceId/parentSpanId` 关联父工具 span；后台子 Agent 不阻止父 trace 到达自身完成状态。恢复、交互审批和 continuation 创建 linked trace/span，并保留 source run/trace 信息。
   - 所有 Agent 入口统一设置 `origin`：至少覆盖 `main_window`、`quick_input`、`im.<provider>`、`automation`、`routine`、`subagent`、`resume`。CLI/headless 若调用相同 sidecar runtime则携带同字段，但 CLI/构建脚本自身的工程日志不纳入 main 管线。

5. **在 Agent runtime 与 SDK 的真实边界记录流程，而不是从文本日志猜测。**
   - 把上下文组装、记忆检索、模型解析、runtime session 创建/恢复、provider attempt、工具权限、工具执行、compaction、subagent、session persist 与 run finalize 作为正式 span；复用当前 `TraceRecorder`、`LumeRunObserver`、RuntimeEvent 与 usage identity，不另建平行追踪器。
   - 给 SDK `QueryEngineConfig` 增加可选、无平台依赖的 observability callback；SDK 不依赖 desktop/sidecar logger。callback 在 provider 调用、首 chunk、完成、retry、fallback、工具开始/完成/失败时发规范化事件，由 sidecar adapter 绑定 trace context。
   - provider 请求记录 provider、adapter、requested/resolved model、完整安全 base URL path、attempt、HTTP status、provider request/response ID、首 token、总耗时、chunk 数、字符数、finish reason、usage、cache token、费用、限流与统一错误分类。
   - 扩展 provider response/stream 元数据为可选字段，让 OpenAI Responses、OpenAI-compatible、Anthropic、DeepSeek 等实现尽可能返回 request/response ID、status 和 headers 中安全的 rate-limit 信息；缺失字段保持 undefined，不伪造。
   - SDK 内部 retry 与 sidecar 模型 fallback 使用同一 provider-attempt 语义。每次尝试有独立 attempt ID；最终错误包含 retryable、分类、累计次数与下一 fallback model，不记录 API key 或原始 HTTP body。
   - 流式文本不逐 chunk 写日志。聚合记录 first-token latency、chunk count、文本/思考字符数与最终安全预览；RuntimeEvent 仍可逐 chunk 驱动 UI，但 logging transport 不复制该高频流。
   - 工具 trace 记录 tool name/call ID、来源（builtin/MCP/plugin/node-repl）、权限决定、状态、耗时和安全输入输出摘要。并行工具使用兄弟 span，串行 mutation 保留实际顺序；tool result 文件只记录受控路径、mime、size、hash。

6. **明确消息持久化、通知转发和前端交付的最后一段链路。**
   - sidecar 在创建用户版本、append SDK transcript、生成 assistant final、创建可见 assistant message version 和持久化 run state 后分别记录确定性 trace milestone；相同 `messageId/runId/traceId` 随 RuntimeEvent 与 `MESSAGE_APPENDED` 通知传递。
   - sidecar `writeNotification`、Electron main `onNotification` 和 renderer `onSidecarEvent` 只记录关键业务通知与异常，不记录每个流式 delta。main 在 `webContents.send` 后记录 `reply.forwarded`，并区分无可信窗口、窗口已销毁和正常发送。
   - renderer 全局 listener 收到最终 assistant event/message 后记录 `reply.received`；事件批量写入 Jotai 状态后记录 `reply.committed`，它是主窗口/快捷输入 trace 的正式端到端完成点。
   - 仅对最终消息在下一 animation frame 可选记录 `reply.rendered`；不对每个 delta 回执。未在超时窗口观察到 committed 时标记 `delivery_unknown`，不伪称失败或成功。
   - IM trace 以渠道 send ack/失败为完成点；Automation/Routine 以结果持久化为完成点；子 Agent 以自己的 run/announce 结果为完成点。各入口共用事件名和状态结构，但完成语义由 origin adapter 明确。

7. **实现默认安全预览与时间受限的加密正文诊断捕获。**
   - 默认消息字段只记录 message ID、角色、字符数、内容哈希和递归脱敏后最多 256 字符预览。附件和二进制只记录类型、尺寸、hash 与受控路径；普通日志不会成为第二份完整聊天 transcript。
   - 日志设置页可对指定 thread/trace 或限定时间开启“诊断内容捕获”，默认 1 小时、最长 24 小时；到期自动关闭。捕获只允许完整用户消息和 Agent 回复，以及 allowlist 工具的有上限安全结构。
   - 诊断模式仍禁止完整系统提示词和 provider 原始 HTTP request/response body；系统提示词只记录版本、section hash、长度和启用模块。文件正文、shell 大段输出、网页正文、截图/图片/音视频不复制进日志。
   - 完整正文使用 Electron `safeStorage` 在 main 内加密，写入独立受控文件；sidecar 和 renderer 不接触持久化密钥。系统安全存储不可用或 backend 不安全时拒绝开启，不降级为明文。
   - 日志页按需请求 main 解密单条记录；普通日志导出默认排除诊断正文。导出完整正文必须再次确认，产生受控临时明文包并清理由应用创建的临时文件。
   - 提供立即停止捕获、删除诊断正文、清空普通日志入口。所有数据只保存在本机；不增加远程上传、遥测或第三方 collector。

8. **把日志配置并入现有 settings，并由 main 热更新各 source。**
   - 扩展 shared `GeneralSettings` 的 logging section，至少包含 console level、file level、format、retention days、max segment MB、max total MB、diagnostic capture 状态/过期时间/作用域；defaults 使用已锁定的 info、14 天、20 MB、500 MB。
   - `settings.json` 继续是持久化来源，不新增 `logging.json`。sidecar 现有 settings store负责原子更新；renderer 更新成功后像 window behavior 一样调用受 preload allowlist 约束的 main sync command，使 writer 热更新并把只读 source policy推送给 sidecar/子进程。
   - level、终端格式和诊断捕获即时生效；轮转参数在下次分段边界生效。环境变量 `LUME_LOG_CONSOLE_LEVEL`、`LUME_LOG_FILE_LEVEL`、`LUME_LOG_FORMAT` 是 dev/CI 的最高优先级覆盖。
   - 当前 `LUME_LOG_CONSOLE`、`LUME_LOG_FILE`、`LUME_LOG_LEVEL` 保留一个版本的明确兼容映射，只写一次 deprecation 事件；新代码不继续传播这些变量，后续版本删除。
   - `kind=trace` 与普通 level 分开路由：用户业务 trace 默认完整落盘，普通 debug 默认不落盘；终端按 level/context allowlist 输出，因此不会为了保存 trace 而重新刷屏。

9. **把日志查看器从 sidecar 文件轮询改成 main-owned trace 诊断页。**
   - 将 list/read/query/open/export/delete/diagnostic-decrypt API 从 sidecar `log-viewer-service` 收口到 desktop logging service；renderer 经 preload allowlist 直连 main。sidecar 崩溃时日志页仍可打开、查询和导出。
   - 保留按时间的结构化事件流与原始 NDJSON 视图；查询支持 level、kind、source、context、event、status、traceId、threadId、runId、messageId、provider、model 与文本条件。
   - 点击事件打开 trace 时间线，按 parent span 展示发送、IPC、queue、runtime、provider、tool、subagent、persist、forward/received/committed；顶部展示总耗时、最终状态、provider/model、usage、费用、重试次数和失败阶段。
   - 日志页打开时由 main 批量推送新增事件；支持暂停、继续、自动滚动和只跟随当前 trace。页面关闭即取消订阅，不后台 tail。
   - 日志查看器自身事件标记 `internal=true` 并默认隐藏；查询和 live tail 不经 sidecar RPC，消除查看日志造成 `general-settings:*` 污染的反馈环。
   - 支持复制单条 JSON、复制 trace 摘要、只导出当前 trace。新/改交互控件复用 `apps/web/src/components/ui` 的 shadcn/global 原子组件，不手写完整控件视觉。

10. **按 cleanup plan 删除重复实现和直接 console，避免长期双轨。**
    - 先用现有 logger/trace/runtime 测试锁定已受保护的脱敏、日志读取、run trace、provider usage、tool/runtime event 和 desktop sidecar lifecycle 行为；新增链路不为了仪式感复制测试，只覆盖新可测试逻辑与高风险边界。
    - desktop 接入 main writer 后删除 `desktop-core.ts` 中重复 electron-log writer；sidecar 接入 batch transport 后删除 sidecar 自写文件、日志目录 cache 和 console patch；日志查看器迁到 main 后删除 sidecar reader/export handler 与仅服务它的 RPC。
    - 删除未接入当前 Electron 主链路、仍基于旧 Tauri/native-logger 设想的 `crates/lume-logger`；确认没有 workspace/build 引用后同步删除过时 `docs/lume-logging-refactor-plan.md`，以新的锁定计划作为架构记录。
    - 移除 desktop/sidecar 的 `electron-log` 依赖和 lockfile 残留，不增加新依赖。保留历史格式读取代码，但明确放入 legacy parser，禁止新 writer 继续产生旧格式。
    - 机械迁移 main、sidecar、renderer 第一方产品目录的全部直接 `console.*` 到上下文化 logger；Rust host 的普通 `eprintln!` 改为结构化 emitter。只为 bootstrap/emergency 保留极小 allowlist。
    - 增加轻量源码契约测试，禁止产品目录新增未允许的 console/eprintln、禁止多点日志文件 writer、禁止记录 authorization/cookie/raw provider body。构建脚本、测试脚本、benchmark 与 CLI 工程输出不受该契约限制。
    - 生成的 `apps/desktop/resources/sidecar/index.mjs` 只通过现有 bundle 脚本更新，不手工编辑。

11. **分阶段落地并保持每一步可回退。**
    - P0 去噪：先把 RPC success/healthcheck/list polling 降为 trace 或异常/慢调用记录，停止原样转发 sidecar stderr，正确区分预期 exit；验证开发终端立即清净。
    - P1 核心：shared v2 schema、main writer、轮转/保留/背压、sidecar/renderer batch transport、v1 reader；此阶段 main 已成为唯一文件 writer。
    - P2 Agent trace：入口 trace context、queue/continuation、RunObserver 复用 trace、SDK provider callback、tool/subagent spans、最终 reply delivery milestones。
    - P3 native 与隐私：desktop-host/node-repl structured stderr、诊断正文安全存储、配置热更新与旧 env 兼容。
    - P4 viewer 与清理：main query/live APIs、trace UI、导出/删除、全量 console 迁移、删除旧 logger/crate/docs/deps。
    - 每个阶段保持兼容 reader 和 emergency fallback，只有新链路验证后才删除旧 writer；禁止长期同时写同一日志文件。

12. **用定向验证证明可追踪、去噪、安全和失败语义。**
    - Shared/main writer：v2 校验、双层脱敏、base URL 全路径与 query/credential 清除、seq 保序、日期/尺寸轮转、14 天与 500 MB 清理、有界队列丢弃优先级、关键 trace 保留、dropped 聚合、v1/pino/plain 读取。
    - Desktop/transport：sidecar batch、启动 ring buffer 回放、malformed batch、日志通知不自记录、预期/意外 code=0、raw stderr fallback、renderer preload allowlist、live subscribe/unsubscribe、sidecar down 时查询可用。
    - Agent E2E contract：对主窗口模拟 `submit -> main RPC -> sidecar validate -> queue/run -> model resolution -> provider -> tool -> assistant persist -> notification -> forwarded -> received -> committed`，断言同一 traceId、正确 run/provider attempt/tool/message IDs 和单调阶段顺序；流式 1000 chunks 不产生 1000 条日志。
    - Queue/resume：queued message 保留 trace，重排不换 ID，删除为 cancelled，冷启动 continuation 链接原 trace，provider retry/fallback 使用独立 attempt ID，子 Agent 使用 linked trace。
    - 入口矩阵：quick input、IM、Automation/Routine、subagent、resume 均产生 origin 和正确完成点；IM 失败、automation 持久化失败、renderer delivery unknown 不被误报成功。
    - Provider/SDK：各 adapter 的安全 URL、request/response ID、status、first token、finish reason、usage、rate-limit、错误分类；缺失元数据不伪造；API key/header/raw body 永不出现在事件或导出。
    - Privacy：默认仅 256 字符脱敏预览/长度/hash；系统提示词和二进制不落盘；safeStorage 不可用拒绝诊断捕获；1h/24h 到期；普通导出排除正文；删除操作只触及日志受控根。
    - Viewer：过滤、trace 树、实时批量、pause/follow、internal 隐藏、当前 trace 导出；纯样式和文案不补测试。
    - Cleanup：源码契约确认产品运行时无未允许 console/eprintln，仓库只剩 main 产品日志 writer，`electron-log` 与死 `lume-logger` 无引用。
    - 只运行上述受影响测试文件、Rust crate 定向测试及必要模块 typecheck；不执行全仓 lint/test。最后运行 `git diff --check`。手工启动 desktop dev，确认示例中的 healthcheck/list RPC 不再刷屏，并完成一次真实消息 trace 的日志页检查。

## Key decisions & tradeoffs

- **覆盖全部产品运行时与所有 Agent 入口，不覆盖工程脚本日志。** Electron main、sidecar、renderer、desktop-host、node-repl 都进入统一管线；CLI/headless 复用 Agent trace 字段，但构建、测试和 CLI 自身输出不纳入治理。
- **Electron main 是唯一最终写入者。** 这消除并发写、重复包装和多套轮转配置；代价是子进程必须有启动 ring buffer 和 emergency fallback，main 崩溃后不能继续正常落盘。
- **业务 trace 与普通 debug 分开路由。** 所有用户业务 trace 默认完整落盘但不刷终端；后台轮询只保留异常、慢调用或聚合。这比单靠 level 更精确。
- **一次入口请求一个 trace，一次 Agent 执行一个 run。** queue/resume 保留或链接 trace，provider retry 有 attempt，子 Agent 使用 linked trace，避免把所有异步工作塞进一个永不结束的父 trace。
- **renderer state committed 是桌面聊天的正式完成点。** forwarded 不能证明 UI 收到；rendered 只作为可选里程碑，避免 UI 结构变化破坏核心语义。
- **默认只保存安全预览。** 完整用户/Agent 正文必须显式、限时并加密；系统提示词、provider 原始 body、任意二进制和无限工具 dump 即使诊断模式也禁止。
- **base URL 保留完整路径。** 为满足自定义 provider 诊断，默认不只保留 origin；安全代价通过删除 userinfo/query/fragment和脱敏疑似 secret path segment控制。
- **复用现有 RuntimeEvent、TraceRecorder、RunObserver 与 usage identity。** 日志管线提供跨进程全链路，Trace Store作为 run 诊断投影；不建立第三套 Agent workflow event model。
- **业务优先于日志绝对无损。** 有界队列允许丢弃低价值日志并显式报告，关键 trace/错误尽量保留；不让日志反压 provider 或工具执行。
- **删除旧 Rust logger 与 electron-log 双轨。** 当前 `crates/lume-logger` 属于旧 Tauri 方案且未进入 Electron 主链路；继续包装它会增加 native 构建复杂度和协议分叉。
- **不新增依赖。** 使用 Node fs/crypto、Electron safeStorage、现有 shared/types 和 Rust serde；保持 diff 可审查与可回退。

## Risks / open questions

- Electron main 作为单写入者是故障集中点；计划通过 source ring buffer、emergency crash 文件、main 启动尽早初始化和退出 flush 缓解，但无法覆盖断电或 main 瞬时崩溃后的全部尾部事件。
- 完整 base URL path 仍可能含非标准 credential；实现必须测试常见 tokenized path，并允许后续扩展 redact pattern，而不能宣称所有自定义 URL 都可自动识别。
- main 与 sidecar 的事件时间来自不同进程；跨进程严格排序只能依赖 main `observedAt/seq`，source `emittedAt` 只用于诊断。span duration 必须在 source 内用单调时钟计算。
- provider 抽象当前不统一暴露 HTTP status/request ID/first token；部分 adapter 只能提供子集。缺失字段必须明确显示 unknown，不能为追求完整 UI 而伪造。
- 现有 Agent Trace Store按 session 文件存储，改为接受上游 trace ID 时必须保持旧 trace 查询和 run resume 兼容；不得把 logging retention 误用于运行恢复所需的 run state。
- `safeStorage` 在平台/会话状态不同情况下可能不可用；诊断正文功能必须可明确禁用，不能影响普通日志和 Agent 运行。
- 全量第一方 console 迁移范围较大，应按阶段机械替换并使用契约测试约束，不借机重构无关业务。
- 实时日志页在高吞吐 trace 下仍可能产生 UI 压力；main 与 renderer 都需要 batch、最大缓冲和 pause，不向页面推送流式 token delta。

## Out of scope

- 远程遥测、OpenTelemetry collector、云端日志平台、跨设备聚合、告警与指标 dashboard。
- 保存或回放完整 provider HTTP 报文、完整系统提示词、任意文件/网页正文、截图或附件二进制。
- 为构建脚本、测试脚本、benchmark、第三方依赖 console 和 CLI 人类输出建立统一日志规范。
- 重写 Agent RuntimeEvent 的 UI 产品语义、改变消息内容或 provider/tool 行为；本次只增加可观测上下文与安全投影。
- 对历史日志做格式迁移或长期保留旧 writer；只提供读取兼容。
- 新增第三方 logging/tracing/加密依赖，或在真实项目目录写入日志。

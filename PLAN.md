# Plan: 重构 Lume 统一日志与端到端 Agent 链路追踪
_Locked via grill — by Codex + user; condensed for adversarial review_

> 本文件是实施与评审的规范版本；`PLAN-logging-details.md` 仅保留访谈后形成的详细说明，不新增要求。若两者表述冲突，以本文件为准。

## Goal

建立覆盖 Electron main、renderer、sidecar、desktop-host、node-repl 及全部 Agent 入口的统一结构化日志管线。Electron main 是唯一普通日志文件写入者；默认终端只显示关键生命周期与异常，成功 RPC、healthcheck 和列表轮询不刷屏。每次用户或系统入口都能通过稳定 ID 追踪 `入口 → IPC → sidecar → queue/runtime → provider/tool/subagent → 持久化 → 转发 → 前端提交或渠道确认`，同时默认不泄露密钥、完整正文、系统提示词或 provider 原始报文。

## Approach

1. **定义共享事件协议与关联语义。**
   - 在 `packages/shared` 增加版本化 `LumeLogEventV2`、批量传输、查询和配置类型；新文件写 NDJSON v2，读取器兼容现有 v1/pino/plain text，但不迁移历史文件。
   - 每条事件包含 `eventId/schemaVersion/emittedAt/observedAt/seq/kind/level/source/context/event/status/message/data/error`；关联字段保持顶层可索引。
   - canonical `traceId` 表示一次入口请求，由首个可信 main/sidecar 边界生成；renderer 只生成 `submissionId/clientEventId`，main 的接收回执把它们映射到 canonical trace。`runId` 表示一次 Agent 执行，`spanId` 表示阶段，retry/fallback 使用独立 `providerAttemptId`，工具沿用 `toolCallId`，子 Agent 使用独立 trace 并通过 parent/link 关联。
   - ID 只用于关联，不用于授权；main 校验所有跨边界事件的类型、UUID/长度、source allowlist 和批量大小。任何外部 ID 都不得直接组成文件名或路径，持久化键必须由内部生成或经过固定编码。稳定事件名使用英文点分格式，错误使用统一结构。

2. **让 Electron main 成为唯一 writer。**
   - 在 `apps/desktop/src/logging` 建立服务，负责二次脱敏、时间归一化、单调 `seq`、终端格式化、异步批量写入、轮转、保留、查询、导出和 live subscription，不新增依赖。
   - 默认文件级别为 info，但 `kind=trace` 单独路由并完整落盘；终端只显示关键 info、warn/error/fatal。成功的 polling/RPC 默认不生成普通日志，只记录失败、超时、慢调用或周期聚合。
   - 文件按日生成，20 MB 分段，默认保留 14 天且总量不超过 500 MB。写入队列按约 50 ms/100 条批处理；普通 debug 和 trace detail 可丢弃并生成聚合 `logging.events_dropped`。不可丢的 trace spine 明确定义为 entry/accepted、run start/end、每次 provider attempt end、assistant persistence、delivery completion/unknown 及 parent/link；若任何 detail 被丢弃，同一 trace 写 `trace.incomplete` 标记和丢弃分类。
   - 为 trace spine 和 warn/error 保留独立容量；极端饱和或 writer 自身故障时只写最小 emergency stderr/crash record，绝不反压 Agent/provider 执行，也不承诺断电时尾部绝对无损。
   - rotation、retention、export snapshot 和 shutdown flush 通过 writer 的单一 segment lifecycle 队列串行化；永不删除 active segment。导出先 flush/rotate 得到不可变 segment 快照，并用 generation 隔离后续 live-tail，Windows 文件占用失败只延后清理而不破坏 active writer。

3. **用薄 transport 接入所有进程并消除重复包装。**
   - main 自身直接调用 logging service；sidecar 和 renderer 使用本地过滤、首次脱敏、有界 batch transport。事件进入脱敏或队列前必须经过 cycle-safe serializer：拒绝 getters/prototypes，限制 depth、breadth、key count、单字符串和最终 encoded bytes，并对 Error/BigInt/循环引用使用确定性占位。每个 transport 同时受事件数和字节数上限约束，只允许一个或小的固定数量 acked in-flight batch；超时/断连停止继续发送并在本地按优先级丢弃，重连回放不得突破同一 pending-byte 上限。sidecar 未连接时使用有界启动 ring buffer，连接后按原时间回放。
   - renderer 经 preload allowlist 的专用 IPC 发送，同时统一接入 `window.error`、`unhandledrejection` 和 React error boundary，不 monkey-patch 普通 console。
   - desktop-host/node-repl 仅在 stderr 发带协议标识的单行 JSON；父进程按行解析，解析失败才记录 `raw_process_output`。stdout 的 socket/MCP/control 协议保持纯净。
   - `system.log-batch`、日志查看器查询/live-tail 以及内部控制事件不进入 RPC access log，避免日志系统自我污染。
   - 预期 shutdown 的 `sidecar exited code=0` 为 debug；意外 code=0 为 warn；启动失败或崩溃为 error/fatal。终端不再出现多层 `[desktop] [sidecar] [app]` 前缀。

4. **在所有 Agent 入口建立并传播 trace context。**
   - 扩展 `AgentSendInput` 或等价共享类型，renderer 入口只携带 `submissionId/clientEventId` 和非权威 origin hint；main 根据 IPC `event.sender/webContents.id` 与当前窗口 lifecycle registry 派生 `main_window` 或 `quick_input`，拒绝 sender 与 hint 不一致的事件，然后生成 canonical `traceId` 并回传映射。IM、Automation、Routine、subagent、resume 等入口由各自可信 sidecar adapter 派生 origin 并生成 canonical trace，携带可选 parent/link。
   - main 为 IPC/RPC 分配 `rpcRequestId`；sidecar 的校验、approval/continuation 分流、queue accepted、重排、取消、冷启动恢复均保留或链接原 trace context。
   - `sendAgentMessage` 在持久化后绑定真实 `messageId`。现有 Trace Store 继续使用内部生成的 per-run `storeTraceId` 作为文件键；版本化扩展 `correlationTraceId`、parent/link 字段，`LumeRunObserver.create` 接受 correlation context 但仍创建内部 store trace/run/root span。旧 reader/resume 按 schema version 兼容，绝不把外部 correlation ID 当文件键。复用现有 `TraceRecorder`、RunObserver、RuntimeEvent 和 usage identity，不建立平行 workflow 模型。
   - origin 至少覆盖 `main_window/quick_input/im.<provider>/automation/routine/subagent/resume`；每种 origin 明确自己的完成点。

5. **在真实 runtime/SDK 边界记录 provider、tool 与 subagent。**
   - 把上下文组装、记忆、模型解析、session 创建/恢复、provider attempt、权限、工具、compaction、subagent、persist、finalize 建模为 span。
   - 给 SDK `QueryEngineConfig` 增加可选且平台无关的 observability callback；SDK 不依赖 desktop logger，sidecar adapter 负责绑定 trace context。
   - provider attempt 记录 requested/effective provider、channel、adapter、model、attempt、status、request/response ID、first-token/总耗时、chunk/字符数、finish reason、usage/cache/cost/rate-limit 和规范化错误；不可获得的字段保持 unknown。
   - base URL 保留完整路径，但删除 userinfo、query、fragment，并脱敏疑似 credential 的路径段。禁止 API key、authorization/cookie、provider 原始 request/response body。
   - 不逐 token/chunk 写日志。工具只记录 name/call ID/source/权限/状态/耗时及有界安全摘要；文件和二进制只记录受控路径、mime、size、hash。

6. **定义回复交付的确定完成语义。**
   - sidecar 对用户消息持久化、assistant final、可见消息版本和 run state 分别产生 milestone；同一 `traceId/runId/messageId` 随关键 RuntimeEvent 与通知传播。
   - main 为每次目标窗口投递创建唯一 `deliveryAttemptId`，绑定 `webContents.id`、renderer lifecycle/导航 generation、message version 和 trace；主窗口与 quick-input 的广播分别形成独立 attempt，不共享成功状态。
   - `webContents.send` 后记录 `reply.forwarded`；renderer 收到匹配版本后记录 `reply.received`，仅由观察到该精确 message version 已进入目标 atom/store 的 post-commit effect 回传幂等 `reply.committed` ack；可选在下一 animation frame 记录 `reply.rendered`。
   - 重复/迟到/旧 lifecycle ack 被 main 幂等忽略；ack 超时只把对应 attempt 标记 `delivery_unknown`，不误报失败或成功。IM 以渠道 send ack 为完成点，Automation/Routine 以结果持久化为完成点，子 Agent 以自身 run/announce 结果为完成点。

7. **实现隐私、配置与 trace-centric viewer。**
   - 默认消息摘要由专用 allowlist builder 生成，只允许角色、长度、使用 main 持有的 per-install secret 计算的 keyed digest，以及通过敏感值扫描后的最多 256 字符预览；普通 `data` schema 拒绝 message/body/prompt/raw response 字段。高风险上下文只记录结构化摘要，不生成文本预览。系统提示词只存版本/section keyed digest/长度；不复制文件、网页、截图、媒体或大段 shell 输出。
   - main 生成并通过 safeStorage 保护 per-install digest root key，再按 `source/purpose/keyVersion` 派生不可逆 HMAC subkey，通过可信 IPC 随版本化 policy snapshot 分发给 renderer/sidecar；producer 用 subkey 对自己持有的完整正文计算 keyed digest，永不接触 root key或把正文送入普通日志。safeStorage 不可用时使用仅当前进程会话有效的随机 root，并把 digest 标记为 `session_scoped`，不降级为普通 hash。
   - base URL 仍按用户锁定需求记录完整脱敏路径：强制删除 userinfo/query/fragment，逐 segment 处理已知 credential、JWT、高熵和 provider token 模式并支持配置扩展。扩展规则只允许有长度、数量和 segment 长度上限的 exact/glob 语法，禁止用户正则和跨 segment 匹配，确保线性时间；不得宣称能识别所有自定义 tokenized path，设置页与导出确认明确提示这一残余本地泄露风险。
   - 完整用户/assistant 正文使用与普通事件判别联合不相交的 `SensitiveDiagnosticEnvelope`，普通 writer、队列、live-tail、viewer 查询和普通导出遇到该类型必须拒绝。main 在接收时重新验证 thread/trace scope、lease version 和 expiry，再用 Electron `safeStorage` 加密写入独立受控目录；默认 lease/密文 TTL 为 1 小时、最长 24 小时，并设置独立容量上限、启动/定时过期清理和立即删除。不可安全使用时拒绝开启，不回退明文；完整导出需再次确认并审计。
   - 日志配置仍位于现有 `settings.json` 的 GeneralSettings schema，但 Electron 模式下由 main 的 `SettingsBroker` 成为整个根文件的唯一持久化 writer；general settings、UI state、proxy settings 及发现到的其他 root writer 全部改为请求 broker 做序列化 read-modify-write，不能各自重写快照。standalone CLI/headless 使用同一 `wx` lock-file/PID+start-time 所有权协议：desktop 持锁时只读设置并用进程内/env override，拒绝持久化 mutation；无 desktop 时 standalone 可取得锁并原子写入。logging policy 与 diagnostic lease 使用单调 `configVersion`，main 启动即加载并向 producers 分发只读 snapshot，拒绝旧版本回写；sidecar 重启不能恢复陈旧 lease。热更新 level/format/诊断状态，轮转参数在下一分段生效；旧环境变量兼容一个版本并只提示一次弃用。
   - 把 list/read/query/open/export/delete/decrypt/live-tail 收口到 main；sidecar 停止时日志页仍可用。页面支持字段过滤、span 树、provider/model/usage 摘要、暂停/follow、当前 trace 导出；内部 viewer 事件默认隐藏。交互控件复用现有 shadcn/global 组件。

8. **分阶段迁移、删除双轨并定向验证。**
   - P0 去噪；P1 shared v2 + main writer + transports；P2 Agent/provider/tool trace；P3 native host + 加密诊断 + 配置；P4 viewer + cleanup。每阶段在新路径验证后才删除旧 writer，禁止长期双写同一文件。
   - 删除 sidecar/desktop 的 `electron-log` 写入、sidecar console monkey patch、迁移后无用的 sidecar log-viewer RPC，以及确认无 workspace/build 引用后的旧 Tauri `crates/lume-logger` 和过时日志设计文档；不新增依赖。
   - 第一方产品运行时代码迁移到上下文化 logger，仅 bootstrap/emergency 保留最小 console/eprintln allowlist；源码契约测试禁止新增直接 console/eprintln、多 writer、敏感 header/raw body。
   - 定向验证协议与双层脱敏、URL 清理、队列/轮转/保留、transport/ring buffer、预期与意外退出、完整 Agent E2E ID 链、queue/resume/subagent/provider retry、1000 chunks 聚合、各 origin 完成点、safeStorage 失败、viewer live unsubscribe 和历史兼容。
   - 仅运行受影响测试和必要模块 typecheck，最后执行 `git diff --check`；手工 desktop dev 验证示例中的健康检查不再刷屏，并检查一次真实消息 trace。

## Key decisions & tradeoffs

- Electron main 是唯一普通日志 writer；子进程因此需要启动缓冲和 emergency fallback。
- 业务 trace 与普通 debug 分开路由：链路默认可查，但不会因完整 trace 重新刷终端。
- renderer state committed 是桌面回复完成点；forwarded 不是送达证明，rendered 不是核心可靠性条件。
- canonical trace ID 只由可信 main/sidecar 边界生成；renderer submission ID 与 Trace Store 内部文件键保持独立，以换取更明确的信任和迁移边界。
- renderer 的 origin 仅是 hint；窗口类型由 main 的可信 sender/lifecycle registry 派生，内部入口由 sidecar adapter 派生。
- 默认保存 allowlisted 摘要、keyed digest 和经扫描的最多 256 字符预览，这是用户锁定的本地可诊断性取舍；预览不能提供绝对秘密隔离。完整用户/assistant 正文必须走独立 envelope、限时、限定 scope、加密，系统提示词和原始 provider body 永不保存。
- base URL 记录完整脱敏路径以诊断自定义 provider，这是用户锁定的可观测性要求；无法保证识别所有非标准 tokenized path，因此接受明确的本地残余风险，并要求可扩展 segment redaction 与导出提示。
- 复用现有 Trace Store/RunObserver/RuntimeEvent；新增的是跨边界关联和安全日志投影，不是第三套 Agent 事件系统。
- 有界队列优先保护业务执行而非追求日志绝对无损；trace spine 不参与常规丢弃，detail 丢弃必须聚合并把 trace 标记 incomplete。
- 不增加依赖，删除 electron-log 双轨与未接入 Electron 主链路的旧 Rust logger。

## Risks / open questions

- main 是故障集中点；进程崩溃或断电可能损失最后一批事件，只能通过启动缓冲、保留容量、emergency record 和退出 flush 缓解。
- 让 main 成为 Electron 模式下 `settings.json` 的唯一 writer 会扩大设置持久化迁移范围；必须保持现有 sidecar RPC 表面兼容，并为 CLI/headless 明确独立 owner，避免跨进程双写。
- settings lock 的 stale-owner 判定必须同时校验 PID 与进程启动标识；无法证明锁已失效时宁可拒绝 mutation，不能强占后造成双 writer。
- 不同进程的 wall clock 不可靠；全局展示顺序以 main `observedAt/seq` 为准，source duration 必须使用本进程单调时钟。
- provider adapter 暴露的 status/request ID/rate-limit 元数据不一致；UI 和 schema 必须允许 unknown，不能伪造完整性。
- Trace Store 的 resume 数据不能受普通日志 retention 影响；共享 ID 不代表共享生命周期或存储策略。
- safeStorage 的平台可用性不同；诊断正文功能失败不得影响普通日志和 Agent 执行。
- 默认 256 字符预览与完整 base URL path 即使经过扫描仍有未知秘密泄露的残余风险；两者均为用户明确锁定的本地诊断取舍，实现和 UI 不能把它表述为绝对安全，测试只能覆盖已知模式。
- 全量 console 迁移范围较大，必须分阶段机械替换，避免顺便重构无关业务。

## Out of scope

- 远程遥测、OpenTelemetry collector、云端聚合、告警和指标 dashboard。
- 完整 provider HTTP 报文、完整系统提示词、任意文件/网页/媒体正文的保存或回放。
- 统一构建、测试、benchmark、第三方依赖及 CLI 人类输出。
- 改变 Agent、provider、tool 或消息产品行为；本次仅增加可观测上下文和安全投影。
- 迁移历史日志或长期保留旧 writer。

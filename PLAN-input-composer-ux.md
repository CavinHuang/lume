# Plan: 统一输入框体验与技能/插件引用协议
_Locked via grill — by Codex + user_

## Goal

把欢迎页、会话页和 Quick Input 的输入体验收敛到同一套富文本编辑器、视觉外壳和动作状态机，同时保留各入口真实可用的上下文能力。技能与插件统一从 `/` 面板选择，并以 `lume-skill://...`、`lume-plugin://...` 作为唯一持久化和调用协议；输入、排队、发送、停止、失败恢复、消息展示与复制形成一致、可验证的闭环。

## Approach

1. **先做清理映射和工作树保护，再改共享能力。**
   - 实施前重新执行 `git status --short`，逐个检查本计划会触及的脏文件，尤其是 `packages/sdk/src/agent.ts`、`packages/sdk/src/agent.test.ts`、`apps/sidecar/src/services/agent/prompt/sections/core-sections.ts` 及测试、`apps/web/src/components/agent/RuntimeEventContentBlock.tsx`；只在用户现有改动之上做窄幅合并，不覆盖、回退或顺手整理无关内容。
   - 记录并按依赖顺序迁移当前重复路径：欢迎页独立编辑器、`AgentInput` 编辑器、`LumeComposer` 的 `hero/compact` 变体、`$`/`%` suggestion、插件旧 `$plugin` 路由、角色推荐、重复“图片”附件动作、欢迎页重复模型选择器、输入框内常驻队列列表。
   - 先引入可复用的最小协议/状态能力并迁移调用方，确认没有引用后再删除旧分支；优先删除而不是保留兼容层，不新增依赖，不重排无关文件或做全局格式化。
   - 实施拆成三个可独立审阅和回退的里程碑：A）后端规范协议、invocable catalog、skill registry 隔离、幂等提交与附件 lease；B）共享富文本编辑器、三个入口与消息标签切换；C）队列 revision/CAS、完整快照与暂停状态机。每个里程碑都有定向测试和 diff gate；旧触发器只在 B 的最终切换点删除，最终产物不保留兼容解析，也不把中间态单独发布。

2. **在 SDK 定义唯一的规范引用契约，并通过 shared 暴露给 Web/sidecar。**
   - 新增无环境依赖的纯函数协议模块，定义三种规范引用：插件 `lume-plugin://<pluginId>`、普通技能 `lume-skill://<skillSlug>`、插件技能 `lume-skill://<pluginId>:<skillSlug>`。这是 Lume 自定义词法协议，禁止交给 WHATWG `URL` 或浏览器 authority 解析，避免 `:` 被当端口或 host 被小写化。
   - 每个 id/slug 作为单个、大小写敏感的 URI component 进行严格 UTF-8 percent-encoding；插件技能只用两个 raw component 之间第一个未编码 `:` 作分隔。先分隔、再严格单次 decode，拒绝空值、控制/空白字符、非法 percent sequence 和超长 component；随后用唯一 canonical encoder 重编码并要求与输入完全相等，因此 `/`、`:`、`%` 等只可作为编码后的 ID 内容，且不存在双重编码或大小写归一化歧义。解析值必须与注册表 canonical id/slug 字节精确匹配。展示名称永不参与路由。
   - 解析器支持多个引用、去重和规范格式化；同一插件的整体引用覆盖其具体技能引用，避免重复执行。规范 URI 是可见消息和复制格式，但执行授权由结构化 message part 承载，不能仅因正文出现 URI 就激活能力。
   - Web 把编辑器内容序列化为有序 `AgentUserMessagePart[]`：`{ type: 'text', text }` 或 `{ type: 'capability_ref', occurrenceId, uri }`。只有从 `/` 面板选择或把完整 canonical URI 明确转换成富文本引用 node 时才产生 ref part；普通正文、日志和历史消息中的相同字符串留在 text part。sidecar 由 parts 唯一派生 visible string、ordered refs 和 model string，不用易漂移的字符 range 猜 occurrence。
   - 手写 `/foo`、`$foo`、`%foo` 都是普通文本；编辑器识别到待生成引用的畸形 `lume-*://` node 时阻止发送并定位错误，sidecar 不扫描任意正文猜授权。复制把 parts 拼成 canonical 可见文本，编辑/重发从持久化 parts 恢复 node，因此同一 URI 同时出现在标签和日志文本时也不会混淆。
   - 明确硬切换：移除 SDK 对 `/skill`、`/skill-name`、`$skill` 的手动技能调用解析，移除 sidecar 对 `$plugin`、`$plugin:skill`、`%plugin` 的显式激活逻辑，不为旧草稿或旧消息做协议回填。历史 `$`/`%`/旧 `/skill` 仅按原始文本显示。
   - 为自定义词法、大小写保持、reserved component 编码、格式、多个引用、覆盖去重、正文 URI 不授权、非法/未知引用和旧语法不再触发编写 SDK 纯函数测试；`@project/...`、`@session/...` 文件协议保持独立，不被本解析器吞掉。

3. **在发送边界建立结构化授权、持久 submission receipt 与唯一消息投影顺序。**
   - 保留现有必填 `userMessage` 以兼容 automation、IM、routine、subagent 等 producer，并增加可选有序 `messageParts` 与稳定 `clientSubmissionId`。统一 normalization 规则：parts 缺失时把 `userMessage` 包成单个不授权的 text part；parts 存在时拼接结果必须逐字等于 `userMessage`，否则 schema 拒绝。只有显式 capability-ref part 授权，旧 producer 不会因正文 URI 意外调用能力。
   - Web 从 TipTap node 同时生成 `userMessage` 与 parts；需要显式能力的 headless 调用方必须构造 matching ref part，不能靠扫描 prompt。sidecar 校验 occurrenceId 唯一、URI 规范、去重/覆盖和 callable 状态，拒绝隐藏授权或双正文分叉。
   - Web 提交前用同一协议模块校验 editor JSON；未知、已卸载、禁用、待审核、歧义或诊断失败的技能/插件阻止发送，并把错误定位到标签。sidecar 在 workspace/runtime permission gate 下再次权威解析，不能信任 Web catalog 快照。
   - 在一次 logical submission 内固定 `clientSubmissionId`。仅当响应结果未知时，附件状态查询和 transport retry 复用同一 ID/payload hash；sidecar 明确 `rejected`/abort 后该 submission 终结，用户修正或再次提交必须生成新 ID 和新 attachment lease。
   - 新增单一 `agent-submissions.sqlite`（复用仓库已有 `node:sqlite`，不加依赖）作为新 composer submission 的事务 source of truth，表内保存 receipt、唯一 message/thread creation event、parts metadata、outbox、lease ownership 与 projection status。`clientSubmissionId`、`messageId`、`creationToken` 建唯一约束；现有 thread index、session JSONL/runtime transcript 和 message-version 文件改为按稳定 event/message ID 幂等投影，不再作为判断本次 submission 是否已接收的权威来源。
   - projection worker 在提交后写现有 JSON/JSONL；每个 append 前按稳定 message ID 去重，原子重写型 projection 保存 last-applied event sequence。启动与读线程/消息前协调缺失 projection，SQLite event 可重放 thread 创建、visible message 与 parts metadata；投影失败标记并重试，不能重复创建线程/消息。只把新 submission event 迁入该 store，不重写历史 assistant/tool transcript。
   - receipt 状态机为 `preparing → accepted | queued | rejected`，outbox/执行为 `accepted|queue_claimed → claimed(lease) → started → completed|failed|interrupted`，排队为 `queued → queue_claimed`；未被 runtime 接管的队列可协调为 `restart_dropped`。首先写最小 preparing receipt（ID/hash/目标，不含正文），再完成 normalization、data-only capability preview、兼容性、budget、附件 lease、模型/channel/权限与桌面 snapshot 校验；失败终结 rejected，不产生 message event。
   - 即时发送校验通过后，在一个 SQLite transaction 内写 message/thread event、parts、receipt `accepted` 与 pending outbox。worker 用 owner + expiresAt lease CAS 为 `claimed`；在调用 provider/tool runtime 前持久化 `started`。崩溃时 expired `claimed`（尚未 started）可重新 claim，stale `started` 标记 `interrupted` 且不自动重放；查询不能把 started/interrupted 伪装成成功。
   - 排队校验通过后，在 queue lock 内先把 receipt CAS 为 `queued`，再向内存 kernel 发布 item；publication 失败立即 CAS `restart_dropped` 并 abort lease。worker 只能以 `queued → queue_claimed` CAS 认领队首，然后在同一 SQLite transaction 写唯一 message event + pending outbox；此时才 commit attachment lease。SQLite 中不保存完整 queue payload，因此重启只投影已 claim 的消息并把未发布/未恢复 queue receipt 标记 dropped。
   - receipt/outbox 不依赖进程缓存。sidecar 重启后可查询已接受的 thread/message，恢复 pending 或 expired pre-start claim，标记 stale started 为 interrupted，未恢复队列为 restart_dropped，rejected 返回终态；同一 submission ID 不同 hash 始终拒绝。
   - 消息投影固定为：从 parts 派生 visible/model text → 纯 resolve 得到 refs/fingerprints/静态策略 → 在 preparing validation 或 queue validating 阶段 materialize prompt preview → 组合 capability context → 持久 message/outbox → routing、memory recall、workflow hooks 只消费该投影，不再覆盖 `userMessageForModel`。
   - 调整 `capability-routing.ts`、`core-plugin-hooks.ts`、`agent-prompt-builder.ts` 与 SDK query 入口，删除仍指导模型使用 `$plugin` 或旧 `/skill` 的 prompt/test；消息只有引用、删除引用后为空、引用与附件并存等情况都走同一 payload 与幂等判定。

4. **用一个 runtime 权威 catalog 和 SDK executor 收敛发现、scope 与执行语义。**
   - 新增窄的 `LIST_INVOCABLE_CAPABILITIES`，由当前 workspace 的 runtime registry、plugin permission/review gate 和 skill resolver 生成；返回 canonical URI、kind、displayName、source/scope、callable 状态/原因和 marketplace icon。`LIST_PLUGINS`/`LIST_EDITABLE_SKILLS` 继续服务管理页，不再作为 composer 的授权清单。
   - 普通 `lume-skill://<skillSlug>` 保留用户锁定外形。resolver 明确定义并复用单一优先级（当前 workspace/project > user/global > bundled，具体顺序以现有运行时加载规则校准）；同一最高优先级出现多个来源时标记 ambiguous 并拒绝调用，catalog 只把唯一 winner 设为 callable，不能让不同 API 各自合并。
   - 用户已锁定“无 workspace 时技能面板为空”：desktop sidecar catalog 和 explicit-ref gate 都禁止无 workspace skill 调用，即便 standalone SDK 可在显式 cwd/skill roots 下使用全局技能；两种 surface 的前提必须写入 API contract 和测试，不能出现 Web 隐藏但 sidecar 仍接受的能力。
   - 修复进程级 skill registry 的跨 Agent 污染：resolver/lookup 必须是 Agent/session scoped。若底层仍使用共享容器，键必须是 `(ownerToken, skillName)` 多映射，所有 lookup/unregister 都强制携带 owner；禁止继续用单一全局 skillName key，也不能只加引用计数。增加两个 workspace 并发加载、同 slug 不同定义、交错关闭/热刷新测试。
   - composer preview 必须是 data-only：为可显式引用的 capability 增加序列化 invocation descriptor（静态 prompt/template、参数规则、allowed tools、context/agent mode、source/version/fingerprint），由 filesystem/plugin loader 在加载时构造；preview 只解释该 descriptor，不接收 `ToolContext`、不执行任意 callback。只暴露 legacy async `getPrompt(ToolContext)` 且没有 data-only descriptor 的定义默认不进入 invocable catalog。
   - claim 后统一 executor 消费已验证 descriptor/materialized prompt，应用 allowedTools、context/agent mode、isEnabled 与 usage recording；usage 以 outbox attempt ID 幂等记录一次。多个 refs 使用剥离 URI 后的 `modelMessage` 作为 args、工具取安全交集、互斥模式 fail closed。即时 materialized preview 放入 SQLite outbox；队列保存在内存并在 fingerprint 未变时复用，变化则阻塞并重新 preview。
   - 插件整体引用通过同一 executor 展开其当前可调用 skills，并遵守上限：每条消息最多 8 个显式 refs，单个展开 prompt 最多 64 KiB UTF-8，总 capability context 不超过 128 KiB 且不超过模型可用上下文的 25%；任一超限 fail closed，提示改选具体插件 skill，绝不截断执行指令。
   - Slash 面板、编辑器和消息标签以 canonical URI 为键、display name 为文案。插件配置 logo 时展示现有 marketplace 安全 asset；缺失/加载失败回退 Lucide `Package`，技能统一 Lucide `BookOpen`。display-only 历史项可弱化展示，但不可调用。

5. **提取一套富文本 Prompt Editor，供三个入口复用。**
   - 保留 TipTap，提取共享的 editor extensions、序列化/反序列化、引用 node、Suggestion 生命周期、粘贴解析、payload 判定、IME 与键盘规则；欢迎页不再维护第二套 Textarea/编辑器行为。
   - `AgentInput` 继续承载线程运行态与 RPC 编排，欢迎页/Quick Input 只提供各自上下文 adapter；避免把全部业务塞入一个巨型组件，也不为了单一调用创建抽象层。
   - 开启标准 undo/redo：`Ctrl/Cmd+Z` 撤销，`Ctrl/Cmd+Shift+Z` 重做；技能/插件/Agent/文件标签插入进入同一 undo 栈。切换线程、恢复草稿或加载待编辑消息时重置 undo 栈，不能撤销到上一线程。
   - `Enter` 发送、`Shift+Enter` 换行；IME composition 期间 `Enter` 不发送。菜单选中后把焦点放回编辑器末尾，发送成功后保持焦点。

6. **把 `/` 收敛为唯一能力面板，同时保持 `@` 的引用职责。**
   - 删除 `$` 技能面板和 `%` 插件面板，`/` 面板按“动作 / 技能 / 插件”分组并跨组搜索；不增加最近使用、收藏或新的独立插件入口。
   - `/` 仅在输入开头或前一个字符为空白时触发，URL、文件路径和普通文本中的 `/` 不触发；选中结果只替换当前 `/查询词`，保留前后正文。未选择的 `/foo` 始终是普通文本。
   - 技能/插件选中后插入富文本引用 node，序列化为 canonical URI，允许继续选择多个引用；动作项直接执行：`/clear` 先确认，`/compact` 和 `/reload-plugins` 使用现有 RPC，`/mcp` 打开其子视图。
   - 动作仅在没有正文、附件或桌面上下文时可执行；有草稿时显示禁用原因。欢迎页隐藏 `/clear`、`/compact` 等线程动作；运行中显示但禁用并解释原因；无 workspace 时 skill catalog 与 MCP 给出空状态，sidecar 同步拒绝 skill refs，全局且已授权插件仍可显示。
   - 面板支持方向键、`Enter`、`Tab`、`Esc` 和鼠标；首项高亮、分组标题、禁用原因与结果数量提供可访问语义。复用 shadcn/global 原子组件；如缺少合适浮层原子，先生成全局组件再在业务组件中使用。
   - `@` 继续只负责 Agent 与文件：Agent 始终可选；有 workspace 时支持 `@project/...`；仅已存在会话支持 `@session/...`；欢迎页只提供 Agent + project；无 workspace 时只提供 Agent 并解释文件不可用。

7. **统一引用标签在输入、消息、粘贴与复制中的行为。**
   - 输入框标签展示友好名称与图标，内部 node attrs 保存 canonical URI、稳定 occurrence ID 与 kind；只有这些 node 序列化为 capability-ref part。点击只选中标签，`Backspace/Delete` 删除，不在编辑时跳页。粘贴完整 canonical URI 会可见地转换为标签并进入 undo 栈；普通 text part URI 或历史 Markdown 渲染不自动获得执行权。
   - 已发送用户消息中的技能/插件 URI 渲染为紧凑标签；插件使用配置 logo/`Package`，技能使用 `BookOpen`。点击可用标签打开对应详情，悬停显示完整 URI 与状态；缺失/禁用项保留名称或 ID、使用弱化样式，点击提示“当前不可用”。
   - 整条消息复制、选区复制和编辑回填都输出/恢复 canonical URI，而不是可见简称。所有 renderer 剪贴板写入继续使用项目的 `writeClipboardText` IPC 链路，不使用 `navigator.clipboard.writeText`。
   - 合并或替换 `PluginMentionNodeView`、`PluginChipText` 及其 `%` 解析分支，形成技能/插件共用的引用渲染边界；同时修正 `tool-result-renderers/highlighted-code.tsx` 的直接 clipboard 写入。不要改写 `RuntimeEventContentBlock.tsx` 中用户已有的无关工作。

8. **让 `LumeComposer` 成为三个入口相同的几何与视觉外壳。**
   - 删除 `hero/compact` 核心样式差异，三处使用相同圆角、边框、背景、内边距、字体、附件区、编辑区和 footer；只允许外部容器的宽度、定位及 Quick Input 的窄屏降级不同。
   - 编辑区最小高度约 64px、最大高度约 240px，超过后内部滚动；用真实 focus/focus-within 状态驱动强调边框/阴影，不再用 `hasText` 假装聚焦。统一使用 `--lume-*` token，移除欢迎页局部 `--brand` 覆盖。
   - Footer 固定为 `[+] [模型] [权限] [思考] — 弹性空白 — [上下文占用] [主动作]`。欢迎页没有上下文占用；左侧控件空间不足时可换行，主动作固定右侧。欢迎页删除 composer 上方重复模型选择器，保留 workspace selector。
   - 所有可视交互控件复用 `apps/web/src/components/ui` 的 Button、DropdownMenu、Tooltip 等全局原子。业务组件只负责尺寸/布局微调，不手写完整 button/input/menu 视觉体系。

9. **统一附件、建议、草稿、历史和焦点策略。**
   - `+` 菜单只保留“文件”和“当前应用”；文件选择统一接受文件/图片，删除重复“图片”和插件入口。拖放与文件选择进入同一 pending attachment 管线。
   - 新增共享的紧凑 pending attachment 展示：文件显示图标、名称、移除；图片显示约 40px 缩略图、名称、移除；自动换行并设最大高度/内部滚动。已发送消息的 `AgentAttachmentGrid` 保持现状。
   - 欢迎页建议仅在正文、引用、附件、桌面上下文都为空时出现；点击只填入并聚焦，不自动发送。删除输入框的自动角色推荐 chips，Agent 统一通过 `@` 选择；消息头像、已有 Agent 标签和重写能力不受影响。
   - 三个入口都有草稿：欢迎页使用独立 new-session draft，线程页/Quick Input 按 threadId 共用草稿；所有程序化插入同步保存。历史回溯只用于已存在会话，恢复历史不污染其他线程。
   - 欢迎页和 Quick Input 展示后自动聚焦；从新建、搜索或线程列表进入会话时，在无 modal/设置/文件交互时聚焦。菜单关闭、发送完成返回焦点；用户正在消息、文件、设置或 modal 中操作时不抢焦点。

10. **用一个自适应主按钮和带 lease/持久 receipt 的事务式提交流程统一发送、排队与停止。**
    - 主按钮保持稳定最小宽度并显示文字 + 图标：空闲且有 payload 为“发送”；流式且无 payload 为“停止”；流式且有 payload 为“排队”；本地提交阶段为“发送中”且禁用。Quick Input 极窄时允许图标模式，但必须有 tooltip 和 accessible name。
    - 提交前依次完成引用校验、桌面上下文刷新、附件 prepare 和 dispatch；这一短阶段锁定编辑器、引用、附件删除、模型/权限/思考配置并防止双击提交，不提供第二缓冲区。附件 prepare 返回绑定 `clientSubmissionId` 的稳定 lease/upload token，重试复用同一 lease，不重复复制文件。
    - sent 消息在 receipt/message 原子提交时 commit lease；排队项在 enqueue 时只持有带 TTL、可续租的 prepared lease，worker 成功 claim 且即将落消息时才 commit。持久化轻量 lease ownership journal 只用于崩溃/启动清理，不恢复队列；删除、跳过、明确拒绝或取消时 abort，只清理由该 lease 创建且没有 message ref 的资源。
    - 只有 sidecar 明确返回或 receipt 查询确认 `sent`/`queued` 后，才清空正文/附件/上下文、写入输入历史并清除草稿。transport unknown 时保留原 payload、ID 和 lease 并先查询；authoritative reject 后终结/abort 原 ID 与 lease，UI 仍保留可编辑 payload，但下一次提交生成新 ID/lease。
    - 欢迎页使用单个 sidecar orchestration RPC 建立 creation token/preparing receipt，并在同一 SQLite submission transaction 写 thread creation event、message event、accepted receipt 与 outbox；成功即返回稳定 threadId 并由 projection worker补齐现有索引/JSONL。校验失败在 event commit 前直接终结 receipt/abort lease，无需跨文件 compare-delete；响应丢失按 receipt 查询既有 thread event，避免 TOCTOU。停止失败只反馈错误，不伪造 idle。
    - `Esc` 使用 800ms 双击窗口：第一次按优先关闭 `/`、`@`、`+` 等本地面板，退出历史回溯或取消消息编辑，不清草稿；若当前线程仍在输出，显示“再次按 Esc 停止输出”的轻提示。窗口内第二次按调用 `STOP_THREAD`；空闲双击无破坏性动作。Quick Input 不再用单次 Esc 隐藏，仍通过 `Alt+L` 或窗口控件关闭。

11. **把队列从“正文列表”升级为 revision/CAS 驱动的完整快照状态机。**
    - queued dispatch 的内存 item 保存与 TipTap 解耦的 `userMessage + messageParts`、prepared attachment lease、桌面 snapshot id、模型/channel、权限、思考等级、workspace/thread binding、纯 preview 缓存，以及入队时解析出的 source/scope/version/content fingerprint；Web 从 parts 重建 node，不把 TipTap JSON 变成 sidecar schema。持久 receipt 只保存 hash/identity/status，不保存完整 queue payload。
    - 初始 `clientSubmissionId` 只标识不可变 enqueue receipt 并关联 `queueItemId`，不作为后续可变 payload 的 hash identity。队列编辑使用独立、可幂等的 `queueOperationId + expectedRevision`；CAS 成功原子替换 item payload/fingerprints 并续租/替换 attachment lease，receipt 查询只返回该 queue item 当前 revision/status。
    - 每个 queue snapshot 带单调 `revision`，item 状态为 `queued → validating → running` 或 `queued/validating → blocked`。queue lock 下只有 receipt 已持久为 queued 的 item 才能 publish/展示；worker 通过 SQLite receipt `queued → queue_claimed` CAS 原子 claim 队首。reorder/update/remove/promote/skip 携带 expected revision 且只改 `queued|blocked`，冲突返回最新 snapshot。
    - 入队后工具栏修改只影响当前草稿。编辑队列项时复用同一富文本编辑器，显式进入 queue-edit 模式；原项在 CAS 保存成功前继续留在队列，冲突时保留编辑稿并让用户重新应用，取消则完全不变。消息版本历史继续只读，不增加 composer toolbar。
    - 输入框顶部默认只显示“n 条排队消息”的紧凑摘要；展开后在 composer 上方显示完整列表，支持拖拽排序、编辑、删除、设为下次工具调用前引导。队列 UI 不占用 editor 滚动区，不改变当前草稿和焦点；空队列及欢迎页不显示。
    - 每条执行前重新校验 callable、预算、lease、workspace、permission、模型/channel、桌面 snapshot 与 fingerprints。未变时复用无副作用 preview；变化时丢弃缓存并进入 `blocked: capability_changed`，要求用户重新保存/确认后生成新 preview，禁止同 URI 静默切换实现。
    - 队列附件在 worker claim 前保持 TTL lease并由活动队列续租；sent 后由消息接管，删除/跳过/替换/sidecar restart_dropped 后由 journal 安全释放。提升为 guidance 仅对无附件、无 capability ref/桌面上下文且 model text 非空的项开放，否则禁用并解释。
    - 复用现有 runtime kernel 的运行周期但把直接 `shift()` 收敛到单线程 queue state machine；不恢复跨 sidecar/app 重启的队列内容。启动时依据 receipt/lease journal 把遗留 queued receipt 标记 `restart_dropped` 并回收未 commit lease。更新 list/reorder/update/remove/promote/skip API 与并发测试，删除现有 `startEditingQueuedMessage` 先移除原项的行为。

12. **增加不泄露内容的运行时证据，按里程碑定向验证并完成删除收口。**
    - 复用现有 trace/logging，增加结构化事件 `capability.reference.resolved|rejected`、`submission.deduplicated`、`attachment.lease.committed|aborted`、`agent.queue.blocked|resumed|update_conflict`；关联 trace/submission/thread/queue item ID，只记录 canonical ID、计数和 reason code，不记录 Skill 正文、用户正文、文件内容或绝对路径。
    - SDK：运行 canonical lexer、owner-scoped registry 并发、旧协议硬切换、SkillDefinition dry-run/executor、多 skill/plugin 组合和 budget 相关测试，包含用户当前新增的 filesystem skill 热刷新测试，确保合并后仍成立。
    - sidecar/shared：运行 legacy producer normalization、message parts occurrence、invocable catalog、owner 隔离、data-only descriptor 默认拒绝 legacy getPrompt、SQLite unique constraints/migration、receipt/outbox lease 状态机、每个 crash cut point、JSON/JSONL projection 重放/去重、attachment journal、欢迎页 creation event、队列 publish 顺序/单次落消息/revision/CAS/fingerprint/restart_dropped/FIFO、RPC schema 的定向测试；公共接口变化后执行相关 package typecheck。
    - Web：运行 slash/suggestion、编辑器 parts 序列化/粘贴/同 URI 的 ref+text 区分、submit unknown 与 authoritative reject、草稿/历史、队列 CAS conflict、Quick Input Esc、Welcome receipt 恢复、消息引用渲染与复制等逻辑测试。纯样式只做三个入口的人工视觉检查，不为视觉仪式性新增测试。
    - 人工验收覆盖欢迎页、已有会话、Quick Input 的空闲/流式/有草稿/失败/窄宽度/无 workspace/禁用插件场景，以及键盘、IME、undo/redo、800ms 双 Esc、附件溢出和队列暂停。
    - 最后用 `rg` 确认生产代码/prompt 不再注册 `$`、`%`、旧 `/skill` 触发器或 `hero/compact` 分支，并确认 renderer 不再调用 `navigator.clipboard.writeText`；删除迁移产生的 orphan imports/components，再执行 `git diff --check`；不运行与改动无关的全量测试。

## Key decisions & tradeoffs

- 三个入口共享同一套编辑器能力和视觉几何，但通过 context adapter 暴露真实能力；欢迎页不会伪造会话上下文、历史、队列或 `/compact`。
- `/` 是技能、插件和动作的唯一发现入口，`@` 专注 Agent/文件；规范 URI 是持久化/复制标识，持久化 message ref part 才是执行授权。硬切换能删除多套解析分支，代价是消息 schema 需要保留 parts metadata，旧 `$`、`%`、`/skill` 文本不再调用能力。
- 保留用户锁定的 `lume-skill://pluginId:skillSlug` 外形，但使用大小写敏感、component 编码的自定义 lexer 而非标准 URL authority；代价是所有入口必须复用协议模块，不能随手 `new URL()`。
- 用户消息保留 URI，模型输入只剥离被结构化授权的 URI 并注入 SDK executor 生成的受控上下文；这样历史可复制/编辑且粘贴日志不会天然授权，代价是发送边界必须校验可见正文与 refs 一致。
- 插件整体引用覆盖同插件的具体技能引用，支持多引用但不重复注入；无效引用 fail closed，不能悄悄以普通文本执行。
- 普通 skill URI 继续使用 slug，由 runtime 唯一优先级 resolver 选择 winner 并拒绝同级歧义；这保持协议简洁，但被遮蔽的同 slug skill 不能从 composer 单独引用。
- desktop 无 workspace 时 skill refs 明确不可调用，即使 standalone SDK 在显式 cwd/roots 下可调用全局 skill；这是用户锁定的入口规则，必须由 sidecar gate 强制而不是只在 UI 隐藏。
- 一个主按钮根据运行态和 payload 在发送、停止、排队间变化；有待发送内容时鼠标主动作优先排队，停止仍可通过清空 payload 后的按钮或双 Esc 完成。
- 提交采用短锁、持久 submission receipt、attachment lease 和成功后清空，避免失败丢稿、sidecar 崩溃/响应丢失后的重复发送及附件泄漏；代价是 sidecar 需要最小 receipt/lease journal 与查询 RPC，但不持久化完整队列。
- 队列严格 FIFO，revision/CAS 防止 UI 与 worker 竞态，失效队首暂停而非自动跳过；这保护上下文顺序，但冲突时需要用户基于最新 snapshot 重试编辑。
- 队列保存当前运行周期内的完整快照，不做跨重启持久化；避免本次引入恢复 schema、过期附件清理和启动时重放语义。
- pending attachment 使用独立紧凑视图，已发送附件保持原样；避免为输入态优化意外改变历史消息布局。
- 使用现有 TipTap、Lucide、marketplace asset、shadcn/global 原子和 IPC，不增加依赖。
- 实施按后端安全契约、共享 UI、队列事务三个里程碑推进，但只在最终切换点删除旧触发器；中间态不作为带兼容承诺的发布版本。
- 新 composer submission 用 `node:sqlite` 事件/receipt/outbox 作为唯一接收事实，现有 JSON/JSONL 是可重放投影；这增加一个小型持久化模块，但比在多个文件写入间伪造原子性更安全，也不要求迁移全部历史消息。

## Risks / open questions

- 当前工作树已有与 SDK skill 热刷新、prompt、消息 renderer 等重叠的用户改动；实施必须先重新核对 diff，并把协议改造叠加在这些行为之上。没有剩余产品决策，但存在合并冲突风险。
- 欢迎页当前没有 threadId，而 project 文件搜索接口可能依赖 threadId；实现需要复用 FileRef 授权增加窄的 threadless project search，或让现有搜索按 workspace binding 工作，不能为搜索预建并遗留线程。
- 插件 logo 可能缺失、损坏或 URL 不可加载；所有位置必须一致回退 `Package`，并继续使用现有 marketplace asset 安全边界。
- TipTap 自定义 node、纯文本 URI、历史 draft JSON 与消息 Markdown 之间存在多个序列化入口；若只迁移发送路径，会导致编辑/复制/重发丢失 canonical ID，因此验收必须逐入口覆盖。
- 新增 message parts metadata 必须与现有纯字符串 `AgentMessage.content` 双写一致：字符串用于现有 renderer/搜索，parts 是授权与精确恢复的权威来源；旧消息没有 parts 时只按文本展示，不能获得执行权。
- 当前队列公开类型只有 `text`，编辑动作会先移除原项；扩展完整快照、revision/CAS 和 update/pause API 会触及 shared/sidecar/web 公共契约，是本任务最高风险的接口变化。
- hard cutover 后历史消息中的 `%plugin` 可能从旧插件 chip 退回普通文本，这是明确接受的兼容性损失；canonical URI 历史消息仍需稳定展示不可用状态。
- 欢迎页线程创建和附件保存目前跨多个 IPC；新的 orchestration/creation token 与 attachment lease 必须在响应丢失、并发窗口和重复 submission 下证明不会误删或重复提交。
- 真实 focus 管理、Suggestion portal 与双 Esc 监听都涉及 document/window 生命周期；需要验证 Quick Input 与主窗口不会重复注册或互相停止错误线程。
- 进程级 skill registry 隔离可能揭示既有热刷新/所有权测试依赖全局 Map；应在里程碑 A 先完成并发回归，不能把隔离问题留到 UI 切换后。
- capability context 的 byte/token 双预算必须复用现有模型上下文估算；估算不可用时按更严格的 byte 上限 fail closed，不允许悄悄截断 Skill 指令。
- receipt 与 lease journal 虽然是最小持久状态，仍需复用现有数据库事务/存储抽象并定义 bounded cleanup；不能另建无人维护的 JSON 文件或把用户正文写入去重表。
- 新 submission SQLite 必须纳入现有 data-management 导出/删除、线程删除与 workspace 清理语义；projection lag 需要可见诊断，且不能让同一 message ID 在 JSONL/version store 中重复出现。

## Out of scope

- 旧 `$skill`、`%plugin`、`$plugin:skill`、`/skill` 文本的兼容解析、历史批量迁移或草稿自动改写。
- 消息队列内容跨 app/sidecar 重启恢复、过期队列自动重放或后台同步；仅持久化最小 receipt/lease ownership 以去重、标记 `restart_dropped` 和安全清理附件。
- 新增最近使用、收藏、固定分组、拖拽自定义 `/` 面板排序或插件快捷入口。
- 改造已发送附件卡片、消息版本历史、Agent 头像/重写交互或右侧文件预览体验。
- 移动端专用布局；仅保证桌面主窗口和 Quick Input 的窄宽度可用性。
- 新插件 logo 上传/编辑功能、远程图片代理、品牌图标库或新的 UI/编辑器依赖。
- 改变 `@project/...`、`@session/...` 文件引用协议本身；本计划只把它们接入统一编辑器和入口可用性规则。
- 全量设计系统重构、全仓 lint/typecheck/test、无关死代码清理或提交/发布操作。
- 把历史 thread/transcript/version 全量迁入 SQLite；本次只让新 composer submission event 成为事务 source，并向现有文件格式做幂等投影。

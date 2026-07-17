# Plan: 消息中的文件路径用户体验优化
_Locked via grill — by Codex + user_

## Goal

把消息中的文件路径从前端猜测升级为明确的 Agent 输出协议：Agent 在主回复、子 Agent 回复和计划 Markdown 中使用行内代码形式的 `@project/<relative-path>` 或 `@session/<relative-path>`，可附带 `#Lx` / `#Lx-Ly` 行范围。Web 端将协议引用渲染为紧凑、带文件类型图标的可交互引用，安全映射到现有 `FileRef`，支持右侧预览、源码定位高亮、目录定位、跨平台右键动作、复制时去除内部协议，以及缺失或越权后的明确失效反馈；保留现有旧版会话相对路径的有限兼容。

## Approach

1. **定义并注入唯一的 Agent 文件引用协议。**
   - 在动态运行上下文中加入一段简短、可测试的文件引用规则，并带上本次运行真实存在的 `projectRoot` 与 `lumeWorkDir`：项目根目录内路径输出为 `` `@project/<relative-path>` ``，会话文件上下文内路径输出为 `` `@session/<relative-path>` ``。
   - Agent 必须使用 `/`、去掉根目录绝对前缀，只引用已知位于这两个根目录内的目标；文本/源码可追加 `#L42` 或 `#L42-L48`；目录以 `/` 结尾。主 Agent 与 minimal prompt 的子 Agent 都通过动态上下文收到同一规则，不把协议注入用户消息、工具结果或网页内容。
   - 不在 prompt 中教 Agent 使用显式 Markdown 链接；前端仅为兼容人工/旧输出额外接受 Markdown link 的目标为协议引用。
   - 在逻辑 run 创建时（不是每次 provider attempt/retry）生成一次不可变 `fileReferenceBinding` 快照：创建时的 `workspaceSlug`、sidecar 计算的 canonical project-root fingerprint 与稳定 `fileContextId`。它不包含绝对路径；同一快照传给所有 retry/attempt、派生子 Agent、streaming runtime event、主/子 Agent message view、plan preview，并原样写入最终 assistant 消息，保证整个逻辑回复与落盘前后的语义一致。旧消息不回填。
   - `@project` 的每次验证、读取、预览 scope、绝对路径解析、系统打开、定位和另存为操作都必须携带 expected project-root fingerprint，sidecar 在实际文件操作时重新比较；绑定已改变时禁用引用，不能出现“先验证旧根、后续操作落到新根”的 TOCTOU。`@session` 的每次操作同样携带 expected `fileContextId`，且必须等于当前线程的 file context。

2. **把现有路径猜测函数收敛为纯解析协议。**
   - 扩展 `thread-file-links.ts`，返回结构化结果：来源 `project | session | legacy-session`、规范化相对路径、是否目录、可选 1-based 行范围、原始协议引用和用于复制的无前缀路径。
   - 严格协议只接受 `@project/`、`@session/`，拒绝空路径、绝对路径、NUL/控制字符、`.`/`..` 段、越界行号和超长输入；只把末尾未转义的 `#Lx` / `#Lx-Ly` 当作行锚点，目录不得带行锚点。
   - 路径按 UTF-8 URI segment 编码定义：`/` 是唯一预解码分隔符，严格引用拒绝原始 `\`；解析器先按原始 `/` 分段，再逐 segment 严格 decode 一次，随后拒绝 decoded `/`、`\`、NUL/控制字符、`.`/`..` 和仍形似 `%xx` 的二次编码序列，且下游永不再次 decode。显式 Markdown link 的 href 还必须编码空格。真实文件名若以 `#L42` 结尾，用 `%23L42` 表达。反斜杠转 `/` 只保留在 legacy-session 解析器中。
   - 显式前缀允许空格、点文件、无扩展名文件和目录，不再依赖扩展名判断。
   - 保留当前旧版识别规则作为 `legacy-session`：无前缀、至少两段、有安全扩展名的行内代码仍按会话文件解析；不扩大旧版猜测范围，并在提示中标注旧版语义。
   - 为协议解析、严格反斜杠拒绝、`%2F`/`%5C`/双重编码拒绝、旧版 Windows 分隔符规范化、行范围、目录、点文件、非法穿越、外部绝对路径和旧版兼容写纯函数测试。

3. **建立复用的消息文件引用组件，而非继续堆叠 MarkdownCode 条件。**
   - 从 `MarkdownCode` 中提取一个消息专用 `AgentFileReference` 组件；行内 code 与显式 Markdown link 共用它，fenced code 永不解析。
   - Markdown 渲染器接收消息级 `fileReferenceBinding`，而不是只读取当前线程全局环境，并构造独立共享类型 `GuardedFileRef`：project guard 包含 `workspaceSlug + expectedProjectRootFingerprint + consumerThreadId`，session guard 包含 `consumerThreadId + expectedFileContextId`。旧版引用继续走现有 legacy conversion；普通文件树仍使用不带 guard 的 `FileRef`。
   - 组件复用 shadcn `Button` 与现有 `FileTypeIcon`：隐藏协议前缀；短路径完整显示，长路径压缩为末两段并加前导省略号；行号显示为独立弱化标签；title/可访问名称包含来源、完整路径和行范围。
   - 点击时调用统一打开回调并等待结构化结果 `opened | superseded | not_found | out_of_scope | binding_changed | unavailable | io_error`。只有 `not_found`、`out_of_scope`、`binding_changed` 这类确定性结果把本条消息内引用切换为失效样式；临时 IPC/I/O 故障只 toast，不永久标红。重新点击会重新校验，允许文件恢复后重新打开。
   - 流式 Markdown 在行内 code 闭合前保持现有 incomplete rendering；不为半截协议访问磁盘。

4. **扩展现有打开链路，按签名 FileRef 导航文件或目录。**
   - 将 `onOpenThreadFile` 的现有兼容入口扩展为返回结构化导航结果并接受可选 `FileRef`、消息 binding 快照、目录提示和行范围；附件调用保持不变，新协议引用直接传已构造的 `FileRef`。
   - 新增一组窄的、消息专用 guarded FileRef RPC/IPC，guard 在 schema 中必填；不得把 guarded 引用复用到“guard 可选”的普通 FileRef endpoint，避免漏传时 fail-open。sidecar 复用 `resolveAuthorizedFileRef`，但在每次操作中先根据 `consumerThreadId` 读取当前线程元数据：project guard 必须同时匹配当前 thread workspace 与 canonical project root fingerprint，session guard 必须匹配当前 thread 的 `fileContextId`，随后才解析目标。
   - guarded validation/operation 返回或抛出稳定 code `NOT_FOUND / OUT_OF_SCOPE / BINDING_CHANGED / UNAVAILABLE / IO_ERROR`；缺少 guard 直接 schema 拒绝，不把所有 RPC 或 I/O 错误伪装成“文件不存在”。
   - `AgentView` 为每个线程维护单调导航 revision：每次点击先占用新 revision，再异步验证；旧 validate 或目录 reveal 晚返回时只能结算为 `superseded`，不得覆盖较新的导航，也不得把引用标成失效。
   - 验证成功后，文件进入右侧文件 Tab；目录激活右侧 Files 功能并发起目录 reveal。
   - 把右侧文件 Tab 目标显式建模为 `plain FileRef | GuardedFileRef`；消息打开的 Tab 必须保存完整 mandatory guard，使后续预览、刷新、context menu、系统打开和复制绝对路径都无法退化成普通 FileRef。Tab 另存可选行选择与递增导航 revision；重复点击同一文件的新行范围更新现有 Tab，无行范围打开则清除旧 `lineSelection` 并递增 revision。
   - 给文件工作区增加 `{ requestId, navigationRevision, ref }` 形式的一次性 reveal 请求。runtime-only reveal coordinator 用 requestId 注册 Promise；`UnifiedFileTree` 逐级加载并展开祖先目录、选中并滚动后显式结算成功/失败。卸载、线程 binding 改变、新请求覆盖或超时都必须清理 registry 并以 `superseded` 或临时失败结算，不能留下悬空 Promise。
   - 分叉线程创建新的 file context 后，不复制源会话文件，也不重写继承消息的 session binding；渲染时发现消息快照的 `fileContextId` 与新线程不一致，`@session` 明确显示“来自原会话，当前分叉不可用”。项目引用只在 workspace/root fingerprint 仍一致时继续有效。

5. **在源码预览中实现可靠的行定位与范围高亮。**
   - `RightPanelFilePreview` 只把行范围传给 text/source 模式；Markdown 渲染模式收到行范围时切到源码模式。图片、HTML 增强视图及 unsupported 类型忽略行范围并保留现有预览/系统打开提示。
   - `RightPanelSourcePreview` 给每行稳定的 1-based 标识和 ref；内容及高亮 token 就绪后，根据 navigation revision 滚动到起始行，并用主题变量高亮目标范围。重复定位同一范围仍生效。
   - 行号超过当前可读内容（包括 512 KB 截断之外）时显示清晰提示，不把其他行当作回退目标。
   - 对范围归一化、同 Tab 重定位和目标行渲染添加定向测试，不引入编辑器集成或新预览依赖。

6. **统一图标和文件引用右键菜单。**
   - 扩充现有全局 `FileTypeIcon` 的缺失映射：Office 文档、演示、表格、常见源码/配置、媒体、压缩包和目录；继续使用现有 lucide 图标与颜色，不增加品牌图标依赖或手写业务页控件样式。
   - 为协议引用的上下文菜单增加“复制协议引用”；文件保留复制相对路径、复制绝对路径、系统打开、文件管理器定位和另存为。目录只保留适用的打开、定位与复制动作，隐藏依赖 `copyFile` 的“另存为”。
   - 新协议动作只调用 mandatory-guard 的消息引用 IPC：guarded read/stat/resolve/open/reveal/save-as/create-preview-scope。Electron main 原样转发 guard，sidecar 在每次解析时复核；文件树等当前绑定下产生的普通 FileRef 继续走原 endpoint，不允许两类调用自动互转。
   - guarded preview scope 不把首次解析出的绝对路径当作五分钟内持续有效的能力；scope 保存 `GuardedFileRef`，每个 `lume-file` 请求都回到 sidecar 重新验证 binding 并解析当前目标，失败即返回 forbidden/not-found 并撤销 scope。普通文件树 preview scope 保持现有行为。
   - 把共享菜单硬编码的“在 Finder 中显示”统一为“在文件管理器中显示”，使消息引用、附件、文件树和预览区文案一致。

7. **让所有复制入口输出完整、可移植的用户文本。**
   - 原始持久化消息保持协议字符串不变，历史重渲染仍可恢复交互。
   - `getAssistantCopyText` 在去除 afterglow 后，把协议行内引用转换为无内部前缀的完整相对路径并保留 `#L…`；显式 Markdown link 的 href 同样去除协议前缀。
   - 选区复制继续复用 `SmoothText` 的 copy 拦截：阻止原生 copy，把引用节点替换为 `data-file-reference-copy-text` 中的完整无前缀路径，再将规范化纯文本交给 `writeClipboardText`；失败时显示反馈，避免复制 UI 的省略路径或行号标签重复文本。
   - 所有剪贴板写入（包括选区复制）都使用 `writeClipboardText`，不得使用 `event.clipboardData.setData` 或 `navigator.clipboard.writeText`。

8. **定向验证且保持改动可审阅。**
   - 更新消息文件引用 SSR/组件测试，覆盖 project/session/legacy、类型图标、紧凑标签、行号、目录、失效态、percent encoding/单次 decode、显式 Markdown link、选择复制和整条回复复制。
   - 更新 Agent prompt/context 与 runtime projection 测试，证明真实 project/session 根被注入，主/子 Agent 获得同一协议，run-start binding 在 streaming、plan preview 和最终持久消息间保持同一值，并且 prompt 不鼓励外部绝对路径。
   - 更新右侧文件状态、guard 缺失 schema 拒绝、guarded/plain endpoint 隔离、Tab guard 保留、preview scope 每次请求复核、重绑 TOCTOU、分叉 session 引用失效、并发 latest-wins、目录 reveal completion/cleanup、结构化验证错误、无锚点清除旧高亮、源码行定位和目录菜单能力测试；只运行这些受影响测试以及必要的 web/sidecar 局部 typecheck，最后执行 `git diff --check`。
   - 不触碰当前工作树中与本任务无关的 Reading、sidebar、image generation 等用户修改。

## Key decisions & tradeoffs

- 文件归属由 Agent 的 `@project/` / `@session/` 协议明确表达，前端不在多个根目录中猜同名文件；代价是模型必须遵循输出约定，因此 prompt 与解析器契约测试都不可缺少。
- 协议只在行内 code 中作为规范输出，显式 Markdown link 只是兼容入口；普通正文、fenced code、用户消息和外部工具内容不获得本地文件访问语义。
- 协议路径可表达点文件、无扩展名和目录；安全性来自明确来源加现有 sidecar `FileRef` 授权，而不是靠扩展名过滤。
- 点击时延迟校验，避免流式消息渲染触发 N 次磁盘访问；代价是缺失状态首次点击后才显现。
- logical-run snapshot 与强制 `GuardedFileRef` endpoint 使 streaming 和历史引用不会因项目重绑或漏传 guard 静默指向另一目录；代价是为 runtime event/消息增加可选元数据，并建立与普通文件树明确分离的消息文件 IPC，但无需迁移旧记录。
- 用户界面隐藏内部前缀并压缩长路径，但所有复制入口必须提供完整无前缀路径；右键菜单额外提供精确协议引用。
- 行范围只驱动内置源码预览的滚动与高亮，不承诺跳转外部编辑器，也不为 PDF/Office 新增预览能力。
- 旧版无前缀路径维持当前狭窄的会话文件兼容，避免历史消息突然失效；新消息不得继续依赖该猜测。
- 图标复用并扩充现有 `FileTypeIcon`，不新增依赖，也不引入完整技术品牌图标库。

## Risks / open questions

- 模型仍可能漏写或写错前缀；此时内容会保持普通代码或在点击后显示失效，不做危险的自动纠正。
- 工作区项目绑定在消息生成后发生变化时，新消息的 binding fingerprint 会使旧 `@project` 明确失效；没有该快照的历史消息只享受原有 legacy-session 兼容，不尝试猜测旧 project 根。
- 分叉线程不会继承源 file context；复制过来的 `@session` 引用会明确失效而不是继续访问源线程文件，这是隔离优先于历史链接可用性的取舍。
- 目录 reveal 需要逐级加载懒加载树，深目录会产生多次顺序 IPC；应限制段数/总长度并在绑定改变时取消旧请求。
- 大文件只读取前 512 KB，行锚点可能落在截断区外；实现必须提示不可定位，不能误高亮最后一行。
- 显式 Markdown link 的第三方 renderer 可能过滤自定义 href；自定义 `a` 组件需要在导航前截获协议，且绝不能把它交给浏览器外链逻辑。

## Out of scope

- 普通正文路径扫描、跨根目录模糊搜索、自动修复错误路径或同名文件回退。
- 项目/会话授权根之外的任意本地绝对路径与 `file://` 引用。
- VS Code、JetBrains 或系统编辑器的行号深链集成。
- PDF、Office、音视频等新的内嵌预览引擎，以及二进制文件行号。
- 历史消息批量改写、消息 schema 迁移或把 UI 失效状态持久化。
- 运行时遥测、解析失败计数或把本地路径写入诊断日志；协议合规由定向测试和可见 UI 反馈验证。
- 用户消息、思考过程、命令输出、网页抓取内容和其他工具原始结果中的协议解析。

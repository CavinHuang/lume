# Plan: 将 Lume 项目绑定为 Agent 的真实工作目录
_Locked via grill — by Codex + user_

## Goal
把当前仅用于分组和内部存储的“工作区”产品语义改为“项目”：每个项目绑定一个真实、唯一的本地目录，项目会话及其所有子 Agent 直接以该目录为工作目录；未选择项目时创建普通会话，并使用 Lume 管理的会话树工作目录。用户在首页、Agent 面板和右侧文件面板中始终能感知当前 Agent 的工作位置，同时继续访问附件、计划和临时产物等 Lume 协作文件，且升级、移除项目或目录失效时绝不误删、误写用户的真实目录。

## Approach

1. **先建立可迁移的数据模型与路径解析器。**
   - 在 `packages/shared/src/types/agent.ts` 的 `AgentWorkspace` 上增加可选的 `projectPath` 与 `realpathKey`：前者保存供展示和访问的绝对路径，后者保存目录最后一次可访问时得到的规范化真实路径键。旧记录没有 `projectPath` 时即为“未绑定目录”的迁移项目；目录可用性是运行时派生状态，不持久化易过期的布尔值。目录暂时不可用时仍用持久化的 `realpathKey` 参与判重，重新定位成功后原子更新两者。
   - 在 `AgentThreadMeta` 增加稳定的文件上下文标识（例如 `fileContextId`）：根会话创建时取自身 ID；系统创建的子 Agent 继承根会话树的标识；用户主动分叉创建新标识。旧线程缺失时回退为自身 ID，避免破坏或合并既有文件。线程创建 API 必须接收显式的 `fileContextMode: newRoot | inherit | fork`（或等价的判别联合），禁止继续从 `parentThreadId` 猜测文件上下文。
   - 新增单一的服务端路径解析入口，返回 `{ agentCwd, lumeWorkDir, projectRoot?, fileContextId }`。项目会话的 `agentCwd` 是项目真实目录；普通会话的 `agentCwd` 与 `lumeWorkDir` 相同；子 Agent 解析到主 Agent 的同一个 `lumeWorkDir`。
   - 新建的 Lume 工作目录从项目目录结构中解耦，放入按 `fileContextId` 管理的全局内部目录，确保移除项目时无需搬动用户产物。旧 `agent-workspaces/<slug>/threads/<threadId>` 采用惰性、一次性迁移或兼容回退读取，迁移只发生在 Lume 内部目录，失败时保留原数据并报错，不做半迁移。
   - 真实目录必须存在且为目录；用 `realpath`/规范化绝对路径做唯一性和访问边界判断，Windows 比较大小写不敏感。允许父子目录分别成为项目，但同一路径（含符号链接、junction 的同一真实目标）只能绑定一次。为已存在目标统一校验目标 realpath；为新建/移动目标校验最近已存在父目录的 realpath，再拼接并复核，不能只做 lexical `resolve`/前缀判断。
   - 将 workspace index 与 thread index 的所有读改写收口到同一个序列化 mutation service。该服务使用进程内队列并以原子创建 lock file（含 PID/时间戳、过期锁恢复、有限等待）覆盖可能的多 sidecar/CLI 进程；持锁后必须重新读取最新索引、重新执行 `realpathKey` 唯一性/引用条件，再原子写入。创建、绑定、重新定位、移除项目以及创建/移动/永久删除线程都不得绕过该入口。

2. **把项目创建、重命名、失效恢复和移除做成明确的领域操作。**
   - 扩展 sidecar workspace/project manager、RPC schema、shared IPC 类型和 web desktop API：创建项目必须传目录，名称由目录 basename 初始化；再次选择已绑定目录时返回已有项目而不是重复创建。
   - 保留显示名称重命名，重命名不改变目录。目录仍可访问时禁止更换；仅当原目录缺失/不可访问时允许“重新定位”，并再次执行目录存在性、唯一性和真实路径校验。
   - 重新定位、首次绑定旧项目、项目解绑为普通会话前，调用可等待的 `stopAndDrainProjectRuntimes(projectId)`（或等价服务）：发出 abort 后等待所有主/子 Agent、后台 delegation、工具调用和 interruption/continuation 进入终态，超时则整个领域操作失败且不改路径/索引。drain 成功后再清除受影响线程的 runtime/SDK resume 标识，并通过专用 runtime invalidation 服务安全删除/归档 runtime-core session transcript、continuation 与 interruption 状态。`run.ts` 的 resume 判断必须受该失效操作约束，确保 cwd 变化后绝不会恢复旧目录上下文。历史可见消息与 Lume 工作目录不迁移。
   - 将用户动作命名为“移除项目”。真实项目目录在任何分支都不执行删除、移动或清理。确认框提供两种明确结果：
     1. 仅移除项目：解除项目关联，项目线程转为普通会话，保留历史和 Lume 工作目录；
     2. 同时删除 Lume 用户数据：先清除线程的 `workspaceId`，再进入现有回收站；Lume 工作目录保留到清空回收站时才删除，项目级记忆、技能、MCP、索引等内部元数据立即移除。若用户在清空前恢复线程，则恢复为不绑定项目的普通已归档会话，继续使用原 `fileContextId`，不恢复已删除的项目元数据。
   - 移除确认框列出引用该项目的 Automation、IM 账号与 IM thread binding 数量。Automation 引用必须同时按 `job.workspaceId` 和 `job.threadId -> thread.workspaceId` 计算；所有受影响 job 都禁用并记录“项目已移除”原因，禁止自动改成普通会话继续执行原项目任务。清空 IM account 的 `workspaceId` 但保留账号连接。
   - IM thread binding 按移除模式执行互斥硬规则：“仅移除项目”必须先把对应线程成功转换为普通会话，然后才保留其 binding；“同时删除 Lume 用户数据”必须先清除/禁用所有指向受影响线程的 binding，然后才允许把线程送入回收站。binding 清理失败则整个删除数据操作终止，不能留下可向 trashed/permanently-deleted thread 路由消息的记录。相关配置变更与项目移除放在同一可重试领域操作中；若无法完成，项目索引不删除。
   - 移除前完成 awaited runtime drain 并释放 workspace MCP manager；先确保每个线程的 `fileContextId` 与 Lume 工作目录可独立解析并完成 runtime invalidation，再清除 `workspaceId` 或送入回收站，最后移除项目索引/元数据。批量更新采用可恢复顺序，任何失败不得留下指向已删除项目的活跃线程、Automation job 或 IM account。

3. **让运行时真正使用项目目录，同时保留 Lume 工作目录。**
   - 修改 runtime attempt 的准备阶段，不再把 `~/.lume/agent-workspaces/<slug>/threads/<id>` 固定为项目 cwd，而是调用统一解析器。
   - 将 `agentCwd`、`lumeWorkDir` 与 `projectRoot` 一起传入 runtime、context assembler、`agent-prompt-builder.ts`、拆分后的 prompt sections、工具运行时、权限配置和 workflow hook。删除所有硬编码 `~/.lume/agent-workspaces/<slug>` 的工作/线程路径描述；系统上下文只使用解析器给出的真实值，并明确标出 `<working_directory>` 与 `<lume_working_directory>`，两者相同时只表达一次普通会话语义。
   - 项目会话的 shell、编辑和普通文件工具以真实项目目录为 cwd；把 Lume 工作目录加入受控的 additional directory/允许根，使主 Agent 与子 Agent 均可访问同一文件上下文。删除首页临时目录附加后，同时删除 `AgentSendInput.attachedDirectories`、context brief、runtime 参数和仅服务该能力的任意目录授权；移除或严格下线 `LIST/OPEN/SHOW/RENAME/MOVE_ATTACHED_*` 这组无根绝对路径 RPC，不能只隐藏 UI。
   - 为系统管理输出提供显式的 `filesRoot`、`plansRoot`、`artifactsRoot` runtime/tool 参数，并把附件保存、PlanWrite、图片/文档等内置产物工具的默认输出强制定向到 Lume 工作目录对应子目录；不要依赖 prompt 猜测路径。项目会话的 shell/编辑工具仍按 cwd 语义写项目目录，因此“默认进 Lume”的保证只覆盖 Lume 管理的附件、计划和内置产物工具，任意 shell 命令的相对输出属于项目修改。普通会话 cwd 即 Lume 工作目录，所有相对输出自然落入其中。
   - 子 Agent 创建时使用 `fileContextMode: inherit` 并显式继承父线程的 `fileContextId` 和项目 ID；用户分叉使用 `fileContextMode: fork` 生成新的 `fileContextId`；首页、Automation、IM、CLI 根会话使用 `newRoot`。不要仅靠 `parentThreadId` 推断，因为现有字段同时表示子 Agent 和用户分叉。
   - 每次运行开始都重新验证项目目录。目录不可用时返回结构化错误并保持历史可读；自动化记录失败原因，IM 向对应会话返回可理解的失败消息，CLI 非零退出，所有入口都禁止静默退回内部 cwd。

4. **重构文件服务为两个清晰、安全的根。**
   - 现有 thread 文件 API 改为通过 `threadId -> fileContextId -> lumeWorkDir` 解析，不再要求普通会话伪造 workspace slug；`fileContextId` 是解除 `workspaceId` 后读取历史附件和文件的权威键。保留必要的兼容参数，逐步删除仅为旧目录定位存在的分支。
   - 为真实项目目录只提供受边界约束的 list/read/preview/open/show/search API。所有相对和绝对目标都必须经共享 realpath resolver 证明位于规范化项目根内；对新目标/移动目标做父 realpath 校验，处理 symlink/junction 逃逸，不能复用当前不设根边界的 attached-directory 操作。
   - 右侧项目文件面板不提供 delete/rename/move/save 等直接突变 API，避免绕过 Agent 权限系统。旧资源“导出到项目”使用单一、窄化的 copy RPC：源必须在 legacy resources 根、目标必须在项目根、冲突需显式选择。复制前逐段 `lstat` 源和目标父链并拒绝 symlink/junction/reparse point；递归复制的每个条目都重复检查，创建后再 realpath 复核最终目标仍位于项目根，失败时清理仅由本次创建且已验证位于根内的临时目标。项目图片预览通过有根校验的 sidecar 二进制读取接口提供，不直接放宽当前仅信任 `.lume` 根的 `lume-file://` 协议。
   - 新项目不再创建或暴露独立 `resources` 共享文件层。旧项目若检测到非空 `resources`，仅提供“旧工作区文件”只读来源以及显式导出到项目目录的操作；禁止新写入，清空/导出完成后隐藏入口。
   - 项目级记忆、技能、MCP、bootstrap 与索引继续存放在 Lume 内部 workspace 元数据目录，并通过 workspace/project ID 关联；不自动在真实项目中创建 `.lume`。项目本身已有 `.lume`/`.alice` 技能目录时继续加载，但 `workspace-skill-editor-service.ts` 及 RPC 不再接受调用方传入任意 `cwd` 作为项目技能写入根：必须由服务端根据 workspace/project ID（或 threadId）解析已绑定项目路径，再执行边界校验。
   - 不把真实项目目录自动加入 plugin executable roots。当前 `run.ts` 基于 `input.cwd/.lume/plugins` 的发现逻辑在 cwd 改为真实目录后必须禁用；本次只加载 Lume 用户级/内部项目元数据中已安装的 plugins。项目内 `.lume/plugins` 的信任授权、签名或逐项目启用属于未来独立安全设计，不能因用户选择目录而静默执行代码/hooks。

5. **改造首页与全局项目选择体验，删除重叠能力。**
   - 在 `WelcomeView` 删除 `pendingFolders`、文件夹标签栏、`handleAttachFolder`、`attachedDirectories` 发送逻辑和“选择附加的项目文件夹”文案；保留普通文件附件。
   - `WorkspaceSelector` 的用户文案改为项目，并增加明确的“普通会话”选项。`currentWorkspaceId = null` 表示普通会话且同样持久化；启动时恢复上次选择，选择失效项目时显示状态而不是擅自改选。
   - “新建项目”直接调用系统目录选择器：取消不创建；选中后由 sidecar 创建或返回同目录已有项目，切换为当前项目。删除现有只收名称的创建弹窗及其仅服务该流程的 state/test；项目重命名继续复用侧边栏菜单。
   - 项目列表默认显示目录文件夹名生成的名称，允许之后重命名；必要处辅以真实路径和“目录不可用”状态。UI 新增/改造控件复用 `apps/web/src/components/ui` 的 Button、Dialog、Input、Dropdown 等原子组件。
   - 快捷输入选择器支持项目与普通会话；全局首页保持上次选择。项目分组内新建会话仍显式绑定项目。

6. **让 Agent 面板和右侧文件面板持续暴露当前文件上下文。**
   - Agent 面板标题区显示项目名和真实目录路径，并提供“在文件管理器中打开”；普通会话显示“普通会话 · Lume 工作目录”。路径缺失时显示不可用状态与“重新定位”。
   - 将右侧文件来源从含混的“线程文件/工作区文件”调整为“项目目录/Lume 工作目录”；项目会话默认项目目录，普通会话只有 Lume 工作目录。两者都解析主会话树共享的 `fileContextId`，因此打开子 Agent 面板看到与主 Agent 完全相同的文件上下文。
   - 对迁移项目按需增加只读“旧工作区文件”；现有 memory 深链预览能力保持，不把它包装成第三套可写目录。
   - 切换来源时清空不属于新根的 selectedPath/search 状态，防止拿旧根绝对路径调用新根 API。

7. **统一非首页入口与兼容层。**
   - 快捷输入、Automation、IM、CLI 的项目选择均复用同一项目可用性检查和线程路径解析；没有项目时创建普通会话及 Lume 工作目录。
   - CLI 创建项目要求目录参数并输出项目路径/状态；保留现有 `workspace` 命令/API 名作为兼容层，本次不进行大规模内部命名迁移。对缺少目录的旧调用给出明确错误，不自动创建隐藏项目。
   - 停止启动时自动创建可见“默认工作区”：枚举并修改 `workspace-bootstrap-state.ts`、`useWorkspaceBootstrap.ts`、`agent:ensure-default-workspace` handler、desktop/bootstrap 调用方、CLI/smoke 脚本与测试夹具。迁移期如仍需内部 default slug，只能由测试或显式兼容入口创建，不能出现在正常项目列表或让普通会话获得项目语义。
   - 项目目录状态变化、移除、重新定位后广播既有工作区/线程列表变更事件，让主窗口、快捷输入和设置页同步刷新。

8. **迁移现有数据并做小步清理。**
   - 旧 `AgentWorkspace` 无项目目录时原样保留名称、slug、线程、Lume 文件和项目级元数据，列表显示“未绑定目录”；可浏览历史，但发送、新建项目会话、Automation/IM 运行前必须绑定目录。迁移卡片同时提供“绑定项目目录”和“作为普通会话移除项目”两个明确动作；后者复用“仅移除项目”流程，把旧线程转为普通会话而不丢历史，消除无目录项目与普通会话之间的死胡同。
   - 旧线程目录迁移到新的 file-context 根时，为每个 `fileContextId` 获取独立的原子 migration lock，并在持锁后重新检查幂等版本 marker、源和目标；使用同卷 rename 或安全 copy+校验+marker 落盘，只有在锁内验证目标完整且 marker 已持久化后才删除旧源。并发调用看到完成 marker 后直接复用目标；冲突或失败时继续从旧路径读取且不删除源。已有子 Agent 旧目录不自动合并，以免同名覆盖；新创建的子 Agent 从此共享根目录，旧产物仍可通过原子线程的兼容路径访问/导出。
   - 文件上下文生命周期按索引引用计算，而不是按单线程删除：线程索引删除与“是否最后引用”的计算必须在同一个全局 index mutation lock 内完成；释放锁前再次读取/检查没有 active/archived/trashed 记录引用该 `fileContextId`，再把待删除目录原子 rename 到内部 quarantine 名称，释放锁后递归清理。创建线程也持同一锁，因此不能在最后引用检查与 quarantine 之间插入新引用。删除子 Agent 不得删除主 Agent 的目录；根线程先删、子线程后删也必须安全。回收站阶段不删除文件上下文。
   - 清理计划：删除仅被首页临时目录附加使用的 state、prompt brief 和 runtime plumbing；删除新流程不再使用的创建名称弹窗；保留 legacy resources 的只读读取/导出最小路径；不顺带重命名 `AgentWorkspace`、workspace slug、配置目录或无关 IPC。
   - 不新增依赖。

9. **按风险运行定向验证，不做仪式化全量检查。**
   - Sidecar：并发创建/重新定位同一 canonical path 只能成功一个；项目与线程索引跨进程锁的过期恢复；项目目录创建/持久化 canonical key/判重/不可用/重新定位限制；awaited runtime drain 超时不改索引；项目移除两种模式、直接/间接 Automation 禁用、IM 账号/绑定按模式处理及移除后的消息/附件读取；删除数据后收到同一 peer 的新 IM 消息不得命中 trashed thread，清空回收站后也不得存在 dangling binding；删除数据模式的线程在清空前恢复时必须成为保留原 `fileContextId` 的普通 archived session，且不得恢复项目元数据；未绑定旧项目转普通会话；普通与项目路径解析；显式 newRoot/inherit/fork 模式；创建线程与最后引用永久删除竞争时共享目录不丢失；同一 legacy 工作目录并发迁移只执行一次且失败回退；真实目录 existing-target/new-target/复制中途 symlink swap 的越界；项目技能 RPC 拒绝任意 cwd；真实项目 `.lume/plugins` 不被自动加载；attached path RPC 不再可用；Automation/IM 缺失目录失败。
   - Runtime：项目 cwd、普通会话 cwd、Lume additional directory、系统提示词不含硬编码旧路径、cwd 变化后 runtime transcript 确实不 resume、显式 files/plans/artifacts roots、Plan/附件/内置产物默认落点、子 Agent 完全共享文件上下文。
   - Web：上次项目或普通会话选择恢复；直接选目录创建；移除附加文件夹；目录不可用状态；Agent 路径展示；右侧来源默认值与切换时状态清理；旧 resources 只读入口。
   - CLI/shared：创建项目必须传路径、序列化新字段、旧 workspace 记录兼容解析。
   - 只运行上述受影响测试文件及必要的模块 typecheck；不运行全仓 lint/test。若实现只涉及某处文案/样式，不为该处单独补测试。

## Key decisions & tradeoffs

- **项目目录就是 Agent cwd。** 不再把选择的目录仅作为额外上下文，也不复制项目到 Lume 内部；代价是多个项目会话会直接并发操作同一真实文件树，这与项目语义一致。
- **双目录而非双重工作区。** 真实项目目录负责正式、跨会话成果；Lume 工作目录负责当前根会话树的附件、计划和临时产物。两者在 UI 和系统提示词中明确命名。
- **子 Agent 共享、用户分叉隔离。** 主/子 Agent 完全共享项目目录和 Lume 工作目录；用户分叉拥有新的 Lume 工作目录，避免对话分支互相污染。
- **项目元数据仍由 Lume 管理。** 记忆、技能、MCP 等不写入真实项目，避免创建项目本身污染仓库；已有项目本地技能仍按现有规则加载。
- **目录不可用时失败而非降级。** 保留历史但禁止运行，避免 Agent 在用户不可见的内部路径继续写入。
- **目录正常时不可更换。** 只允许失效项目重新定位，减少同一项目身份漂移；重新定位会中断 resume 连续性，以换取正确 cwd。
- **canonical identity 持久化。** 同时保存展示路径和最后可用的 realpath key，换取离线判重与安全恢复；目录重新定位后更新 key，但不尝试用内容指纹判断“是否同一仓库”。
- **移除项目不等于删除真实文件。** “保留会话”是非破坏解绑；“删除 Lume 用户数据”也只进入现有回收站并清理 Lume 元数据。
- **废弃新 resources 层。** 项目目录已经承担跨会话共享；仅为旧数据保留只读出口，避免长期维护第三套可写空间。
- **保留内部 Workspace 命名。** 用户界面统一叫“项目”，代码暂留既有类型和 slug，控制 diff，不做与目标无关的重构。
- **全入口一致。** 首页、快捷输入、Automation、IM、CLI 共享同一目录契约，避免同一项目因入口不同获得不同 cwd。

## Risks / open questions

- 旧线程与旧子 Agent 的内部目录可能含同名文件，自动合并会破坏数据，因此计划明确不合并；实现时需要让旧产物仍有可发现的导出路径。
- 项目目录可能位于网络盘、可移动盘、junction 或权限会动态变化的目录。每次运行和文件操作都必须重新校验，UI 的可用状态只能作为提示，不能作为安全依据。
- 真实项目可能自带 `.lume/plugins`；本次明确不自动加载，以避免“选择目录”等价于授权执行项目代码。若未来支持，必须另做逐项目信任模型。
- 主 Agent 与并行子 Agent 完全共享文件树，可能产生写冲突。本次依赖现有任务分工和权限/工具并发约束，不引入锁、快照或自动合并系统；这需要在实现验证中覆盖至少一个并行可见性场景。
- 普通会话首次获得正式可写目录，会触达目前依赖 workspace slug 的附件、文件面板、图片预览和清空回收站路径，必须通过统一 file-context 解析器消除遗漏。
- 项目移除涉及项目索引、线程归属、MCP 生命周期和内部元数据多处状态，缺少事务存储；实现必须设计可重试顺序并在中途失败时保持可恢复。
- JSON 索引目前存在跨进程 read-modify-write 丢更新历史；本次用单一文件锁和持锁重读收口相关 mutation，但不把全项目持久化迁移到数据库。
- CLI/API 增加必填目录会影响现有脚本；保留命令名兼容，但调用参数属于有意的契约变化，需要明确错误和发布说明。
- 内置产物工具可以强制使用 Lume 输出根，但任意 shell 命令无法根据用户意图自动区分“项目修改”与“临时产物”；计划明确把项目 cwd 下的相对 shell 输出视为项目修改，不承诺透明重定向。

## Out of scope

- 不复制、初始化、克隆或删除用户的真实项目目录。
- 不支持一个项目绑定多个目录，也不支持目录正常时切换到另一个目录。
- 不实现项目文件版本控制、写锁、Agent 并发自动合并或快照。
- 不把项目元数据自动落盘到项目内 `.lume`，也不新增云同步或跨设备路径映射。
- 不大规模重命名 `AgentWorkspace`、workspace slug、配置目录、所有 IPC 常量和数据库字段。
- 不重新设计记忆、技能、MCP、权限或回收站产品，只让它们遵守新的目录归属。
- 不保留首页“临时附加目录”作为隐藏高级功能。

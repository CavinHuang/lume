# Plan Review Log: 为 Lume 构建独立、可维护的 LLM Wiki
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

## Act 1 — Locked decisions

- Wiki 是 Lume 内独立的统一知识区域，但入口位于 Lume 功能页，与「一起读书」「今日日程」平级。
- 工作区作为页面主要文件夹归宿；每页只有一个主要归属，可关联多个工作区，不复制页面。
- 写入以用户显式「导入/沉淀」为主，Agent 只提出建议；普通对话、读书和升级过程不自动摄入。
- 来源不可变，Wiki 可演化；事实、LLM 综合和用户批注明确区分。
- 用户确认收录后正常多页更新作为一个批次应用并可撤销；删除、冲突、低置信度与覆盖用户内容送审。
- 首版页面类型为 source/topic/decision/synthesis；链接和 frontmatter 表达关系，不引入图数据库。
- 用户可直接编辑 Markdown 正文；Agent 区与用户区分开，用户修改过的内容自动升级为受保护内容。
- Wiki 按需检索，默认当前工作区；跨工作区需显式范围，事实回答继续读取原始来源。
- 写后运行结构 lint，每周或空闲运行语义 lint；语义 lint 只生成待审核项，不自动搜索或改写。
- 本地单用户首版；多人协作与云同步不在范围内。
- Lume 原生提供完整 Wiki，Markdown 目录兼容 Obsidian Vault，可选一键打开 Obsidian，但不依赖它。
- 首版采用渲染阅读 + Markdown 编辑 + frontmatter 表单，不做块编辑器或 WYSIWYG。
- Memory 与 Wiki 只复用底层能力，数据隔离；双向流动都必须显式操作。
- 来源采用中央、content-addressed、去重和尽量快照化的存储。
- 删除工作区只归档 Wiki 归属，不删除知识；删除原聊天/笔记/资源也不级联删除明确沉淀的快照。
- Wiki 内搜索负责找页面；「向 Wiki 提问」打开普通 Lume 会话并附加范围。
- 首版不做原生交互式知识图谱，可用 Obsidian Graph 作为可选查看器。
- 桌面直接会话默认当前工作区可读；IM 私聊默认无授权，群聊/频道默认禁用，外部渠道不能静默写入。
- 不自动迁移现有数据，只增加一个导入动作及各来源的「沉淀到 Wiki」。
- 现有全局右侧面板只支持 agent thread；Wiki 使用功能页内可折叠 inspector，不扩大为全局面板重构。

## Review configuration

- PLAN_FILE=`PLAN-wiki.md`
- LOG_FILE=`PLAN-REVIEW-LOG-wiki.md`
- MAX_ROUNDS=5

## Act 2 — Reviewer setup

- Reviewer model: CLI default (config unpinned)
- CLI: `codex-cli 0.144.4`
- Sandbox: read-only

## Act 2 — Attempt 1 failed before Round 1 verdict

- Command: fresh `codex exec` session with `-s read-only`, JSON events, closed stdin, and a 10-minute ceiling.
- Result: timed out after 10 minutes with no verdict file and no captured `thread.started` event.
- Action: stopped without retry, as required by the skill timeout guard. `PLAN-wiki.md` remains the Act 1 locked plan and has not been modified by a reviewer.

## Act 2 — Resumed attempt 1 blocked before Round 1

- User explicitly requested continuation, so a fresh review session was allowed because the prior attempt produced no thread ID.
- `codex login status` reports `Logged in using ChatGPT`; CLI remains `codex-cli 0.144.4` with config-unpinned model.
- A two-minute read-only `PROBE_OK` exec with redirected stdin timed out before `thread.started` and produced no output file.
- A second probe using a native PowerShell EOF pipeline also timed out before any JSON event.
- Configured MCP servers were then disabled for the process with `-c mcp_servers={}`; the bounded probe still timed out before `thread.started`.
- Conclusion: non-interactive `codex exec` is blocked in the current environment before a review session can start. No review round was consumed and no plan changes were made. Further blind retries are prohibited by the skill.

## Fallback Review Round 1 — Independent read-only reviewer

The user authorized continuation with an independent read-only subagent after the prescribed Codex CLI path remained blocked.

1. **[严重] Agent 仍可绕过 Wiki 确认流程直接写文件。** 计划只是不暴露 `wiki.apply`，但现有 runtime 始终提供 `Write/Edit/Bash`，且 `bypassPermissions` 会在私有根判断前放行；模型若知道 Wiki 路径即可绕过 coordinator。
   **修复：** 把 Wiki 根加入不可被任何 permission mode 绕过的受保护域，覆盖 `Write/Edit/Bash/node-repl` 等所有通用入口，并用 `bypassPermissions` 集成测试证明只能经 Wiki coordinator 修改。

2. **[严重] 工作区 ACL 使用 slug 会发生身份复用和归档目录冲突。** 当前 slug 仅在现存工作区中去重，删除后可复用；新工作区可能继承旧 Wiki 授权，第二次归档也会撞目录。
   **修复：** frontmatter、ACL 和生命周期全部使用不可复用的 `workspaceId`，slug 只作展示；物理目录改为 `<workspaceId>-<slug>`，并保存名称/slug 快照。

3. **[严重] `inbox` 与必填单一 `primary_workspace` 数据模型矛盾。** 普通无工作区会话导入无法合法表示。
   **修复：** 明确定义 `primary_workspace_id: string | null`，`null` 即 inbox，并补齐 inbox 在搜索、授权、归档和重新归属时的规则。

4. **[严重] 外部渠道授权没有可信身份来源和持久化模型。** IM 私聊与桌面会话都可能表现为 direct；计划没有说明 ACL 存储、签发者和 renderer scope 防伪。
   **修复：** 在 sidecar 建立持久化 ACL store，由可信 thread source/IM binding 派生主体与 scope；工具层不信任客户端传入的 chatType、workspace 或 scope attachment。

5. **[严重] 单一 coordinator 无法处理多 sidecar 和 Obsidian 并发，恢复策略可能覆盖离线编辑。** 进程内单例不覆盖短暂多 sidecar 重叠；启动时盲目完成/回滚会覆盖停机期间的 Obsidian 修改。
   **修复：** 增加跨进程 mutation lock；每个替换及恢复步骤校验 before/after hash，第三种 hash 停止恢复、保护页面并送审。

6. **[高] Renderer RPC 的确认边界不够具体，可能成为任意写入口。** 若 RPC 接收草案或文件操作，受污染 renderer 可自行构造危险批次。
   **修复：** apply/resolve/undo RPC 只接收 `draftId + 一次性确认 nonce + expectedRevision`，从 sidecar 保存的不可变草案加载，绝不接受客户端路径、diff 或操作列表。

7. **[高] FTS5 方案没有中文分词策略。** 现有 desktop-context 已因默认 FTS 不适合中文而对 CJK 退化为 LIKE；直接承诺 Wiki 中文搜索性能不成立。
   **修复：** 探测 FTS5 trigram tokenizer，或生成确定性的 CJK n-gram 索引；验收包含中文短词、混合中英文、标题/alias 和性能。

8. **[高] 中央 content-hash 去重缺少来源级权限与 provenance 隔离。** 相同正文来自私聊、文件和公开网页时，合并 source metadata 会泄露原路径或消息 ID。
   **修复：** payload blob 可按 hash 去重，但 provenance record、授权范围和删除状态独立；`wiki.read` 对 provenance 逐条过滤。

9. **[高] 稳定 ID 与 Obsidian 路径链接模型不一致。** `[[path|title]]` 仍以路径解析，frontmatter ID 不会自动修复漏掉的入链。
   **修复：** 首版保持文件 basename 不自动变化，只改 title/aliases；若重命名则高风险全库扫描并验证零旧入链。

10. **[高] 工作区删除接入顺序无法满足承诺。** 当前 removeProject 在清绑定、转换/丢弃线程和删除内部数据后才有删除完成点，事后归档没有恢复边界。
    **修复：** 删除前先执行 Wiki preflight 和以 workspace UUID 标识的可恢复逻辑归档；成功后才进入现有 destructive sequence。

11. **[高] URL/文件夹导入缺少网络、符号链接和总量边界。** 单原件 25 MiB 没有限制重定向/私网、图片总量、文件夹总量、symlink/junction 或敏感 URL。
    **修复：** adapter 统一经过 SSRF/重定向检查、realpath containment、单文件/单批次/附件总配额，并清除 URL credentials 与敏感 query。

12. **[中] 周期性语义检查复用对象错误。** routine runner 是固定每日 8 点生成日程和一次性 activities，不是通用周期任务。
    **修复：** 使用启动/打开 Wiki 时的 weekly due-check，或明确复用 automation scheduler，不依赖 routine runner。

13. **[中] 聊天 provenance 未锁定消息版本。** 仅保存 thread/message/run ID 无法区分编辑重发版本和外部原消息。
    **修复：** manifest 记录 `messageId + versionGroupId + versionIndex`、可选外部 IM message ID、抓取时间和正文 hash。

VERDICT: REVISE

### Primary agent response

- **采纳 1、4、6：** 增加不可绕过的 Wiki protected-root gate、sidecar ACL store、可信主体推导以及只接收 draft ID/revision/一次性 nonce 的确认 RPC。对 Bash/node-repl 明确要求允许根沙箱；平台无法实现时 Wiki-scoped run fail closed，而不是靠字符串匹配。
- **采纳 2、3、10：** 所有归属与 ACL 改用 workspace UUID，slug/name 只作快照；`primary_workspace_id=null` 明确表示 inbox；project removal 在现有 destructive sequence 之前完成可恢复 Wiki preflight/archive。
- **采纳 5：** coordinator 增加跨进程 lease lock，恢复每一步校验 before/after hash，遇到第三种 hash 停止并送审。
- **采纳 7：** 搜索启动时探测 FTS5 trigram，不支持则建立确定性 CJK 2/3-gram 表；补充中文验收数据。
- **采纳 8：** 仅 content blob 去重，每次摄入的 provenance、ACL 和删除状态保持独立，读取逐 provenance 过滤。
- **采纳 9 并进一步简化：** 新增不变且全库唯一的 `file_key` 作为 Obsidian basename，链接使用 `[[file_key|title]]`；Lume 首版不自动重命名 basename。
- **采纳 11、13：** source adapter 增加 SSRF、realpath、配额和 URL 脱敏；聊天快照固定记录 Lume/IM 消息版本和正文 hash。
- **采纳 12：** 改为 weekly due-check，复用通用 automation job 或 Wiki 自有 due 状态，不耦合 routine runner。
- 没有拒绝项；以上均修正了现有代码事实或收紧了已锁定边界，没有改变用户确认的产品方向。

## Fallback Review Round 2 — Independent read-only reviewer

Reviewer confirmed that all 13 Round 1 findings were closed, then identified six remaining gaps.

1. **[严重] protected-root 的 fail-closed 降级会破坏普通编码会话。** 当前计划在平台无法实现 allow-root sandbox 时移除 Wiki-scoped run 的 Bash/node-repl，但桌面直接会话又默认获得当前 workspace Wiki scope；结果可能是 Wiki 一上线，普通 Agent 会话就静默失去核心编码工具。
   **修复：** 定义 capability matrix 和分阶段发布。在 allow-root sandbox 可验证前，只有 Wiki UI 与专用 Ask Wiki 只读会话获得 Wiki 能力，普通 Agent 不自动附加 Wiki scope；隔离验收后再开放普通会话默认当前工作区检索。未达标平台保持受限阶段，而不是删普通会话工具。

2. **[严重] 计划声称复用“现有 SSRF/重定向检查”，但当前 WebFetch 不是该安全边界。** 现有实现只校验初始 URL，网络请求自动跟随重定向；sandbox 关闭时允许所有目标，无法阻止公开 URL 跳转内网或 DNS rebinding。
   **修复：** 新建共享安全 fetch：只允许 HTTP(S)，手动逐跳重定向，每跳解析 DNS 并拒绝 loopback/link-local/私网/保留地址，设置响应限额；连接必须固定到已校验地址并保留 TLS SNI/Host。若平台无法保证校验地址就是连接地址，URL 导入 fail closed。

3. **[高] immutable provenance 中的“authorization scope”与可变 ACL 冲突。** 授权会撤销、扩展或随工作区归档变化；把它写入不可变 manifest，可能使索引重建恢复过期授权。
   **修复：** provenance 只保存不可变的 `capture_scope_snapshot` 作为审计上下文，不表达当前权限；有效授权唯一来自 `WikiAclStore`，重建不得从 capture snapshot 生成 ACL。

4. **[高] 隐私清除可能误删仍被其他 provenance 引用的共享 blob。** content-hash payload 去重后，按单个私聊来源清除 payload 会破坏公开网页或文件来源仍合法引用的同一内容。
   **修复：** 先删选中 provenance 与派生引用，再按剩余引用计数 GC blob；只有零引用才物理删除。强制按 hash 清除必须预览并删除所有 provenance/page 引用，经二次确认后执行。

5. **[高] 跨进程 lock 仅靠 lease 不足以阻止暂停进程恢复后继续写。** wall-clock lease 到期接管可能发生在旧 writer 仍存活但暂停时，导致两个 writer 并发提交。
   **修复：** lock 增加 heartbeat 和单调 fencing token；仅确认 owner 已死亡才接管，每个 journal/replace 检查 token，旧 writer 恢复后因 token 失效立即停止。

6. **[中] `sources/records/<id>/index.md` 会污染 Obsidian 页面和链接索引。** 机器 provenance manifest 会成为大量用户可见 Markdown 页面，与首版“source 页面”重复。
   **修复：** 将机器 manifests 移到 `.lume/sources/records/<id>.md` 并排除于页面/链接索引；用户可见 source 页面继续位于 workspace/inbox `sources/`。

VERDICT: REVISE

### Primary agent response

- **采纳 1：** 增加 Phase A/Phase B capability matrix。Phase A 只开放 Wiki UI 和固定只读 profile 的 Ask Wiki 会话，普通编码会话不带 Wiki scope且保留原工具；Phase B 只有在 protected-root gate、allow-root sandbox 和兼容性测试通过后才开放普通会话检索与 `wiki.propose_changes`。
- **采纳 2：** 不再把当前 WebFetch transport 描述成 SSRF 防线。WebFetch 与 Wiki URL adapter 共用基于 Node 内置 HTTP(S) 的安全传输，逐跳解析、拒绝内网/保留地址、固定已验证连接地址并限制重定向、时间和字节；无法固定时 URL 导入 fail closed。
- **采纳 3：** provenance 改为只记录 `capture_scope_snapshot`；`WikiAclStore` 是唯一有效权限来源，索引重建不得恢复 snapshot 中的权限。
- **采纳 4：** 隐私清除改为 provenance-first、零引用 blob GC；强制 content-hash 清除先预览全部 provenance/page 影响并二次确认。
- **采纳 5：** lock 增加 heartbeat、死亡 owner 判定和单调 fencing token，每次 journal/replace 都验证 token。
- **采纳 6：** 机器来源记录移入 `.lume/sources/records/` 并从 Obsidian page/link index 排除，保留独立用户可见 source 页面。
- 测试与风险章节同步补上 capability phase、安全 fetch、ACL 重建、共享 blob 清除及 lock fencing；没有拒绝项，也没有扩大已锁定产品范围。

## Fallback Review Round 3 — Independent read-only reviewer

Reviewer confirmed that all six Round 2 findings were closed, then identified four remaining gaps.

1. **[严重] Wiki Store 自身仍可通过 symlink/junction 逃逸或读取库外文件。** 计划只在本地文件导入时要求 realpath containment；但 Vault 可由 Obsidian/用户直接编辑，外部工具可在页面、assets 或 workspace 目录创建 symlink/junction。Watcher、索引、read 或 coordinator 跟随它们时可能读取敏感文件或写出 Wiki 根。
   **修复：** 所有扫描、读取、hash、replace、move、delete 逐层 `lstat`，拒绝 symlink/junction/reparse point，并验证现存父目录 realpath 位于 canonical Wiki root；分别测试 Windows junction 与 Unix symlink 的读写逃逸。

2. **[高] `WikiAclStore` 有存储模型，但授权状态转换未定义。** 页面关联与 provenance 来源授权可能被实现为同一件事，造成跨工作区泄露；也可能完全不授予来源，使事实回答无法下钻。
   **修复：** 将 page scope 与 provenance ACL 定义为串联的独立 gate，并为 `import / associate / disassociate / rehome / archive / explicit grant / revoke` 给出确定状态表；默认页面关联不隐式扩张 source grant，确认卡分别显示页面可见范围与来源授权。

3. **[高] provenance manifest 的不可变规则与来源 lifecycle 状态冲突。** manifest 若不可覆盖却包含删除状态，trash/restore/purge 后索引重建可能恢复旧状态。
   **修复：** immutable manifest 只保留初始 capture facts；当前状态改由 append-only lifecycle/tombstone store 投影，重建使用最新事件。隐私 purge 删除敏感 manifest/payload 后仅留无正文 tombstone。

4. **[中] 强制现有 WebFetch 切换安全 transport 会造成任务外回归。** 当前 WebFetch 可能依赖环境代理或访问私网；统一替换会改变 Agent 既有行为，且计划没有代理兼容策略。
   **修复：** 首版只让 Wiki URL adapter 使用安全 fetch，复用 WebFetch 解析层和既有本地资产；现有 WebFetch transport 迁移另立任务，除非补齐代理/内网兼容和回归测试。

VERDICT: REVISE

### Primary agent response

- **采纳 1：** store 所有读写/扫描路径逐层拒绝 symlink、junction、reparse point，并验证 canonical parent containment；测试覆盖 Windows/Unix 的读写逃逸。
- **采纳 2：** 增加串联授权 gate 和完整状态表。页面关联不自动授予/撤销 provenance，导入、重新归属和显式 grant/revoke 均在确认卡独立展示；事实无法下钻时必须标记来源受限。
- **采纳 3：** 来源拆成 immutable `capture_mode` 与 append-only `lifecycle_state` 投影；trash 后重建不得复活，purge 只留下无敏感内容 tombstone。
- **采纳 4：** Wiki 使用独立 `WikiSafeHttpFetchService`，不迁移现有 WebFetch transport；代理环境或无法固定地址时 Wiki URL 导入 fail closed，可导入已有 WebFetch 资产。
- 没有拒绝项；改动只消除路径、授权、重建与兼容性歧义，未增加新的产品表面。

## Fallback Review Round 4 — Independent read-only reviewer

1. Round 3 的路径逃逸问题已关闭：所有 store 读写/扫描逐层拒绝 symlink、junction、reparse point，并有 Windows/Unix 读写逃逸测试。
2. Round 3 的来源授权转换问题已关闭：page scope 与 provenance source grant 是串联的独立 gate，状态表覆盖 import、associate、disassociate、rehome、archive、grant/revoke。
3. Round 3 的 immutable provenance/lifecycle 冲突已关闭：`capture_mode` 不变，trash/restore/purge 使用 append-only lifecycle/tombstone 投影，重建和 privacy purge 语义明确。
4. Round 3 的 WebFetch 回归风险已关闭：安全 transport 只属于 Wiki URL adapter，现有 WebFetch 行为不在本任务中修改。
5. 未发现新的实施阻断项或材料级安全/正确性缺陷；数据身份、权限、确认、外部渠道、并发恢复、路径安全、SSRF、中文检索、工作区删除、隐私清除和分阶段发布均有可验证边界。

VERDICT: APPROVED

### Primary agent response

- 接受通过结论；不再扩展方案。
- Act 2 使用同一个独立只读 reviewer 连续完成 4 轮，其中前三轮修订、第四轮通过。
- 规定的 Codex CLI reviewer 因当前环境在 `thread.started` 前持续阻塞而未能启动；该事实保留在日志中，最终结论明确标记为 fallback review，不冒充 CLI 审查。

## Act 3 — Build

### Round 1 — Codex build

- 在独立 worktree `D:\workspace\projects\ai-projects\lume-wiki-build`、分支 `codex/lume-wiki` 中实施，避免接触原工作区的未提交任务。
- Codex CLI session：`019f6f66-5da2-7cb1-975e-c55bbccb90dc`。
- Codex 完成了共享类型与 Wiki 数据层的第一轮实现，但在输出最终报告前触发账户周额度上限（100%），无法继续同一 session 的修复轮。
- 未把中断状态冒充成功；按 `codex-build` 的有界 fallback 规则，由主代理直接接管剩余实现和验证。

### Primary-agent takeover

- 补齐 Wiki RPC、桌面 API、Lume 功能页入口、导入确认、阅读/编辑/Inspector、Obsidian 打开动作、Ask Wiki 固定只读 profile、工作区删除前归档以及数据管理扫描。
- 补齐路径逃逸、ACL 串联 gate、来源去重/引用计数、不可变确认 nonce、URL 每跳 DNS 校验、中文搜索分词和 UI 状态逻辑测试。
- 维持 Phase A：普通 Agent 不获得 Wiki scope，Ask Wiki 仅暴露 `wiki.search`、`wiki.read`、`wiki.follow_links`；没有伪装成已完成 protected-root/allow-root sandbox 的 Phase B。

### Verification verdict

- 主代理读取并审查了完整差异；`git diff --check` 无 whitespace error（仅 Windows LF/CRLF 提示）。
- 执行冻结计划中的精确 proof command：

  `bun test packages/shared/src/types/wiki.test.ts apps/sidecar/src/services/wiki apps/web/src/components/wiki && bun run --filter @lume/shared typecheck && bun run --filter @lume/sidecar typecheck && bun run --filter @lume/web typecheck && bun run --filter @lume/desktop typecheck`

- 结果：11 tests passed、0 failed、28 expect calls；shared、sidecar、web、desktop 四个 typecheck 全部通过。
- 未提交、未暂存，等待用户 diff sign-off。

### Known deviations and remaining risks

- Phase B 的操作系统级 Wiki protected-root gate 与通用工具 allow-root sandbox 未实现，因此 capability matrix 明确保持 Phase A。
- 结构 lint 已实现；语义检查与 weekly scheduler 未实现，snapshot 会明确报告 semantic capability unavailable。
- `recoverInterrupted()` 会识别 `applying` journal 并阻止第三种 hash，但尚未自动完成或回滚中断批次；罕见 I/O 中断仍可能留下需要人工处理的部分提交。
- 首版只提供 Wiki 中央入口的显式导入动作，没有在聊天、阅读和记忆上下文菜单分别增加“沉淀到 Wiki”快捷入口。
- 未执行真实 Electron/Obsidian 的人工视觉 smoke test；自动逻辑测试与四个包的类型检查已通过。

### Completion follow-up

用户要求继续完成后，主代理关闭了首轮交付中仍影响正确性的尾项：

- `recoverInterrupted()` 现在会在启动和打开 Wiki 时恢复 `applying` 批次：已完成文件按 `afterHash` 幂等跳过，未完成文件从 immutable staging/snapshot 继续，来源 manifest 与 ACL grant 也可安全重放。
- 恢复遇到第三种 hash 时不再抛错后遗留半状态：页面写入独立 protected registry，批次标记 failed，并创建 `requiresRegeneration` 待审核项；旧 diff 不能直接接受覆盖 Obsidian 编辑。
- 提交过程中的 I/O 错误保留 `applying` journal，供同进程下次 snapshot 或重启后恢复；journal 更新继续通过临时文件原子 replace。
- 增加持久化 Wiki health state：距成功语义检查超过 7 天时按 generation 只记录一次 due attempt；Phase A 未配置语义模型时明确显示“结构检查已完成、语义检查未执行”，不重复排队或伪装完成。
- 增加 WikiView 首屏渲染 smoke、journal 续跑、冲突保护、semantic due-check 测试。

补充验证：

- 独立配置目录下的 Electron bundle 成功启动到 `sidecar.ready`；Windows 自动化无法安全区分使用同一 Electron 可执行文件的 Codex/Lume 窗口，因此按安全边界停止点击，没有把该步骤冒充视觉验收。
- 改用 Node 24 运行真实 `node:sqlite` 的 WikiService bundle，完整验证“文本导入草案 → 确认 → 索引 → 搜索 → 读取 → 编辑 → 再确认”，结果为 `pages=1`、搜索命中“Wiki 理念”、更新为“Wiki 长期维护”。
- 最终精确 proof：15 tests passed、0 failed、46 expect calls；shared、sidecar、web、desktop 四个 typecheck 全部通过。
- 当前仍保持 Phase A；Phase B protected-root/allow-root sandbox 是 capability gate，不属于首版未完成缺陷。
## 2026-07-20 — grill-with-docs reassessment

Act 1 reopened after implementation and release feedback exposed drift between the locked plan and the runtime behavior. `CONTEXT.md` now defines the Wiki domain language. The user confirmed that a dedicated Ask Wiki session may call `wiki.propose_changes` in Phase A as long as it can only create staging drafts and formal writes still require user confirmation. The decision is recorded in `docs/adr/0001-ask-wiki-can-propose-in-phase-a.md` and the capability matrix, tests, key decisions, and risks in `PLAN-wiki.md` were updated consistently.

## Reassessment Round 1 — Codex

1. **[目标计划缺陷｜严重] `wiki.propose_changes(update)` 仍以整篇 `body` 替换页面，与“只更新 Agent 区、保护用户内容”冲突。** 当前计划没有定义块级 patch、保留未知章节或删除检测，实际实现也会直接序列化模型提供的全文。  
   **修复：** 将更新草案改为基于 `block_id + expectedRevision/contentHash` 的块级操作；任何用户块修改、未知内容删除或整页替换一律标为高风险。

2. **[目标计划缺陷｜高] “sidecar 签发 nonce”不等于“用户确认”。** nonce 在草案创建时生成并随工具结果返回给 renderer/模型消息，未绑定用户手势、窗口、线程或操作摘要；它只能防猜测和重复使用，不能证明用户确认。  
   **修复：** 明确信任 renderer，或由 desktop 主进程在真实确认点击后签发绑定 `draftId/revision/diffHash/windowId/expiry` 的一次性 capability。

3. **[目标计划缺陷｜高] staging 没有 Agent 草案的尺寸、数量和总磁盘配额。** 导入有 25/250 MiB 限制，但 Ask Wiki 可反复提交任意长度正文并制造草案，形成无需正式确认的本地磁盘 DoS。  
   **修复：** 对 Agent 草案增加正文上限、每线程速率、未决草案数量和全局 staging 字节配额，并记录拒绝原因。

4. **[实现缺口｜严重] “受信任启动入口”尚未实现。** `wiki:create-ask-thread` 接受 renderer 自报的任意 `all/inbox/workspace/page` scope，`resolveTrustedWikiRuntimeProfile` 随后仅因线程 metadata 含 `wikiProfile` 就授予显式 Wiki profile；普通 renderer 可以自行升级会话。  
   **修复：** sidecar 根据当前 owner UI 状态、实际 workspace/page 存在性和不可伪造的启动 capability 签发 scope，禁止 RPC 直接持久化客户端提供的 profile。

5. **[实现缺口｜严重] Ask Wiki 更新会静默覆盖用户内容。** `createAgentProposalDraft()` 仅在页面已标记 `protected` 时判高风险，却用模型传入的 `body` 替换整篇正文；没有比较用户拥有块、章节删除或 marker 变化。  
   **修复：** 在 staging 前解析新旧 ownership，检测用户块修改、marker 丢失和内容删除，并拒绝或强制进入不可直接接受的高风险审核。

6. **[实现缺口｜高] 外部编辑保护链没有 watcher。** 计划依赖 watcher 将被用户修改的 Agent block 升级为 `owner=user`，但当前 Wiki 服务只在读取/扫描时解析文件，没有持续监听、快照差分或所有权升级流程。  
   **修复：** 实现持久 watcher/checkpoint 差分；在其完成前，把任何非 coordinator hash 变化的整页标为 protected。

7. **[实现缺口｜高] 搜索完成声明夸大。** 索引只创建了 `embedding_cache` 表；没有实际 embedding 生成、增量更新、hybrid fusion、rerank，也没有 5,000 页/50,000 段性能验收。  
   **修复：** 将当前能力明确标为 lexical-only，并在语义流水线及规模基准真正完成前删除“本地 hybrid search 已实现”的完成表述。

8. **[实现缺口｜高] 隐私清除只是底层 source purge，不是计划要求的影响分析工作流。** 缺少按 page/thread/message/workspace 查询、派生 block 清理、snapshot/operation 正文清除、共享 hash 二次确认及对应 UI/RPC。  
   **修复：** 增加只读影响预览和二次确认草案，覆盖 provenance、页面引用、恢复快照、staging、索引与零引用 blob GC。

9. **[实现缺口｜高] 测试证明与计划列举的安全边界严重不匹配。** 现有少量测试没有证明 permission modes、renderer scope 升级、Windows junction、DNS rebinding/TLS SNI、ACL 状态表、lock 接管/fencing、强制清除或 5k/50k 性能目标。  
   **修复：** 把计划中的验收项做成可枚举测试矩阵，并将未执行项明确标为未完成，禁止用“15 tests passed”替代范围证明。

10. **[陈旧完成声明｜高] 日志称“最终精确 proof”并暗示首版正确性尾项已关闭，但同一日志已承认快捷入口、真实视觉验收和 Phase B 缺失，代码还缺 watcher、语义检索、隐私清除与完整安全测试。**  
    **修复：** 将 Act 3 状态改为 partial implementation，逐项列出 implemented/untested/not implemented，撤回“关闭正确性尾项”的表述。

11. **[领域语言不一致｜中] `askWikiReadOnly: true` 与 ADR-0001 允许 `wiki.propose_changes` 相矛盾。** 该字段会让 UI、遥测或后续策略误判专用会话能力。  
    **修复：** 将 capability 拆成 `askWikiRead`、`askWikiProposal`、`askWikiApply=false`，避免继续使用已经失真的 “ReadOnly”。

12. **[观测缺口｜中] 没有针对草案来源、scope 签发、拒绝原因、nonce 消费和越权尝试的结构化安全审计。** 当前 operation log 主要记录正式批次，无法回答是谁通过哪个会话提出或尝试应用变更。  
    **修复：** 追加不含正文的审计事件，记录 trusted subject、thread/profile、scope、draft/diff hash、确认入口、结果和拒绝代码。

VERDICT: REVISE

### Codex response

接受 1、3、5—12，并已把块级操作、草案配额、外部编辑保护、lexical-only 状态、隐私预览/二次确认、验收矩阵、能力字段拆分、安全审计和 partial implementation completion gate 写入计划。

对 2 和 4 采用 reviewer 给出的较简单分支：首版本地单用户产品明确把 owner renderer 定义为可信 UI。nonce 只承担不可变草案、过期和防重放，不冒充密码学用户手势证明；renderer 可以通过专用 RPC 新建 Ask Wiki thread，但 sidecar 必须验证 scope 目标存在并禁止修改既有普通 thread profile。未来若 renderer 进入敌对威胁模型，必须迁移到 desktop 主进程原生确认和私有 apply capability。

## Reassessment Round 2 — Codex

1. **[目标计划缺陷｜严重] Untrusted Agent runtime may possess both the draft nonce and a generic command channel capable of reaching sidecar RPC.** Ordinary Phase A sessions retain Bash/node-repl while temporarily receiving create-only `wiki.propose_changes`; the tool result contains the nonce, but the plan never requires apply RPC to authenticate the caller as the trusted renderer rather than merely validate the bearer nonce. Protected-root filesystem controls do not prevent calling a localhost/socket RPC endpoint。  
   **修复：** Make apply/resolve/undo reachable only through an authenticated desktop-renderer IPC channel unavailable to Agent subprocesses, and test that Bash/node-repl cannot invoke it even after observing a valid draft nonce.

2. **[目标计划缺陷｜高] The block-update rules contradict themselves.** The plan says Agent updates “不得提交整页替换正文,” then says whole-page replacement requests enter high-risk review; an operation cannot both be unrepresentable and reviewable. The same ambiguity affects user-requested merge/rewrite operations。  
   **修复：** Define two explicit schemas: safe block operations for normal confirmation and a separate whole-page/high-risk operation that preserves the before snapshot and can only enter pending review.

3. **[目标计划缺陷｜中] Per-thread quotas and security audits lack a required immutable creator identity in the draft model.** The plan limits each thread to 20 pending drafts and audits subject/thread/profile, but does not require those fields to be persisted with the immutable draft; reconstructing them from mutable thread state is unsafe and makes quota accounting ambiguous after deletion。  
   **修复：** Require every draft to persist immutable `creatorSubjectId`, `creatorThreadId`, profile, scope, and creation channel, and use those stored fields for quotas and auditing.

4. **[文档/领域语言缺陷｜高] `CONTEXT.md` still does not define the Wiki domain language.** It defines composer submissions and file-reference terms, while `PLAN-wiki.md` says “Terms per CONTEXT.md” and the review log claims CONTEXT now defines Wiki terminology. Terms such as trusted owner renderer, Wiki draft, source grant, page scope, protected page, and confirmation boundary remain undefined。  
   **修复：** Add the Wiki terms and threat actors to CONTEXT, or remove the false “Terms per CONTEXT.md” and reassessment claim.

5. **[ADR 缺陷｜中] ADR-0001 still describes nonce plus user confirmation as the formal-write boundary without recording the newly chosen trusted-renderer assumption.** This lets future readers interpret nonce as proof of user intent, contradicting the revised plan’s explicit statement that it only provides immutability, expiry, and replay protection。  
   **修复：** Amend the ADR with the trusted-renderer decision, nonce’s exact guarantees, untrusted Agent/runtime boundary, and the requirement that formal-write RPC be inaccessible to Agent execution channels.

6. **[验收缺口｜高] The threat-model test matrix does not explicitly test the most important new boundary.** It tests nonce forgery and protected-root bypass, but not whether an Agent that legitimately receives a valid nonce can invoke apply through Bash, node-repl, HTTP/WebSocket, desktop APIs, MCP, or another local bridge。  
   **修复：** Add a cross-channel test using a real valid nonce and require every non-renderer execution path to fail before draft application.

7. **[实现缺口｜严重] Current code still returns the full nonce in `WikiChangeDraft`, exposes it through the model tool result, and accepts it through the general Wiki RPC handler without caller-origin enforcement.** Therefore the revised trusted-renderer boundary is not implemented even if the plan is corrected。  
   **修复：** Separate the model-visible proposal result from renderer confirmation credentials and enforce an authenticated renderer-only apply transport.

8. **[实现缺口｜高] Current Agent updates remain whole-body replacements and only classify already-protected pages as high risk.** The revised block-operation contract, ownership comparison, and whole-page-review path do not exist yet。  
   **修复：** Replace `body` updates with the planned block operation schema before treating Ask Wiki proposal support as complete.

9. **[实现缺口｜高] The remaining prior implementation gaps are now honestly acknowledged but remain open.** Watcher-based ownership promotion, semantic/hybrid indexing and scale benchmarks, privacy impact preview and purge workflow, staging quotas, split capability fields, structured security audit, full acceptance matrix, and release-artifact proof are not implemented。  
   **修复：** Keep them marked `not implemented` and do not restore a completion claim until each corresponding acceptance row is implemented and tested.

VERDICT: REVISE

### Codex response

接受全部目标计划与文档修订。模型可见提案不再包含 nonce；apply/resolve/undo 从通用 sidecar RPC 移到 Agent 子进程不可访问的 Electron 主进程 privileged channel，内部会话凭证必须从 renderer 和所有 Agent 子进程环境剥离。验收矩阵增加持有真实有效草案/nonce 的跨 Bash、node-repl、HTTP/WebSocket、desktop API、MCP 与本地 bridge 绕过测试。

块更新拆成普通 `block_patch` 与只能进入 pending review 的 `replace_page`；草案固化创建者身份、线程、profile、scope 和 channel。由于另一个并行任务已把根 `CONTEXT.md` 用于对话输入域，新增 `CONTEXT-MAP.md` 与 `docs/wiki/CONTEXT.md` 保存 Wiki 术语，没有覆盖对方文档。ADR-0001 同步记录可信 Owner UI、nonce 的有限保证与 privileged apply channel。

### Context correction

Earlier reassessment text saying that root `CONTEXT.md` defines Wiki terminology is superseded. `CONTEXT-MAP.md` now routes the repository's domains; `docs/wiki/CONTEXT.md` is authoritative for Wiki terminology, while root `CONTEXT.md` remains authoritative for the conversation-input domain.

## Reassessment Round 3 — Codex

1. **[目标计划缺陷｜严重] Privileged operations still lack distinct request contracts.** The plan says Owner UI submits only `draftId + expectedRevision + diffHash`, but applies that statement to `apply/resolve/undo`; resolve needs pending ID plus accept/reject, while undo starts from a batch ID and current after-hash conditions. Treating them as one contract leaves authorization and stale-state checks ambiguous。  
   **修复：** Define separate privileged schemas for `applyDraft`, `resolvePending`, and `undoBatch`, each with its own identifier, action, expected revision/hash set, and authoritative sidecar validation.

2. **[目标计划缺陷｜高] The model-visible draft shape is not actually specified.** “不含 nonce 的确认卡摘要” does not define which fields the model receives, which fields the Owner UI displays, how `diffHash` is calculated, or whether the UI re-fetches canonical draft state before confirmation. A stale or altered tool-result summary could describe something different from the saved draft。  
   **修复：** Define a versioned `WikiProposalSummary` containing only draft ID, revision, expiry, risk, bounded previews, operation summaries and canonical `diffHash`; require Owner UI to fetch this authoritative summary before enabling confirmation.

3. **[目标计划缺陷｜高] The privileged main-to-sidecar credential lifecycle remains underspecified.** The plan says it is private and stripped from Agent environments but does not define creation, transport, restart rotation, endpoint authentication, logging rules, or failure behavior. Passing it through inherited environment variables or command-line arguments would violate the intended boundary。  
   **修复：** Require a per-sidecar-start random credential delivered over a dedicated inherited pipe/stdio handshake, never argv/env/logs, rotated on restart, constant-time validated, and mandatory for every privileged endpoint.

4. **[目标计划缺陷｜高] `diffHash` is submitted but not explicitly validated against the saved draft.** The plan says sidecar loads the nonce and checks immutability, expiry and replay, but omits the required equality check between the submitted hash, canonical summary, and immutable stored operations。  
   **修复：** Require sidecar to recompute the canonical operation/diff hash and reject unless it matches both the stored draft and Owner UI’s submitted `diffHash`.

5. **[领域语言缺陷｜中] `Source Grant` is broader in `docs/wiki/CONTEXT.md` than in the plan.** The context says a grant may authorize a page, workspace, or session, while the plan’s deterministic ACL transitions primarily describe provenance-to-workspace grants and require a matching workspace UUID. Page/session grants have no lifecycle or precedence rules。  
   **修复：** Narrow the context definition to the implemented provenance/workspace grant model, or add explicit page/session grant records, precedence, revocation, rebuild and archive semantics to the plan.

6. **[文档缺陷｜低] The append-only reassessment log still states that root `CONTEXT.md` defines Wiki terminology.** Later text explains the multi-context split, but the stale assertion is not explicitly superseded and can mislead readers following the transcript。  
   **修复：** Append a correction stating that `CONTEXT-MAP.md` routes domains and `docs/wiki/CONTEXT.md` is now authoritative for Wiki terminology.

7. **[验收缺口｜高] Cross-channel tests mention possession of a real nonce but do not explicitly cover the canonical-summary and privileged-command contracts above.** A test could prove that generic RPC rejects apply while still missing summary substitution, stale revision, wrong diff hash, resolve-action tampering, or undo-batch substitution。  
   **修复：** Add negative cases for altered summary, wrong/stale `diffHash`, substituted draft/pending/batch IDs, changed resolve action, replay after restart, and credential leakage through argv/env/logs.

8. **[实现缺口｜严重] The current implementation still uses the old general RPC and model-visible `WikiChangeDraft` containing nonce, and Agent updates remain whole-body replacements.** The revised privileged channel, public summary type, `block_patch`, and `replace_page` contracts are target-plan changes, not implemented protections。  
   **修复：** Keep Ask Wiki mutation capability marked unavailable until the new transport and operation schemas are implemented and their bypass tests pass.

9. **[实现缺口｜高] Previously identified implementation gaps remain open but are now correctly classified as partial work.** These include watcher ownership promotion, staging quotas, split capability fields, security audit events, hybrid retrieval, privacy-clear workflow, full acceptance matrix, and release-artifact verification。  
   **修复：** Preserve their `not implemented` status and do not restore completion claims based on the earlier 15-test proof.

VERDICT: REVISE

### Codex response

接受全部修订。计划新增三个独立 privileged command schema、版本化 `WikiProposalSummaryV1` 及 canonical `diffHash` 算法；Owner UI 必须重新获取权威摘要，sidecar 必须重算并同时匹配存储值和请求值。privileged credential 每次 sidecar 启动随机生成，经专用匿名 pipe/额外 stdio 交付，禁止 argv/env/renderer/log 暴露，认证或交付失败时正式变更 fail closed。

`Source Grant` 已收窄为 provenance-to-workspace UUID 授权；日志追加 context 权威来源更正。测试矩阵加入摘要替换、stale/wrong hash、ID/action 替换、重启重放和凭证泄露负例。在这些 proposal security gate 通过前，当前 Ask Wiki mutation 必须显示不可用，不能继续暴露旧的 model-visible nonce/general RPC 路径。

## Reassessment Round 4 — Codex

The Round 3 design findings are substantially closed: the three privileged commands are distinct, `WikiProposalSummaryV1` is nonce-free, canonical `diffHash` binds immutable operations and payload hashes, the Owner UI re-fetches authoritative state, credential delivery uses a per-start anonymous pipe, Source Grant is narrowed to provenance-to-workspace UUID authorization, and the proposal security gate prevents premature exposure.

1. **[目标计划矛盾｜高] Phase A proposal availability is stated inconsistently across the plan and ADR.** The security-gate rule says Ask Wiki and ordinary sessions remain proposal-disabled until every gate component passes, but the key decision says Ask Wiki “在 Phase A 即可…生成 staging 草案,” and ADR line 18 says ordinary Phase A sessions receive create-only proposal capability on explicit requests without repeating the gate prerequisite. An implementer could reasonably expose the current unsafe implementation based on those unconditional statements。  
   **修复：** Make every capability statement conditional: Phase A provides read-only Ask Wiki by default; `wiki.propose_changes` becomes available to Ask Wiki and explicit ordinary-session writes only after `proposalSecurityGate=passed`.

2. **[验收矩阵缺口｜中] Credential lifecycle tests do not explicitly verify pipe-handle inheritance and credential rotation.** The plan requires closing the inherited pipe for Agent/MCP/command children and rotating credentials on sidecar restart, but the negative matrix only mentions argv/env/log/renderer leakage and nonce replay. It does not require proof that child processes lack the pipe handle or that an old privileged credential fails after restart。  
   **修复：** Add negative tests proving Agent/MCP/shell descendants cannot read or inherit the credential pipe and that the previous credential is rejected after sidecar restart while pending drafts remain safely recoverable.

Implementation remains correctly classified as partial: current code still exposes nonce-bearing drafts through general RPC and keeps proposals enabled, so the new security gate must evaluate false until the privileged transport, public summary, block schemas, quotas, and bypass tests are implemented.

VERDICT: REVISE

### Codex response

接受两项修订。计划和 ADR 的所有 Phase A 提案表述现在都以 `proposalSecurityGate=passed` 为前置条件；默认 Phase A Ask Wiki 只读。验收矩阵新增 Agent/MCP/shell 后代无法继承 credential pipe、sidecar 重启后旧 credential 失效、未决草案仍可由新 credential 安全恢复与确认的负例。

## Reassessment Round 5 — Codex

All prior plan findings are closed.

- Every operative Phase A proposal path is conditioned on `proposalSecurityGate=passed`; default Phase A Ask Wiki remains read-only.
- `WikiProposalSummaryV1`, canonical `diffHash`, authoritative summary refresh, and three distinct privileged command contracts are consistent.
- Credential creation, anonymous-pipe delivery, non-inheritance, restart rotation, fail-closed behavior, and negative tests are explicit.
- Source Grant semantics consistently use provenance-to-workspace UUID authorization.
- The negative matrix covers nonce exposure, summary/hash tampering, ID/action substitution, cross-channel bypass, credential leakage, pipe inheritance, restart rejection, and safe pending-draft recovery.
- Multi-context documentation and the append-only correction identify `docs/wiki/CONTEXT.md` as the authoritative Wiki glossary.
- Remaining code work is explicitly gated and classified as partial implementation, not falsely presented as completed.

VERDICT: APPROVED

## Reassessment resolution

Act 1 + Act 2 converged in 5 review rounds. Implementation remains partial and must satisfy the `PLAN-wiki.md` completion gate before the plan file is deleted.

## Final implementation acceptance — 2026-07-20

The implementation completion gate is closed. The enumerable matrix is recorded in `docs/wiki/ACCEPTANCE.md`; Windows 0.1.6 artifact proof is recorded in `docs/wiki/RELEASE-0.1.6.md`.

All required domains are marked `implemented + tested`: central storage and workspace placement, block ownership, coordinator and privileged confirmation contracts, explicit import adapters, protected Agent access, native Wiki UI, hybrid/index maintenance, structural and semantic health, privacy purge, workspace lifecycle, data-management boundaries, 5,000-page/50,000-section performance, and packaged Windows proposal-to-search smoke.

The product decision made during implementation supersedes duplicate per-source UI shortcuts: Lume exposes one central explicit Import action in the Wiki feature page, while the backend retains chat, reading, memory and workspace-file adapters. This preserves explicit ingestion without multiplying entry points.

Remaining out-of-scope boundaries are unchanged: Obsidian runtime/plugins/sync, cloud or real-time collaboration, organization RBAC, WYSIWYG/graph UI, silent historical migration, unconfirmed Agent writes, autonomous web rewriting, OCR/transcription and post-5k ANN infrastructure. The same portable symlink escape test uses junctions on Windows and directory symlinks on Unix; this acceptance run executed the Windows branch, so Unix CI remains a regression safeguard rather than an unimplemented feature.

The standard package aggregator was blocked by an unrelated concurrent `agent-files-service.test.ts` fixture missing `expectedKind`. No unrelated code was changed. The current Wiki sidecar bundle was rebuilt directly, electron-builder regenerated `Lume-0.1.6-x64.exe`, and artifact verification plus the packaged Electron utility-process smoke passed.

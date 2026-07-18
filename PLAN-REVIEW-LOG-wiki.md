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

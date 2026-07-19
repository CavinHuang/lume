# Review Log: 统一输入框体验与技能/插件引用协议

Act 1 complete. Product and technical decisions were locked through the `grill-me-codex` interview.

- Plan: `PLAN-input-composer-ux.md`
- Reviewer: OpenAI Codex CLI, read-only sandbox
- Maximum review rounds: 5
- Rule: every follow-up uses the same Codex session; Codex may inspect the repository but must not write files

## Act 1 locked scope

- One shared rich composer across welcome, thread, and Quick Input, with context-specific capabilities.
- One `/` panel for actions, skills, and plugins; `@` remains Agent/file references.
- Hard-cut canonical protocols: `lume-plugin://<pluginId>`, `lume-skill://<skillSlug>`, and `lume-skill://<pluginId>:<skillSlug>`.
- One adaptive primary button for send/stop/queue and transactional submission semantics.
- Compact pending attachments, consistent drafts/focus/undo/IME, and 800ms double-Esc stop behavior.
- Queue summary plus expanded manager, full per-item snapshots, strict FIFO pause on invalid head, no cross-restart persistence.
- No implementation before the converged plan receives human sign-off.

## Review rounds

## Round 1 — infrastructure failure

Codex CLI was launched with `-s read-only`, the CLI default model, immediate stdin EOF, and a 10-minute timeout. The process exceeded the timeout and produced neither a `thread.started` result visible to the driver nor an output-last-message verdict file. The timed-out CLI process and its exact child host process were terminated; unrelated Codex processes were left untouched.

No critique was available, no review verdict was inferred, and the round was not retried automatically. Act 2 is paused pending user direction, as required by the skill's timeout rule.

### User-directed retry

The user explicitly authorized continuing after the first infrastructure failure. A fresh read-only Codex session was required because the first attempt returned no session id.

- Session: `019f731e-7f85-7ba0-b0c5-b37c0311bc49`
- Sandbox: `read-only`
- Stdin: explicitly closed through the process API
- Result: the reviewer started, read its review instructions, inspected the plan and repository, and emitted tool events, but repeated transport timeouts and HTTP fallback delays prevented a final message within 570 seconds
- Verdict file: not created
- Process handling: the reviewer process tree was terminated by the internal timeout guard before the outer 10-minute ceiling

This was another infrastructure failure rather than a substantive review round. There is still no critique or verdict to append. The session id is retained so a user-authorized continuation can resume the same read-only session instead of repeating repository discovery.

## Round 1 — Codex

1. **插件技能 URI 不是稳健的 URI。** `lume-skill://pluginId:skillSlug` 会把 `:skillSlug` 解释为 authority 端口，且 authority 会大小写归一化，和允许大小写/点号的 skill slug 冲突。
   Fix: 改为无歧义、可标准解析的格式，如 `lume-skill://plugin/<pluginId>/<skillSlug>`，并锁定编码、大小写和边界语法。

2. **任意正文中的 URI 被当作执行授权。** 粘贴日志、文档或代码示例即可意外激活能力，而畸形 URI 还会阻止发送普通技术文本。
   Fix: 在 `AgentSendInput` 增加结构化 `capabilityRefs`，只让编辑器节点或显式 headless 字段授权执行，正文 URI仅用于持久化展示。

3. **普通 skill slug 不是全局唯一 ID。** user/project/workspace 可存在同 slug，`listEditableSkills` 与 `getRuntimeSkills` 的合并和覆盖规则也不同，`lume-skill://slug` 无法稳定指向同一技能。
   Fix: 将 scope/source 纳入 canonical ID，或定义并复用唯一的运行时优先级解析器，同时拒绝歧义引用。

4. **“无 workspace 时技能不可用”与运行时不符。** SDK 仍会加载用户全局技能，因此面板会隐藏实际可调用能力，headless 与 Web 语义也会分叉。
   Fix: 让统一能力清单包含无 workspace 时的全局技能，或同步禁止运行时加载它们。

5. **计划复用了错误的发现接口。** `LIST_PLUGINS` 基于 `resolveEnabled`，看不到禁用/待审核插件；`LIST_EDITABLE_SKILLS` 又直接扫描插件技能，可能列出运行时未授权能力。
   Fix: 新增一个由 runtime registry/permission gate 生成的 `LIST_INVOCABLE_CAPABILITIES`，同时返回 callable 与 display-only 状态。

6. **直接注入 Skill 内容会绕过 SDK 语义。** 这会丢失 `getPrompt(args)`、`allowedTools`、`argumentHint`、`context: fork`、`agent`、`isEnabled` 和 usage recording；多个技能如何分配参数也未定义。
   Fix: 所有显式引用必须通过统一的 `SkillDefinition` 执行器解析参数并应用工具策略，禁止直接读取 `SKILL.md` 后拼接 prompt。

7. **SDK skill registry 存在跨线程竞争和越权污染。** registry 是进程级全局 Map，而每个 runtime 会 register/unregister；一个线程结束可移除另一线程正在使用的技能，不同 workspace 也会互相可见。
   Fix: 把 registry 改为 Agent/session scoped，或使用带 owner token 的引用计数，并增加两个 workspace 并发运行测试。

8. **引用剥离阶段放置不明确，会污染其他系统。** 当前 routing、memory recall 和 workflow hooks 都先读取原始 `userMessage`，多个 hook 的 `userMessageForModel` 还采用“第一个胜出”，可能丢掉插件或记忆转换。
   Fix: 在持久化之后、routing/memory/hooks 之前生成 `{visibleMessage, modelMessage, resolvedRefs}`，并结构化组合上下文而非覆盖字符串。

9. **“事务式提交”没有幂等保证。** `agentSend` 每次调用生成新 `submissionId`；若 sidecar 已接收但响应丢失，重试会重复发送。
   Fix: 每次逻辑提交生成并保留稳定 submission ID，sidecar 按该 ID 去重并支持查询既有结果。

10. **附件 prepare 失败会泄漏并在重试时复制。** 文件先经 `SAVE_FILES_TO_THREAD` 落盘，dispatch 失败后计划只保留前端 pending payload，没有回滚或复用已保存文件。
    Fix: 增加 sidecar prepare/commit/abort 事务或稳定 upload token，失败时安全清理未被消息/队列引用的文件。

11. **欢迎页回滚存在 TOCTOU。** `CREATE_THREAD → SAVE_FILES → SEND → 检查为空后删除` 跨多个 IPC，无法保证不会误删刚被其他窗口或流程写入的线程。
    Fix: 用单个 sidecar RPC 原子完成 create/save/dispatch，或用 creation token 做 compare-and-delete 回滚。

12. **队列 API 没有并发控制。** 当前 kernel 在运行结束后直接 `shift()` 并启动下一项；list/reorder/update/remove 没有 revision，用户保存编辑或拖拽时目标项可能已经开始执行。
    Fix: 为队列增加单线程状态机、snapshot revision/CAS 和 `queued → validating → running|blocked` 原子状态迁移。

13. **执行前重新校验范围不足。** 计划只重验引用、附件和 workspace binding，却快照了 `bypassPermissions`、模型、桌面上下文等可能已撤销或过期的能力。
    Fix: 执行前重新校验当前 permission policy、模型/channel、插件授权、桌面 snapshot 和附件，并用结构化原因阻塞队首。

14. **队列附件与“提升为引导”的所有权未定义。** 删除、替换、跳过或提升含附件/仅引用的项可能遗留文件，或把已剥离为空的内容变成无效 guidance。
    Fix: 定义队列附件引用计数和清理规则，并限制 guidance 为显式非空文本，转换时安全释放未使用资源。

15. **完整插件引用没有上下文预算。** `lume-plugin://id` 可注入插件全部技能，多个引用可能无限放大 prompt、成本和延迟。
    Fix: 限制引用数、单项及总 token/byte 预算，超限时返回明确错误而非截断执行指令。

16. **复制链路仍有遗漏。** `apps/web/src/components/agent/tool-result-renderers/highlighted-code.tsx` 仍调用 `navigator.clipboard.writeText`，与桌面权限策略及计划声明冲突。
    Fix: 将该路径纳入迁移，统一改用 `writeClipboardText`，并以 `rg` 契约检查 renderer 不再直接写剪贴板。

17. **缺少关键运行时可观测性。** 计划只有测试清单，没有引用解析结果、拒绝原因、注入集合、队列阻塞/冲突/恢复等 trace 事件。
    Fix: 增加不记录 Skill 正文的结构化事件：reference resolved/rejected、queue blocked/resumed/update-conflict，并关联 submissionId、threadId 和 queue item ID。

18. **改动面违反“小而可逆”。** 协议硬切换、SDK 注入、三个编辑器、欢迎页事务和队列状态机被捆成一次实施，任一层失败都难以隔离回滚。
    Fix: 拆成“后端协议与隔离 → 共享编辑器/UI → 队列事务”三个独立可验收阶段，每阶段保持旧 UI 不再新增但可运行。

VERDICT: REVISE

### Codex orchestrator response

Accepted and incorporated findings 2–3 and 5–18:

- Added structured `capabilityRefs`; visible URI text alone no longer grants execution authority.
- Added a single runtime `LIST_INVOCABLE_CAPABILITIES` catalog, deterministic skill scope resolution with ambiguity rejection, and Agent/session registry isolation.
- Required the SDK `SkillDefinition` executor so `getPrompt`, tool restrictions, context/agent modes, enable checks, and usage recording are preserved; incompatible multi-skill modes fail closed.
- Fixed projection order before routing/memory/hooks and added capability-context budgets.
- Added stable client submission IDs, sidecar deduplication/query, attachment leases, and token-guarded welcome orchestration.
- Replaced the queue mutation model with revision/CAS and atomic item states, expanded execution-time validation, and defined attachment/guidance ownership.
- Added structured non-content observability, the missed highlighted-code clipboard path, and three reversible implementation milestones.

Partially rejected finding 1's proposed protocol shape because the user explicitly locked `lume-skill://<pluginId>:<skillSlug>`. The plan now makes this a Lume lexical protocol rather than a WHATWG URL: components are case-sensitive and strictly percent-encoded, the first unencoded colon is the separator, and `new URL()` is forbidden. This addresses the port/host-normalization flaw without changing the signed-off public syntax.

Rejected the first alternative in finding 4 (show global skills without a workspace) because the user explicitly locked the no-workspace empty state. The plan adopts the reviewer's other safe alternative: desktop sidecar now rejects skill refs without a workspace, while standalone SDK use with explicit cwd/roots remains a separately documented surface.

## Round 2 — Codex

1. **授权来源在持久化后丢失。** `visibleMessage` 与去重后的 `capabilityRefs` 无法标识哪个 URI 出现位置来自 reference node；同一 URI 同时作为标签和日志文本出现时，sidecar 不知道该删除哪一处，历史编辑也无法区分原授权与普通文本。
   Fix: 传输并持久化结构化 message parts 或带 occurrence ID/range 的 ref markers，历史编辑与模型投影只恢复、剥离被标记的出现位置。

2. **消息在所有失败点通过前就被持久化。** 第 28 行先持久化 `visibleMessage`，随后 executor、组合兼容性和预算计算仍可能失败，导致 sidecar 返回 rejected 但历史已有孤立用户消息。
   Fix: 先完成 refs 解析、executor dry-run、兼容性和预算校验，再以 submission receipt 原子提交可见消息与 dispatch/queue claim。

3. **registry 的 ref-count fallback 仍会跨 workspace 串用定义。** 全局 Map 对同名 skill 只能保存一个 `SkillDefinition`；引用计数只能防止过早删除，不能防止后注册定义覆盖另一 session。
   Fix: fallback 必须是 `(ownerToken, skillName)` 多映射并要求所有 lookup 携带 owner，不能只给现有全局 key 增加引用计数。

4. **authoritative rejection 与安全重试规则互相冲突。** 计划既缓存 `rejected`，又要求失败后保留同一 ID/lease 重试；相同 ID 会永远返回旧 rejection，而修改 payload 又会触发 hash mismatch。
   Fix: 仅在响应结果未知时复用 ID/lease；明确 rejected/abort 后终结旧 submission，用户修正或重试时生成新 ID 和新 lease。

5. **队列编辑违反 submission payload 不可变约束。** 队列快照保留原 `clientSubmissionId`，但 CAS 编辑会改变正文、refs、附件或配置，与“同一 ID 不同 payload hash 必须拒绝”冲突。
   Fix: 将 immutable enqueue receipt 与 mutable queue-item revision 分离，或每次成功编辑生成 linked replacement submission ID 并原子更新 dedup ledger。

6. **进程内去重无法覆盖最危险的响应丢失场景。** sidecar 若在持久化用户消息后、返回结果前崩溃，内存 dedup 记录消失，重启后的重试仍会重复落消息或创建 welcome thread。
   Fix: 将最小 submission receipt 与消息/thread 创建原子持久化，并在重启后按 `clientSubmissionId` 恢复查询与去重。

7. **不恢复队列却 commit 队列附件会造成重启泄漏。** sidecar 重启后内存队列和 ref count 消失，但已提交给队列项的文件仍留在磁盘；“过期队列清理”又被列为 out of scope。
   Fix: 持久化轻量 lease ownership journal 仅用于启动清理，或让队列附件保持带 TTL 的未提交 lease，直到 worker claim 时才 commit。

8. **“完整快照”没有冻结 capability 身份。** 队列只存 canonical ref；等待期间 plugin 更新、skill 热刷新或 scope winner 变化后，同一 URI可能执行不同内容。
   Fix: 入队时记录 resolved source/version/content fingerprint，执行前不一致则阻塞并要求用户确认或重新保存，禁止静默切换实现。

VERDICT: REVISE

### Codex orchestrator response

Accepted all eight Round 2 findings:

- Replaced the ambiguous visible-string-plus-ref-array transport with ordered, persisted `AgentUserMessagePart[]` and stable occurrence IDs. Only capability-ref parts authorize and are removed from model text; identical URI text parts stay ordinary text.
- Moved schema/ref/executor/compatibility/budget/attachment/config validation before persistence, then atomically records the minimal submission receipt, visible message + parts metadata, and sent/queued result.
- Removed the unsafe ref-count-only registry fallback; every lookup is Agent/session scoped or keyed by `(ownerToken, skillName)`.
- Split transport-unknown retry from authoritative rejection: only unknown outcomes reuse ID/lease, while a rejected corrected submission gets a new ID and lease.
- Separated immutable enqueue receipts from mutable queue items. Queue edits use their own idempotent operation ID plus revision/CAS.
- Persisted the minimal submission receipt so crash-after-commit can be queried and deduplicated after restart without persisting the complete queue.
- Kept queued attachments as renewable prepared leases until worker claim and added a minimal ownership journal for restart cleanup; this does not restore queue content.
- Frozen resolved source/version/content fingerprints in queued items; capability changes block the head until explicit resave/confirmation.

## Round 3 — Codex

1. **`AgentSendInput` compatibility remains undefined.** The existing schema requires `userMessage`, and automation/IM/routine/subagent callers produce only that field; adding authoritative `messageParts` creates two potentially conflicting bodies or forces an unstated repo-wide migration.
   Fix: Define a discriminated normalization contract: absent parts wrap `userMessage` as one non-authorizing text part; present parts must exactly derive `userMessage`, or remove `userMessage` after updating every producer.

2. **The claimed persistence/dispatch atomicity is not implementable with the current stores.** Messages/threads are persisted separately from the in-memory runtime kernel, so a transaction cannot atomically write receipt/message and start or queue dispatch; crashes leave receipts claiming work that never started.
   Fix: Use explicit `preparing → accepted → started|queued|rejected|restart_dropped` receipt transitions with crash reconciliation, or a durable outbox claimed by the runtime after commit.

3. **Queued-message persistence is internally contradictory.** Line 29 says enqueue atomically writes the visible user message, while lines 79 and 91 commit the lease and message only when the worker claims the item; the first interpretation would show or duplicate queued messages in history.
   Fix: For queued submissions persist only receipt plus queue identity initially, and create the visible message exactly once when worker claim succeeds.

4. **“Executor dry-run” has no side-effect contract.** `SkillDefinition.getPrompt` is asynchronous and custom implementations are not guaranteed pure; invoking it for validation or queue fingerprinting may perform work or record usage even when submission is rejected, cancelled, or never executed.
   Fix: Introduce a side-effect-free resolve/preview phase, cache its output for immediate dispatch, and defer usage recording and execution-only behavior until the receipt/queue item is successfully claimed.

VERDICT: REVISE

### Codex orchestrator response

Accepted all four Round 3 findings:

- Kept `userMessage` for existing automation/IM/routine/subagent producers and defined normalization: absent parts become one non-authorizing text part; present parts must concatenate exactly to `userMessage`.
- Replaced impossible cross-store atomicity claims with an explicit durable receipt state machine, a database outbox for immediate/claimed execution, and crash reconciliation against the in-memory runtime.
- Clarified that enqueue persists no visible user message and commits no attachment. The message is written exactly once with `queue_claimed` receipt + outbox when the worker claims the item.
- Split capability handling into a side-effect-free resolve/preview contract and claim-only execution/usage recording. Nonconforming custom skills are display-only/not composer-invocable.

## Round 4 — Codex

1. **The atomic persistence boundary is still fictional.** The plan requires one database transaction for thread/message/receipt/outbox, but the repository stores thread indexes, transcripts, and visible message versions through separate filesystem writes, so crashes can still split them.
   Fix: Make one SQLite submission/event store the transactional source of truth with unique submission/message IDs and idempotent JSON/JSONL projections, or explicitly migrate every participating store into that transaction.

2. **Queue publication races its durable state.** Line 32 enqueues the in-memory item before transitioning the receipt to `queued`, allowing the worker to claim an item whose receipt is still `preparing`.
   Fix: Under the queue lock, persist `queued` first, then publish the item; claim only via `queued → queue_claimed` CAS and terminally drop/abort if publication fails.

3. **A claimed outbox can become a permanent ghost run.** A crash after receipt transition to `started` but before runtime execution leaves no recoverable outbox, while the plan says subsequent queries return the existing “started” result.
   Fix: Add leased `claimed` and terminal `interrupted` states; recover expired pre-execution claims and mark stale started attempts interrupted rather than reporting them as successfully dispatched.

4. **Side-effect-free preview remains unenforceable.** Existing `SkillDefinition.getPrompt` is arbitrary asynchronous code receiving `ToolContext`; documentation and adapter tests cannot determine whether a custom implementation writes state or performs external work.
   Fix: Make composer preview data-only or sandboxed, and default-deny every definition that exposes only legacy `getPrompt` from pre-claim preview.

VERDICT: REVISE

### Codex orchestrator response

Accepted all four Round 4 findings:

- Added `agent-submissions.sqlite` using the repository's existing `node:sqlite` runtime. It is the transactional source of truth for new composer receipts, unique thread/message events, parts, outbox, and lease ownership; existing indexes/transcripts/version files become idempotent projections keyed by stable event/message IDs.
- Corrected queue publication ordering: persist `queued` under the queue lock before publishing the in-memory item, and claim only via `queued → queue_claimed` CAS; failed publication becomes `restart_dropped` and aborts its lease.
- Added leased outbox `claimed`, durable `started`, and terminal `interrupted` states. Expired pre-start claims may be recovered, while stale started attempts are interrupted and never reported as successfully dispatched or automatically replayed.
- Replaced arbitrary pre-claim `getPrompt(ToolContext)` calls with data-only invocation descriptors. Legacy callback-only skills are default-denied from the composer catalog; execution and idempotent usage recording occur only after claim.

## Round 5 — Codex

No unresolved material blockers remain.

VERDICT: APPROVED

## Resolution

The plan converged after 5 substantive Codex review rounds in the same read-only session. Two earlier attempts were recorded as infrastructure failures and did not produce or consume a substantive verdict round. No implementation code was written during Act 1 or Act 2.

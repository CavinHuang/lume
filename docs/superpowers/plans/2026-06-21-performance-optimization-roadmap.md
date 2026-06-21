# Lume 性能优化路线图（完整方案）

> **本文档是总览/索引**。性能优化横跨 5 个独立子系统，按 superpowers writing-plans 规范拆成多个独立可交付的 Phase（子 plan）。每个 Phase 都能产出可工作、可测试的软件。当前仅有 **Phase 1** 展开为代码级可执行 plan（见 `2026-06-21-perf-fe-streaming.md`），其余 Phase 为任务级规划，按需逐个展开。
>
> **审查依据**：本路线图基于 2026-06-21 的全项目性能审查（前端渲染 / 前端状态 / 后端 runtime / memory-v2+embedding / 启动+RPC 共 5 域）。所有问题均指向具体 `file:line`。

**Goal:** 系统性消除 Lume 的六大性能反模式，把"对话越长越卡、输出越长越卡、记忆越多越慢"的根因逐层拆解修复。

**核心结论（根因）：** 瓶颈集中在 6 个反复出现、彼此叠加的反模式——
1. 流式渲染热路径每 token 触发全量重算 + `JSON.stringify` 比较；
2. 后端事件存储"全量读→改→原子重写"的 O(n²) 写放大；
3. 本地 ONNX embedding 逐条串行推理 + 全量暴力向量检索；
4. 每轮 LLM 调用全量重算 + 同步 native tokenize；
5. RPC 巨型 payload + 读配置反触发写；
6. 同步 `*Sync` fs 阻塞 Bun 单线程事件循环。

---

## 优先级矩阵

| Phase | 子系统 | 优先级 | 预期收益 | 依赖 | 可执行 plan |
|-------|--------|--------|----------|------|-------------|
| 0 | 性能基准护栏（跨域） | 前置 | 建立回归基线 | 无 | 待展开 |
| 1 | 前端流式渲染热路径 | P0 | 🔥🔥🔥 流式帧率质变 | 0 | ✅ `2026-06-21-perf-fe-streaming.md` |
| 2 | 前端状态投影增量 + 引用稳定 | P0 | 🔥🔥🔥 消除每 token 全量投影 | 0 | 待展开 |
| 3 | 后端事件存储 append-only | P0 | 🔥🔥🔥 流式吞吐质变 | 0 | 待展开 |
| 4 | 本地 embedding 批量化 + 向量化 | P0 | 🔥🔥🔥 记忆系统秒级→毫秒级 | 0 | 待展开 |
| 5 | SDK token 增量记账 + context 缓存 | P1 | 🔥🔥 长会话不再线性变慢 | 0 | 待展开 |
| 6 | RPC payload 裁剪 + 缓存层 | P1 | 🔥🔥 打开会话/设置提速 | 0 | 待展开 |
| 7 | 长对话虚拟列表 | P1 | 🔥🔥 500+ 消息滚动 60fps | 2 | 待展开 |
| 8 | memory 召回异步 fs + ANN 索引 | P2 | 🔥 库大后召回不退化 | 4 | 待展开 |
| 9 | 启动期 + 日志热路径 | P2 | 🔥 冷启动 + 高频 RPC | 0 | 待展开 |
| 10 | 收尾清理（memo/key/去重） | P3 | 🟢 顺带优化 | — | 待展开 |

**建议执行顺序**：0 → 1 → 3 → 4 → 2 → 5 → 6 → 7 → 8 → 9 → 10。
（0 是所有优化的护栏；1/3/4 是三个互不依赖的 P0，可并行推进；2 依赖 1 同属前端但需更大重构；7 依赖 2 的引用稳定。）

---

## Phase 0：性能基准护栏（前置，跨子系统）

**Goal:** 在动手优化前，为每个热路径建立可回归的性能基准，避免"优化后无法证明、回归后无人察觉"。

**Files:**
- Create: `apps/web/src/perf/streaming-render.bench.ts`、`apps/web/src/perf/projection.bench.ts`
- Create: `apps/sidecar/src/perf/run-state-store.bench.ts`、`embedding.bench.ts`、`retrieval.bench.ts`、`tokens.bench.ts`
- Modify: 各 package.json 增加 `bench` 脚本；CI workflow 增加基准运行

**关键任务:**
- [ ] 前端：用 `performance.now()` 包裹"连续 1000 个 assistant.delta 事件 → setState → 投影 → stabilize"全链路，记录 P50/P95 帧时间。
- [ ] 后端：`run-state-store` 连续 append 500 item 的总耗时；`estimateTokens` 对 80-turn messages 的耗时；`embedTexts(100)` 的耗时；`searchMemoryV2` 在 N=100/1000/5000 记忆下的召回耗时。
- [ ] 把基准接入 CI，回归 > 20% 时 fail（软阈值先 warn）。

**验收标准:** `bun run bench` 可复现跑出基线数字，CI 有记录。

**风险:** 基准环境噪声 → 用固定数据集 + 多轮取中位数。

---

## Phase 1：前端流式渲染热路径（P0）✅ 已展开

**Goal:** 把"每个流式 token 触发一次全量 sort + setState + 6 组件 re-render"降到"每帧最多一次批量提交"，并消除 Markdown 每帧重解析。

**详见:** `2026-06-21-perf-fe-streaming.md`

**覆盖的审查问题:**
- `useGlobalAgentListeners.ts:82` 每 token 同步写 atom
- `runtime-event-state.ts:21,73` appendRuntimeEvent 每次全量 `[...events].sort()`
- `useSmoothStream.ts:162` 每帧 setDisplayedContent → XMarkdown 重解析

**验收标准:** 1000 token 连续输出期间，主线程单帧 < 16ms；`setRuntimeEvents` 调用次数 ≤ 60 次/秒（合并后）。

---

## Phase 2：前端状态投影增量 + 引用稳定（P0）

**Goal:** 把事件→消息的投影从"每 token 全量 replay"改为增量 reducer，让未变消息/块的引用稳定，从而移除 stabilize/memo 里的 `JSON.stringify` 比较。

**Files:**
- Modify: `apps/web/src/components/agent/runtime-event-message-projection.ts`（638 行，改增量 `applyEvent`）
- Modify: `apps/web/src/components/agent/agent-message-state.ts:326-378`（stabilize 退化或移除）
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx:45-55,92`（memo 改浅比较）
- Modify: `apps/web/src/atoms/agent-atoms.ts:12`（订阅粒度：atomFamily / selectAtom）

**关键任务:**
- [ ] 投影层引入"当前 assistant 消息"状态机：`assistant.delta` 只 patch 尾部消息的最后一个 block，其余消息引用不变。
- [ ] 为每条 message / block 计算 `revision`（内容变才递增），memo 比较改为标量 `revision` 比较。
- [ ] `stabilizeRuntimeMessages` 退化为"仅当引用变化时才更新 revision"，移除 `JSON.stringify(message)`。
- [ ] `RuntimeEventContentBlock` 的 `areRuntimeEventContentBlockPropsEqual` 改为 `prev.message === next.message` + revision。
- [ ] 拆分订阅粒度：`agentRuntimeEventsAtom` 用 `atomFamily` 按 threadId，避免线程 A 输出导致线程 B 组件 re-render。
- [ ] `reconcileUserMessageVersions`（agent-message-state.ts:58-113）的 5 次 filter + 嵌套 find 改为单次 reduce + Map。

**验收标准:** 1000 token 输出期间，`JSON.stringify` 调用次数为 0；投影复杂度从 O(事件数) 降到 O(1)（单事件增量）。

**依赖:** Phase 1（同属前端热路径，建议先做 1 的批量合并降低 baseline，再做 2 的重构）。

**风险:** 投影逻辑复杂（638 行 + 多种事件类型）→ 严格保留现有 test（runtime-event-message-projection.test.ts 706 行）作为护栏，重构用"全量投影 vs 增量投影"等价性测试。

---

## Phase 3：后端事件存储 append-only（P0）

**Goal:** 消除"每条事件/消息/span 触发整文件全量读改写"的 O(n²) 写放大，改为 append-only，解除流式吞吐瓶颈。

**Files:**
- Modify: `apps/sidecar/src/services/agent-runtime/runner/run-state-store.ts:101-106`（appendItem 改 append-only）
- Modify: `apps/sidecar/src/services/agent-runtime/trace/trace-store.ts:58-70`（appendSpan/updateSpan 改 append-only / 内存累积）
- Modify: `apps/sidecar/src/services/agent/agent-thread-manager.ts:353-369`（appendAgentTranscriptMessage 改 append-only，复用 :313 的 appendAgentThreadSDKMessages 模式）
- Modify: `apps/sidecar/src/services/memory-v2/markdown-store.ts:175-222,558-601`（updateEntryStatus/Relations/removeEntryReferences 改为按 id 定位 + 增量）

**关键任务:**
- [ ] `items.jsonl` / transcript 改为 `appendFileSync` 追加单行；读取侧流式解析或按需读取；`update` 只维护 `state.json` 元数据。
- [ ] trace 改 jsonl 追加，或运行期 span 纯内存累积、`finalize` 时一次性落盘。
- [ ] `findEntryById`（markdown-store.ts:558）改为 id→path 直接定位（建内存索引或文件名约定），删除"listEntries 全扫再 find"。
- [ ] `removeEntryReferences` 改为只对命中 related/supersedes 的 entry 操作，不再遍历全库重写。
- [ ] 所有新写路径用 `fs/promises` 异步，移除热路径上的 `writeFileSync`/`renameSync`。

**验收标准:** 连续 append 500 item 的总耗时从 O(n²) 降为线性且单次 O(1)；流式输出期间 sidecar 事件循环不被磁盘 IO 阻塞。

**依赖:** 无（与 Phase 1/4 互相独立）。

**风险:** append-only 后读取/压实（compaction）逻辑需重写 → 保留旧读路径兼容已有数据，灰度迁移；写测试覆盖"追加→读取→压实"闭环。

---

## Phase 4：本地 embedding 批量化 + 向量化（P0）

**Goal:** 把 N 条 embedding 从"N 次串行 forward + N 次 IPC"降为"1 次 batched forward"，向量存储与相似度计算用 typed array，消除库大后的线性退化。

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/local-embedding.ts:39-46`（embedTexts 批量）
- Modify: `apps/sidecar/src/services/memory-v2/local-embedding-worker.ts:26-53`（worker 协议加 embed_batch）
- Modify: `apps/sidecar/src/services/memory-v2/semantic-index.ts:9-21,46-53,88-117,156-171`（Float32Array + dotProduct + 索引二进制）
- Modify: `apps/sidecar/src/services/memory-v2/embedding.ts:117-123`（Google 路径并发或 batchEmbedContents）
- Refactor: `smart-add.ts:309-324` 与 `semantic-index.ts:156-171` 重复的 cosineSimilarity 抽共享 util

**关键任务:**
- [ ] worker 协议新增 `{ type: "embed_batch", texts: string[] }`，worker 内 `embedder(texts, { pooling:"mean", normalize:true })` 一次返回多向量。
- [ ] 主线程一次性 `postMessage` 一组、一次 `await` 收齐；向量用 `Float32Array` + transfer list（`ArrayBuffer`），删除 `Array.from(result.data)`。
- [ ] `semantic-index.ts` 向量字段改 `Float32Array`；因已归一化，相似度只算 `dotProduct`（省两次范数）；余弦循环用 typed array 索引。
- [ ] `vector-index.json` 改为二进制（`.bin` + 元数据 json），删除 `JSON.stringify(..., null, 2)` 的缩进写放大。
- [ ] Google embedding 路径改 `Promise.all` + 并发限流（p-limit 5）或 `batchEmbedContents`。
- [ ] 应用启动后台预热 ONNX 模型（`void ensureReady()`），超时改可重试 + 给前端发进度事件。

**验收标准:** 100 条 embedding < 1s（当前 3–8s）；N=1万 向量召回单次 < 50ms；模型首次使用无 15s 静默降级。

**依赖:** 无。

**风险:** 模型 batch 行为差异 → 用固定文本集对比 batch 与逐条的向量一致性测试；二进制索引需迁移旧 json（一次性脚本）。

---

## Phase 5：SDK token 增量记账 + context 缓存（P1）

**Goal:** 消除"每轮 LLM 调用前同步 native tokenize 全量历史"与"每轮全量 normalize/工具 schema 重建"。

**Files:**
- Modify: `packages/sdk/src/utils/tokens.ts:17-94`（增量记账 + 大块字符近似）
- Modify: `packages/sdk/src/engine.ts:469,496,550,710,729,1619`（缓存每条 message token 数）
- Modify: `packages/sdk/src/engine.ts:903-909`（normalize 只作用于新增尾部）
- Modify: `apps/sidecar/src/providers/sse-reader.ts:133,173`（`content += delta` 改 `chunks.push`）
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/run.ts:877-881,916-1024`（工具 schema token 缓存 + 插件装配缓存）

**关键任务:**
- [ ] token 记账：每条 message/block 首次出现时算一次并存 cache，会话级累加；compact 后失效重算受影响部分。
- [ ] `estimateTokens` 对 > 4KB 块直接用字符近似（length/4）跳过 native。
- [ ] 工具 schema 转换结果按 `(tool 引用, model)` 缓存（会话内基本不变）；`estimateToolSchemaTokens` 结果随工具集缓存。
- [ ] SSE 流式累积改 `string[]` + 末尾 `join("")`。
- [ ] 插件/MCP 装配按 `(cwd, workspaceSlug, 插件版本指纹)` 缓存，会话级复用。

**验收标准:** 80-turn 会话下每轮 LLM 调用前的 token 计算耗时不再随历史线性增长（趋近 O(新增块)）。

**依赖:** 无。

**风险:** 增量记账在 compact/编辑/重试场景需正确失效 → 用"全量 vs 增量"等价性测试覆盖这些边界。

---

## Phase 6：RPC payload 裁剪 + 缓存层（P1）

**Goal:** 打开长会话不再传输/拷贝整段 `sdkMessages`；读配置不再反触发写盘；skills/notes/threads 不再每次全量同步读盘。

**Files:**
- Modify: `apps/sidecar/src/rpc/agent-handlers.ts:585-588`（GET_THREAD_MESSAGES 裁剪）
- Modify: `apps/sidecar/src/services/agent/agent-message-versioning-service.ts:297`（裁剪视图 + sdkMessages 懒加载）
- Modify: `apps/sidecar/src/services/system/lume-config-service.ts:761-778`（读路径脏检查去写 + mtime 缓存）
- Modify: `apps/sidecar/src/services/agent/agent-workspace-manager.ts:492-522`（skills mtime 缓存）
- Modify: `apps/sidecar/src/services/reading/reading-store.ts:780`（notes mtime 缓存；标已读/+1 改单文件更新）
- Modify: `apps/sidecar/src/services/system/general-settings-service.ts:192`（settings mtime 缓存）
- Modify: `apps/desktop/src-tauri/src/main.rs:1187-1195,1101-1105`（Value take/swap 避免 clone；async channel 替代 spawn_blocking）

**关键任务:**
- [ ] GET_THREAD_MESSAGES 默认返回裁剪视图（标题/角色/正文/版本指针），`sdkMessages` 走单独懒加载 RPC；前端无限滚动。
- [ ] `readOrCreateLumeConfig` 成功分支只在"解析结构 ≠ 规范化结构"时才回写（脏检查）。
- [ ] skills/notes/threads/settings 统一引入"进程内缓存 + 文件 mtime 失效"（复用 workspace-watcher 的 fs.watch 基建）。
- [ ] reading 小操作（markSeen / plusOne）改为单文件更新，不调 `readAllNotes` 全量重建。
- [ ] Tauri 端响应用 `mem::take` 避免 `Value.cloned()`；RPC 等待改 `tokio::sync::oneshot`。

**验收标准:** 打开 80-turn 会话 < 200ms；进设置页不产生磁盘写；`GET_CAPABILITIES` / list-notes 命中缓存 < 5ms。

**依赖:** 无。

**风险:** 裁剪视图需前后端协同改契约 → 用 zod schema 守边界；缓存失效需覆盖外部改文件场景（fs.watch 兜底）。

---

## Phase 7：长对话虚拟列表（P1）

**Goal:** 长对话（数百条消息）不全量挂载 DOM，滚动保持 60fps。

**Files:**
- Modify: `apps/web/src/components/agent/AgentMessages.tsx:306-354`（引入 react-virtuoso 或基于已有 `use-stick-to-bottom`）
- Modify: `apps/web/src/components/agent/RuntimeEventContentBlock.tsx`（吸底/followOutput 下沉）

**关键任务:**
- [ ] 评估 `react-virtuoso`（动态高度 + 自动吸底，契合现有 ResizeObserver + shouldAutoScroll）。
- [ ] 把吸底逻辑下沉到虚拟列表的 `followOutput`。
- [ ] 处理流式时"最后一条消息高度动态增长"的虚拟化边界。

**验收标准:** 500 条消息滚动 60fps；切线程无整树重建卡顿。

**依赖:** Phase 2（引用稳定后虚拟化才不会因每 token 全量重建失效）。

**风险:** 动态高度虚拟化的测量成本 → 配合 Phase 1/2 降低单次渲染成本后收益才明显。

---

## Phase 8：memory 召回异步 fs + ANN 索引（P2）

**Goal:** 召回路径不再用同步 fs 阻塞主线程；库规模增大后召回不线性退化。

**Files:**
- Modify: `apps/sidecar/src/services/memory-v2/retrieval.ts:69-83,192,210,226,361`
- Modify: `apps/sidecar/src/services/memory-v2/markdown-store.ts:324-345,750-756`
- Modify: `apps/sidecar/src/services/memory-v2/semantic-index.ts:133`（candidateSignature 的 statSync）
- Create: 引入 `hnswlib-node`（按需，N > 2k 时）

**关键任务:**
- [ ] 召回路径 `readFileSync`/`statSync` 改 `fs/promises`。
- [ ] entries 进程内 LRU 缓存（按 mtimeMs 失效），避免每次召回重读。
- [ ] `candidateSignature` 改目录级 mtime 或一次 `readdir(withFileTypes)`。
- [ ] N > 2k 引入 `hnswlib-node` 或向量 PQ 量化；写"暴力扫描 → ANN"的等价性测试（top-k 召回率 > 阈值）。

**验收标准:** 召回期间 sidecar 事件循环不阻塞（流式 token 不卡顿）；N=1万 召回 < 50ms。

**依赖:** Phase 4（同 memory 域，typed array + dotProduct 是 ANN 的前置）。

---

## Phase 9：启动期 + 日志热路径（P2）

**Goal:** 冷启动提速；高频 RPC 的日志开销下降。

**Files:**
- Modify: `apps/sidecar/src/index.ts:3-35,109-135`（启动并行化 + 重依赖动态 import）
- Modify: `apps/sidecar/src/services/infra/logger.ts:156-178`（console 路径不走脱敏/stringify）

**关键任务:**
- [ ] `@xenova/transformers` 等重依赖改为首次用到时动态 `import()`。
- [ ] 启动期各服务（config/provider/mcp/skills/memory）并行化 `Promise.all`；`cleanupExpiredTrash` 延后到首个空闲 tick。
- [ ] `console.*` 重写仅写 stderr 原文行，不走 `redactDiagnosticLogData` + `JSON.stringify`（脱敏只给结构化 `createLogger` 用）。

**验收标准:** 冷启动到可交互时间下降；流式期间每秒日志 CPU 占用下降。

**依赖:** 无。

---

## Phase 10：收尾清理（P3）

**Goal:** 顺带消除中低优先级的重复计算与不稳定 key。

**Files:**
- Modify: `RuntimeEventContentBlock.tsx:1469-1479,763-770`（工具结果 `JSON.parse(output)` memo 化）
- Modify: `apps/web/src/components/agent/tool-result-renderers/default-result.tsx:4`（`JSON.stringify` 限长 + memo）
- Modify: `packages/ui/src/code-block/CodeBlock.tsx:175-203,260-268`（节流窗口前置 + 行 key 稳定化）
- Modify: `RuntimeEventContentBlock.tsx:609-638,1605`（MinimalProcessGroup / footer 单次 reduce + memo）
- Modify: `apps/sidecar/src/services/agent-runtime/runtime-core/attempt.ts:559`（canUseTool 先 size 检查再 stringify）

**关键任务:** 工具结果 parse memo 化；代码块行 key 改内容签名；footer 统计单次 reduce；canUseTool 摘要先截断再序列化。

**验收标准:** 无行为回归；流式渲染开销进一步下降。

---

## 全局策略

1. **每个 Phase 独立交付 + 独立可测**：按 superpowers 规范，每个 Phase 是一份完整子 plan，产出可工作、可测试的软件，可单独合并/回滚。
2. **TDD 护栏**：Phase 0 的基准 + 各域现有 test 作为回归护栏；重构类 Phase（2/3/5）用"旧实现 vs 新实现"等价性测试。
3. **频繁提交**：每个 bite-sized 步骤后 commit，便于二分定位回归。
4. **灰度与回滚**：存储格式变更（Phase 3/4）保留旧读路径兼容已有数据；高危改动（投影重构 Phase 2）feature flag 灰度。
5. **测量驱动**：每个 Phase 完成后用 Phase 0 基准量化收益，达不到预期收益的优化不合并。

---

## 下一步

- **Phase 1** 已展开为代码级 plan：`2026-06-21-perf-fe-streaming.md`，可立即执行。
- 其余 Phase 待按需展开。建议并行启动 **Phase 1（前端流式）+ Phase 3（后端存储）+ Phase 4（embedding）** 三个互不依赖的 P0。

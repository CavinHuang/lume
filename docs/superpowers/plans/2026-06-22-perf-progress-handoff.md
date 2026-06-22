# 性能优化：进展交接与剩余工作

> **截至 2026-06-22。换机器 / 新会话接续用。自包含——读此文档 + 路线图即可恢复全部上下文。**
>
> 路线图总览：`docs/superpowers/plans/2026-06-21-performance-optimization-roadmap.md`（Phase 0–10，六大反模式，每 Phase 含 Files/关键任务/验收/风险）。

## 一句话状态

性能优化路线图的 **Phase 1 / 2(全部子阶段) / 3a / 3b / 3d / 4 已完成**，**3c 已跳过**（核查为非生产热路径），**全局 Record atom 按 threadId 切片订阅已完成（5 个 atom，helper + 形状 A/B）**。**剩余 Phase 0 / 5 / 6 / 7 / 8 / 9 / 10**（storage atom + Tier-3 atom 按需）。全部工作在 `feat/new-ui` 分支（长期开发分支，**勿合并 main**——还有 Phase 5-10）。

## 分支与同步（换机器第一步）

- 分支：`feat/new-ui`，base `main`。
- **换机器后**：`git fetch && git checkout feat/new-ui && git pull`，确认拿到全部 Phase 4 commits。
- 若 `feat/new-ui` 尚未 push 到 upstream（原机器领先 10 commits），**必须先在原机器 `git push -u upstream feat/new-ui`**，否则新机器看不到 Phase 4 工作。

## 已完成 Phase 详情

| Phase | 子项 | 内容 | 验收 |
|-------|------|------|------|
| 1 | — | 前端流式 rAF 批量合并 + shouldFlush 门控 | 1000 token 单帧 <16ms |
| 2a | — | projection 抽 `applyRuntimeEvent` reducer | — |
| 2b | — | 增量 projection `applyRuntimeEventsIncremental` + `buildMessagesView`，消除每帧全量 replay | — |
| 2c | — | 引用稳定：`ReconcileCache` memoize + stabilize 退化引用比较 + memo 去 stringify | — |
| 2d | — | `agentRuntimeEventsFamily` = atomFamily(selectAtom) 按 threadId 切片订阅 | — |
| 2e | — | `reconcileUserMessageVersions` filter+find → Map 索引（O(M×V)→O(V+M×group)） | — |
| 3a | — | run-state-store `appendItem` append-only（~25x） | — |
| 3b | — | trace-store spans event-sourcing（-94%） | — |
| 3d | — | markdown-store `findEntryById` 文件名定位（-78%~93%） | — |
| **4** | — | **本地 ONNX embedding 批量化（embed_batch 一次 forward + transfer list，N 次 IPC→1 次）+ Float32Array/dotProduct + cosine util 抽取** | **100 条 embedding <1s；memory-v2 147 pass** |
| 全局 atom 切片 | — | 全局 Record atom 按 threadId 切片订阅：`createThreadSliceFamily` helper + 5 family（streamingStates/pendingInteractive/planModePhase/subagentRuns/runtimeStatus）；形状 A（6 处单线程下标读取换 family）+ 形状 B（LeftSidebar 去整对象读，ThreadItem 行级订阅）；顺手修 `LumeSidebar.test.tsx` 失效 import。 | helper 契约测试（Object.is 引用稳定性）+ ThreadItem TDD 测试；memory-v2 147/0、AgentMessages 30/0、agent 117/23/18、app-shell 21/1/0、projection 26/1、typecheck 0。 |

**跳过 Phase 3c**：agent-thread-manager transcript append-only——源码核查发现 `appendAgentTranscriptMessage` 仅在 `.test.ts` 调用，非生产热路径，审查报告误判。

## Phase 4（本轮）完成详情

**范围（核心 3 项）**：
1. 本地 ONNX batch embedding——worker 协议 `embed_batch`（多条文本一次 forward）+ 主线程按 chunk=32 分批 + transfer list 零拷贝。N 次 IPC → ⌈N/32⌉ 次。
2. 向量 `Float32Array` + `dotProduct`——`semantic-index` 召回路径，归一化向量省两次范数计算。
3. `cosineSimilarity` 抽共享 util（`vector-math.ts`）——`semantic-index` 与 `smart-add` 复用，删两份重复实现。

**关键决策**：接口 `MemoryV2EmbedTexts` 保持 `(texts)=>Promise<number[][]>` 不变（调用方/remote 零改动）｜worker 删旧 `embed` 单条协议（单条退化为 batch 特例）｜`dotProduct ≡ cosineSimilarity`（归一化，`0.92`/`0.25` 阈值零变化）｜零迁移（`vector-index.json` 磁盘格式不变，`INDEX_VERSION` 不升）。

**排除项（留待对应 Phase）**：二进制 `.bin` 索引（→ Phase 8 ANN 前置）｜模型启动预热（→ Phase 9 启动期）｜Google 远程并发（远程低频路径）。

**commits**（`feat/new-ui`）：
- `f15645f1` spec
- `d0afa297` plan
- `f3be8f2d` vector-math util
- `810f71d4` local-embedding 批量化
- `4ef3e348` semantic-index dotProduct + 单测
- `b6172d5b` smart-add dotProduct
- `5699a29f` batch 等价性集成测试

**文档**：spec `docs/superpowers/specs/2026-06-21-perf-be-embedding-batch-design.md`，plan `docs/superpowers/plans/2026-06-21-perf-be-embedding-batch.md`。

**待验证（换机器后可选）**：batch vs 逐条向量等价性集成测试 `embedding-batch-equiv.test.ts` 需真实 ONNX 模型，默认 skip。手动跑：`LUME_EMBEDDING_EQUIV_TEST=1 bun test apps/sidecar/src/services/memory-v2/embedding-batch-equiv.test.ts`（本地需已缓存 `Xenova/bge-small-zh-v1.5`）。

## test 基线（回归对比锚点）

| 测试范围 | 基线 | 命令 |
|----------|------|------|
| memory-v2（Phase 4 域） | **147 pass / 0 fail**（129 基线 + vector-math 7 + local-embedding 6 + semantic-index 5） | `bun test apps/sidecar/src/services/memory-v2/` |
| projection | 26 pass / 1 fail（pre-existing：compaction notice test 过时） | `bun test apps/web/src/components/agent/runtime-event-message-projection.test.ts` |
| AgentMessages | 30 pass / 0 fail（单独跑） | `bun test apps/web/src/components/agent/AgentMessages.test.ts` |
| agent 目录 | 117 pass / 23 fail / 18 errors（pre-existing：desktop-api 导出缺失） | `bun test apps/web/src/components/agent/` |
| app-shell | 21 pass / 1 fail / 0 error（pre-existing：LumeSidebar recycle-bin disabled 断言失效） | `bun test apps/web/src/components/app-shell/` |
| agent-atoms | 2 pass / 0 fail（helper 契约测试） | `bun test apps/web/src/atoms/agent-atoms.test.ts` |
| typecheck | exit 0 | `bun run --filter @lume/sidecar typecheck` |

> **零回归判定**：改动后重跑对应范围，pass/fail 数与基线一致（pre-existing fail 不算回归）。隔离对比标准手法：`git checkout HEAD~N -- <files>` 跑旧实现对比。

## 剩余工作（按优先级 + 依赖）

### 全局 Record atom：5 已完成，余按需（复用 Phase 2d 模式）

5 个高频全局 `Record` atom 已按 threadId 切片订阅（helper + family 见上表"全局 atom 切片"行）：`agentStreamingStatesAtom` / `agentPendingInteractiveAtom` / `agentPlanModePhaseAtom` / `agentSubagentRunsAtom` / `agentRuntimeStatusAtom`。消除"线程 A 输出 → 线程 B 侧栏/输入栏 re-render"主热路径。模式参考：`apps/web/src/atoms/agent-atoms.ts` 的 `createThreadSliceFamily` helper（`jotai/utils` 的 atomFamily(selectAtom)）。

**剩余可选 follow-up（按需，低频/低价值，YAGNI）**：
- Storage atom：`agentSidePanelViewAtom` / `agentFileTreeOpenAtom`（视图态，单线程本地 UI，跨线程 re-render 影响小）。
- Tier-3 atom：`agentMessageQueueAtom` / `agentErrorMessagesAtom` / `agentThreadPermissionModesAtom`（低频更新，队列/错误/权限）。

### Phase 5：SDK token 增量记账 + context 缓存（P1，无依赖）

消除"每轮 LLM 调用前同步 native tokenize 全量历史"+"每轮全量 normalize/工具 schema 重建"。

- Files：`packages/sdk/src/utils/tokens.ts:17-94`、`engine.ts:469,496,550,710,729,1619,903-909`、`apps/sidecar/src/providers/sse-reader.ts:133,173`、`apps/sidecar/src/services/agent-runtime/runtime-core/run.ts:877-881,916-1024`。
- 验收：80-turn 会话每轮 token 计算耗时不再随历史线性增长。
- 风险：增量记账在 compact/编辑/重试需正确失效——用"全量 vs 增量"等价性测试。

### Phase 6：RPC payload 裁剪 + 缓存层（P1，无依赖）

打开长会话不传输整段 `sdkMessages`；读配置不反触发写盘；skills/notes/threads 不每次全量读盘。

- Files：`apps/sidecar/src/rpc/agent-handlers.ts:585-588`、`agent-message-versioning-service.ts:297`、`lume-config-service.ts:761-778`、`agent-workspace-manager.ts:492-522`、`reading-store.ts:780`、`general-settings-service.ts:192`、`apps/desktop/src-tauri/src/main.rs:1187-1195,1101-1105`。
- 验收：打开 80-turn 会话 <200ms；进设置页无磁盘写。
- 风险：裁剪视图需前后端协同改契约——用 zod schema 守边界。

### Phase 7：长对话虚拟列表（P1，依赖 Phase 2 ✅）

数百条消息不全量挂载 DOM，滚动 60fps。

- Files：`apps/web/src/components/agent/AgentMessages.tsx:306-354`、`RuntimeEventContentBlock.tsx`。
- 方案：评估 `react-virtuoso`（动态高度 + followOutput 吸底），吸底逻辑下沉到 `followOutput`。
- 风险：动态高度虚拟化测量成本——配合 Phase 1/2 降低单次渲染成本后收益才明显。

### Phase 8：memory 召回异步 fs + ANN 索引（P2，依赖 Phase 4 ✅）

召回路径不用同步 fs 阻塞主线程；库规模增大后召回不线性退化。

- Files：`apps/sidecar/src/services/memory-v2/retrieval.ts:69-83,192,210,226,361`、`markdown-store.ts:324-345,750-756`、`semantic-index.ts:133`。
- 方案：`readFileSync`/`statSync` 改 `fs/promises`；entries 进程内 LRU 缓存（mtimeMs 失效）；N>2k 引入 `hnswlib-node` 或 PQ 量化。
- 验收：召回期间 sidecar 事件循环不阻塞；N=1万 召回 <50ms。
- **承接 Phase 4**：typed array + dotProduct 是 ANN 前置（已完成）。二进制 `.bin` 索引在此 Phase 做。

### Phase 9：启动期 + 日志热路径（P2，无依赖）

冷启动提速；高频 RPC 日志开销下降。**含 Phase 4 排除的模型启动预热**。

- Files：`apps/sidecar/src/index.ts:3-35,109-135`、`services/infra/logger.ts:156-178`。
- 方案：`@xenova/transformers` 重依赖改首次用到时动态 `import()`；启动期服务并行 `Promise.all`；console 路径不走脱敏/stringify。
- 模型预热：应用启动后台 `void ensureReady()` 预热 ONNX，超时可重试 + 前端进度事件（消除首次 15s 静默降级）。

### Phase 10：收尾清理（P3）

顺带消除中低优先级重复计算与不稳定 key。

- Files：`RuntimeEventContentBlock.tsx:1469-1479,763-770,609-638,1605`、`packages/ui/src/code-block/CodeBlock.tsx:175-203,260-268`、`default-result.tsx:4`、`attempt.ts:559`。

### Phase 0：性能基准护栏（前置，可选，未做）

为每个热路径建立可回归基准。Files：`apps/web/src/perf/*.bench.ts`、`apps/sidecar/src/perf/*.bench.ts`。参考 `markdown-store.bench.ts` 模式。

## 工作流（每个 Phase 严格执行）

```
brainstorming（superpowers:brainstorming）
  → spec（docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md）
  → plan（docs/superpowers/plans/YYYY-MM-DD-<topic>.md，writing-plans，TDD bite-sized）
  → executing-plans（inline，每 Task TDD：写失败 test → 实现 → 跑绿 → commit）
  → finishing-a-development-branch（保持 feat/new-ui）
```

- 范围决策：brainstorming 阶段用 AskUserQuestion 划范围（核心 vs 全套），倾向 YAGNI / Simplicity First / Surgical Changes（见项目 `CLAUDE.md`）。
- TDD：重构类用"旧实现 vs 新实现"等价性测试守护（Phase 4 的 `dotProduct ≡ cosine` 即此模式）。
- 频繁提交：每 bite-sized 步骤后 commit。

## test 常用命令

```bash
# 改动域（最快反馈）
bun test apps/sidecar/src/services/memory-v2/          # 后端 memory
bun test apps/web/src/components/agent/                 # 前端 agent
# 单文件
bun test apps/sidecar/src/services/memory-v2/<file>.test.ts
# typecheck
bun run --filter @lume/sidecar typecheck
bun run --filter @lume/web typecheck
```

## 坑（已知 pre-existing，勿误判为新回归）

- **projection 1 fail**：`keeps context compaction start and completion visible as a status timeline`——production 有意合并 start/progress/completed 为单条 notice，test 过时。护栏：保持 26/1。
- **agent 目录 23 fail / 18 errors**：全为 desktop-api 导出缺失（`saveFilePathDialog`/`submitTaskApproval`/`executeTaskContract` not found in desktop-api/index.ts）+ overlay frame language。护栏：117/23/18。
- **AgentMessages 计数差异**：单独跑 30/0，但在 agent 目录跑因 RuntimeEventContentBlock 间接依赖 desktop-api 计数不同——验证 AgentMessages 用单独跑。
- **app-shell 1 fail**：`LumeSidebar.test.tsx` 的 `disables recycle bin` 用例断言 `recycleBinButton.props.disabled === true`，但组件/视图模型从未实现 recycle-bin 禁用逻辑（Task 5 修好该文件 import 后此断言才暴露）。护栏：保持 21/1/0。修复需产品决策（回收站是否应在某状态下禁用）。
- **transformers.js batch 风险**：Phase 4 依赖 `@xenova/transformers@^2.17.2` pipeline 接受 `string[]`（由 `mean_pooling` 类型注释 `[batchSize, embedDim]` 支撑）。纯逻辑由 `sliceFlatVectors` 单测守护；真实 batch 行为由 `embedding-batch-equiv.test.ts`（需模型）兜底，尚未真实验证。

## 已知技术债（未来迁移）

- **jotai `atomFamily` 弃用**：`jotai/utils` 的 `atomFamily` 标记 deprecated，jotai v3 将移除。本轮 `createThreadSliceFamily` helper + Phase 2d 的 `agentRuntimeEventsFamily` 共 **2 处** source 调用点（5 个新 family 都经 helper，迁移面很小）。**但官方迁移目标 `jotai-family` 尚未正式发布可用版本**——npm 上 `jotai-family@0.0.0` 是 51 B 占位包（无 README、0 下载、0 依赖），真实代码仅在 [github.com/jotaijs/jotai-family](https://github.com/jotaijs/jotai-family)（API 与 `atomFamily(initializeAtom, areEqual)` 完全一致，MIT，4 个 git tag 但 npm publish 为 0）。结论：**暂不迁移**——git URL 依赖不可固定、供应链风险。等官方发布真实 npm 版本或 jotai v3 落地再迁（届时 helper 单点改 import + Phase 2d 一行）。弃用 warning 为 cosmetic，不影响功能；test 输出会刷屏，勿误判为新问题。

## 接续提示词（换机器后粘贴到新会话）

```
继续 Lume 性能优化。先读 docs/superpowers/plans/2026-06-22-perf-progress-handoff.md 恢复进展上下文（Phase 1/2/3(a,b,d)/4 已完成，3c 跳过；全局 atom 按 threadId 切片订阅已完成 5 atom；剩余 Phase 5-10，全在 feat/new-ui 分支）。下一步从 Phase 5（SDK token 增量记账 + context 缓存）开始——按 superpowers brainstorming → spec → plan → executing-plans 流程推进，范围决策倾向核心子集（YAGNI）。开始前先跑 memory-v2 基线确认 147 pass。
```
